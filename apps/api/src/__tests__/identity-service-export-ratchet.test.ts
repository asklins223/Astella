import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P1-7：`identity/service.ts` 的导出数**只能减不能增**。
 *
 * ## 为什么是棘轮而不是一次拆完
 *
 * 审计的结论是"`identity/service.ts` 1580 行 / 29 导出 / 6 关注点，
 * 拆出 session / workspace-membership / ai-consent / workspace-lifecycle 四个服务"。
 * 本次先立了四个**具名门面**（`session-service.ts` 等），把"这段属于哪一族"
 * 写进 import 语句；函数体还在 `service.ts` 里。
 *
 * 没一次搬完的原因不是"不敢"，是**代价不对称**：全仓 53 处 import 那个文件，
 * 而工作区里同时有并发的在途重构。一次动 53 个调用方、且无法在本轮
 * 完整验证，是把可回滚的小步变成不可回滚的一大步。
 *
 * 有了这四个门面之后，搬函数体就是安全的：把一族移进对应文件、
 * `service.ts` 改成从这里 re-export，**调用方一行都不用改**。
 *
 * ## 这条棘轮防的是什么
 *
 * 防「新功能继续往 `service.ts` 里塞」。拆分的难点从来不是搬走已有的，
 * 是**搬的过程中又长出新的**——那时基线会悄悄变大，几轮之后就白拆了。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const SERVICE = join(API_ROOT, "modules", "identity", "service.ts");

/**
 * 棘轮基线。**只能往下调，且每次下调都要对应一次真实的搬迁。**
 *
 *   28 → 2026-09-29 立完四个门面时的实测值
 *   23 → 同日把 AI 授权与审计那一族（5 个函数 + 1 个私有 helper）真的搬进
 *        `ai-consent-service.ts` 之后的实测值
 *   20 → 再把**凭证原语**搬进 `credentials.ts`（邮箱规范化 / 密码哈希 / 令牌生成 /
 *        会话过期常量 / `SessionContext`）。这一族是其余三族共享的地基，
 *        先搬它 session 那一族后面才不会反复来回导。
 *   15 → 同日把**会话族主体**（issueSession / loginWithPassword / decodeToken /
 *        revokeSession / cleanupExpiredSessions）搬进 `session-service.ts`。
 *   13 → 再把会话族最后两块（changePassword / revokeAllSessionsForUser）也搬完。
 *        **会话族至此全部搬空。**
 *    7 → 同日把**成员关系族**（12 个声明：6 函数 + 5 错误类/错误码 + 1 容量常量）
 *        搬进 `workspace-membership-service.ts`。
 *    0 → 再把**空间生命周期族**（11 个声明）搬进 `workspace-lifecycle-service.ts`。
 *        **`service.ts` 至此一个函数都不剩**，只剩转出与 `WorkspaceInfo` 这一个 DTO。
 *
 * 搬一块就降一次。**四族已全部搬空**（28 → 23 → 20 → 15 → 13 → 7 → 0）；
 * 从这里起基线是 0，本文件不许再出现任何函数定义。
 */
const CURRENT_EXPORTS = 0;

const FACADES = [
  "session-service.ts",
  "workspace-membership-service.ts",
  "ai-consent-service.ts",
  "workspace-lifecycle-service.ts",
] as const;

/** 四个门面各自应当拥有的那一族（用于防"门面漏转"与"转错地方"）。 */
const FACADE_OWNERS: Readonly<Record<(typeof FACADES)[number], readonly string[]>> = {
  "session-service.ts": ["decodeToken", "issueSession", "loginWithPassword", "revokeSession"],
  "workspace-membership-service.ts": ["listUserWorkspaces", "switchWorkspace", "leaveWorkspace"],
  "ai-consent-service.ts": ["updateAIConsent", "getAIPrivacySettings", "logAICall"],
  "workspace-lifecycle-service.ts": ["registerWithoutInvite", "createCollaborativeWorkspace", "dissolveWorkspace"],
};

/**
 * 本模块顶层的**服务函数**——棘轮基线用的就是这一类。
 *
 * 单独拆出来，是因为 `28 → 23 → 20 → 15 → 13` 这一串基线全是**函数**数；
 * 把 class / const 也算进来，历史基线就没法比了。
 */
function functionNames(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);
}

/**
 * 本模块顶层**声明**的名字（函数 + class + const）。
 *
 * 用于「门面转出的名字是不是真的存在」那条：这一族里除服务函数外，还有跟着它们走的
 * 错误类（`JoinWorkspaceError` 之类）与容量常量。只认 function 的话，
 * 门面转出错误类就会被误判成「指向了一个不存在的导出」。
 */
function exportNames(source: string): string[] {
  return [
    ...functionNames(source),
    ...[...source.matchAll(/^export class (\w+)/gm)].map((m) => m[1]!),
    ...[...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!),
    // `export type X = ...` 也是门面会转出的东西（那几个错误码就是这种形状）
    ...[...source.matchAll(/^export type (\w+)/gm)].map((m) => m[1]!),
  ];
}

test("service.ts 的导出数不增（棘轮）", () => {
  const source = readFileSync(SERVICE, "utf8");
  const actual = functionNames(source).length;
  assert.ok(
    actual <= CURRENT_EXPORTS,
    `service.ts 的导出从 ${CURRENT_EXPORTS} 涨到了 ${actual}。`
    + "新东西不要再往这里塞——按关注点放进对应的 "
    + FACADES.join(" / ") + "。",
  );
});

