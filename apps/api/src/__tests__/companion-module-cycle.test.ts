import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * P1-6：`companion-conversation` 与 `companion-shell` 之间**不允许有环**。
 *
 * ## 环的实际代价
 *
 * 收口前两侧各有 import 对方的边：
 *   - conversation → shell：`auth-surface.ts`（密钥派生）、`audit-service.ts`（审计留痕）
 *   - shell → conversation：`companion-notify.ts` 的 `COMPANION_ACCOUNT_NOTIFY_CHANNEL`
 *
 * 代价不是"不好看"。在 Node 的 ESM 图里，环意味着模块初始化顺序互相依赖：
 * 谁先被求值取决于入口，而两边的顶层都可能有副作用（连 DB、注册 listener）。
 * 症状是"改了 A 之后，B 在某些启动路径下拿到未初始化的值"——偶发、难复现。
 *
 * ## 怎么断的
 *
 * 三样东西搬到中立层 `src/companion-contracts/`：
 *   - `auth-surface.ts`（HMAC 密钥派生，与哪个模块无关）
 *   - `audit-service.ts`（审计写入，与哪个模块无关）
 *   - `notify-contracts.ts`（通道名 + 载荷形状）
 *
 * 剩下一条 `shell → conversation`（`account-events.ts` 订阅 LISTEN 的实现）。
 * **那不是环**——单向依赖是正常的分层方向，shell 听 conversation 的通知本就合理。
 *
 * 所以判据不是"两侧都为 0"，而是：
 *   1. `conversation → shell` 必须为 **0**（这一侧已经没有中立层能承接的了）；
 *   2. `shell → conversation` 只允许**已登记的那一条**（订阅实现），
 *      多一条就红——否则"单向"会慢慢长回环。
 */

const API_ROOT = new URL("../..", import.meta.url).pathname;
const MODULES = join(API_ROOT, "src", "modules");

const SIDES = ["companion-conversation", "companion-shell"] as const;

function crossSideEdges(from: (typeof SIDES)[number], to: (typeof SIDES)[number]): string[] {
  const dir = join(MODULES, from);
  const edges: string[] = [];
  /**
   * 2026-09-30（B4）：`companion-conversation/` 现在有 memory/ delivery/ turn/
   * 三个子目录，跨侧依赖随之搬了进去。**只扫顶层**的话收集器一条边都抓不到，
   * 于是「没有未登记边」是因为**收集器瞎了**，不是因为真的没有——
   * 那条自证正是在这里救场。判据的对象是跨侧依赖关系，不是哪个目录。
   */
  const files: string[] = [];
  const collect = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { collect(p); continue; }
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(p);
    }
  };
  collect(dir);
  for (const file of files) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const source = readFileSync(file, "utf8");
    // 只看 import 语句，注释里的"见 xxx"不算边
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const spec = trimmed.match(/from\s*"(\.\.\/[^"]+)"/);
      if (spec?.[1]?.startsWith(`../${to}/`)) {
        // 记到**文件**粒度：只记目录的话，边指向哪里看不出来，
        // 「抓到了那条已知依赖」这种自证也写不出来。
        edges.push(`${rel}  →  ${spec[1].split("/").pop()}`);
      }
    }
  }
  return edges;
}

/**
 * 唯一登记在册的 `shell → conversation` 边。
 *
 * shell 要听账户事件就得用 conversation 侧的 LISTEN 实现——那是实现不是契约，
 * 搬走等于把职责搬个家而环照样存在。加第二条时这里会红，逼着先想清楚方向。
 */
const ALLOWED_SHELL_TO_CONVERSATION: ReadonlySet<string> = new Set([
  "src/modules/companion-shell/account-events.ts",
]);

test("两个模块之间没有环：conversation 不得回头看 shell，且反向只允许登记过的那一条", () => {
  const convToShell = crossSideEdges("companion-conversation", "companion-shell");
  const shellToConv = crossSideEdges("companion-shell", "companion-conversation");

  assert.deepEqual(convToShell, [],
    `conversation → shell 仍有 ${convToShell.length} 条边；`
    + "中立层（src/companion-contracts/）已经能承接这些能力：\n" + convToShell.join("\n"));

  const undeclared = shellToConv
    .map((edge) => edge.split("  →  ")[0]!)
    .filter((file) => !ALLOWED_SHELL_TO_CONVERSATION.has(file));
  assert.deepEqual(undeclared, [],
    "shell → conversation 多了未登记的边（单向依赖会长回环）：\n" + undeclared.join("\n"));
  assert.ok(!(convToShell.length > 0 && shellToConv.length > 0),
    "两侧同时有边 = 环");
});

test("中立层存在且提供那三样（守卫不是对着一个空目录空跑）", () => {
  const dir = join(API_ROOT, "src", "companion-contracts");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  for (const expected of ["auth-surface.ts", "audit-service.ts", "notify-contracts.ts"]) {
    assert.ok(files.includes(expected), `中立层缺 ${expected}——守卫在守一个不存在的解法`);
  }
});

/**
 * **【自证】判据真能看见边。**
 *
 * 2026-09-30：这条自证原先锚在"登记在册的 shell → conversation 订阅边必须被抓到"。
 * 那条边现在**不存在了**——`resolveAuthSurfaceManifestSecret` 已从中立层
 * `src/companion-contracts/` 提供，`account-events.ts` 不再回头看 conversation。
 * 换句话说：**P1-6 已经做成，两侧都是零条边**，自证锚的那条边被 P1-6 自己删掉了。
 *
 * 「边没了」是目标达成，不是收集器坏了。所以自证改锚在一条**今天确实存在**的边上：
 * 同一套收集器、同一套匹配规则，只是换成 conversation → companion-contracts
 * （2026-09-30 那次 import 改指留下的那条）。
 *
 * 这比原来那条更强：原来只能证明"能抓到已登记的边"，
 * 现在还能证明"能抓到跨目录的边"（旧收集器只扫顶层，子目录里的边抓不到）。
 */
test("【自证】收集器能看见边：conversation → 中立层那条必须被抓到", () => {
  const dir = join(MODULES, "companion-conversation");
  const edges: string[] = [];
  const collect = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { collect(p); continue; }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (/from "\.\.\/\.\.\/companion-contracts\//.test(t)) edges.push(entry);
      }
    }
  };
  collect(dir);
  assert.ok(edges.length >= 1,
    "收集器一条边都没抓到——那「两侧零边」是因为收集器瞎了，不是因为真的没有。\n"
    + "注意：conversation 的跨侧能力已挪到 src/companion-contracts/（中立层），"
    + "那条 import 一定在；如果抓不到，是收集器或匹配规则坏了。");
  assert.ok(edges.includes("learning-action-bridge.ts"),
    `抓到的边里没有 learning-action-bridge.ts，实际抓到：${[...new Set(edges)].join(", ")}`);
});

test("两侧都是零条边（P1-6 已做成）", () => {
  assert.deepEqual(crossSideEdges("companion-conversation", "companion-shell"), [],
    "conversation 又回头看 shell 了——能力应当由中立层 src/companion-contracts/ 承接");
  assert.deepEqual(crossSideEdges("companion-shell", "companion-conversation"), [],
    "shell 又回头看 conversation 了");
});