test("四族都搬空了：函数体只住在那四个文件里，service.ts 一个都不留", () => {
  // 基线是 0 之后，这条比"不增"更强：不是"别再涨"，是"一个都不许有"。
  // 拆完之后最容易被自己破坏的正是这一点——新需求来了，顺手在 service.ts 里
  // 写个函数，导入它的人当然不会注意到这违反了当初拆分的理由。
  const source = readFileSync(SERVICE, "utf8");
  const names = functionNames(source);
  assert.deepEqual(names, [],
    "service.ts 里又出现了函数定义：" + names.join(", ")
    + "——四族已经拆开，实现应该住在对应的服务文件里");

  // 四个文件各自都要真的**持有**它那一族（不能只是空门面）
  for (const facade of FACADES) {
    const text = readFileSync(join(API_ROOT, "modules", "identity", facade), "utf8");
    const held = functionNames(text).length;
    assert.ok(held > 0,
      facade + " 一个函数都没有——它是空门面，调用方 import 到的仍然是 service.ts 的转出，"
      + "这不算拆分");
  }
});

test("【自证】搬空判据真的会红：往 service.ts 塞一个函数必须被抓", () => {
  const polluted = readFileSync(SERVICE, "utf8")
    + "\nexport async function __leak(): Promise<void> {}\n";
  assert.notDeepEqual(functionNames(polluted), [],
    "自证样本没造好——加一个函数后必须出现名字");
  const real = functionNames(readFileSync(SERVICE, "utf8"));
  assert.deepEqual(real, [], "自证不该改动磁盘上的文件");
});

test("四个门面都存在，且各自**要么**转出、**要么**已经持有那一族", () => {
  for (const facade of FACADES) {
    const source = readFileSync(join(API_ROOT, "modules", "identity", facade), "utf8");
    for (const name of FACADE_OWNERS[facade]) {
      const reExported = new RegExp(`export\\s*\\{\\s*${name}\\s*\\}\\s*from`).test(source);
      // 已搬完的一族：函数体就在这个文件里，是 `export async function` / `export function`
      const definedHere = new RegExp(`export (?:async )?function ${name}\\b`).test(source);
      assert.ok(
        reExported || definedHere,
        `${facade} 既没有转出 ${name}，也没有持有它——这一族在 import 上就看不出归属了`,
      );
    }
  }
});

test("已搬完的族：service.ts 只做转出，函数体不在那里了", () => {
  const service = readFileSync(SERVICE, "utf8");
  // ai-consent 那一族是第一个真搬的：service.ts 只能有 re-export，不能再有函数体。
  // 这条判据的价值在于：搬完之后若有人把函数体又粘回 service.ts（"这样少改点"），
  // 上面那条"只能减不能增"不会红（转出和定义都算导出），但这条会。
  for (const name of FACADE_OWNERS["ai-consent-service.ts"]) {
    assert.equal(
      new RegExp(`export (?:async )?function ${name}\\b`).test(service),
      false,
      `${name} 的函数体又回到 service.ts 里了——已搬走的族不要搬回来`,
    );
    assert.ok(
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"\\./ai-consent-service\\.ts"`).test(service)
      || new RegExp(`from "\\./ai-consent-service\\.ts"`).test(service),
      `service.ts 应当从 ./ai-consent-service.ts 转出 ${name}`,
    );
  }
});

test("门面转出的名字在 service.ts 里确实存在（防门面指向不存在的导出）", () => {
  // 认两种形态：service.ts 从门面 re-export（`export { x } from`），
  // 以及 service.ts 自己定义（`export function x` / `export async function x`）。
  // 只认前一种的话，搬完一族之后剩下的门面会被误判成"指向了不存在的导出"。
  const serviceSource = readFileSync(SERVICE, "utf8");
  const defined = new Set(exportNames(serviceSource));
  const reExported = new Set(
    [...serviceSource.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
      .flatMap((m) => m[1]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!).filter(Boolean)),
  );
  for (const facade of FACADES) {
    const source = readFileSync(join(API_ROOT, "modules", "identity", facade), "utf8");
    for (const m of source.matchAll(/export\s*(?:type\s*)?\{\s*(\w+)\s*\}/g)) {
      const name = m[1]!;
      assert.ok(defined.has(name) || reExported.has(name),
        facade + " 转出了 " + name + "，但 service.ts 既没有定义它也没有从别处转出它"
        + "——门面指向了一个不存在的导出");
    }
  }
});

test("【自证】棘轮真的会红：加一个导出后计数必须越过基线", () => {
  const real = readFileSync(SERVICE, "utf8");
  const realCount = functionNames(real).length;
  assert.ok(realCount <= CURRENT_EXPORTS,
    `真实计数 ${realCount} 已经越过基线 ${CURRENT_EXPORTS}——棘轮此刻就该红`);
  // 模拟"又多塞了一个"：造一份多一个导出的源码
  const inflated = real + "\nexport function __ratchetProbe(): void {}\n";
  assert.ok(
    functionNames(inflated).length > CURRENT_EXPORTS,
    "自证样本没造好——多一个导出后计数必须超过棘轮基线，"
    + "否则上面那条断言在真实搬迁后会因为基线失准而变成空跑",
  );
  assert.equal(functionNames(real).length, realCount, "自证不该改动磁盘上的文件");
});
