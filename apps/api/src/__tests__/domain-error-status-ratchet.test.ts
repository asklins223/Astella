import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-6：**带 `statusCode` 的错误类必须被 `asDomainError` 认得出来。**
 *
 * ## 审计说的和实测的
 *
 * 审计写"44/78 个错误类绕过 `DomainError`，存在『漏一个 statusCode 映射就变 500』
 * 的系统性风险"。实测：`apps/api/src` 里 `export class *Error` 共 **36** 个，
 * 其中 **10** 个不继承 `DomainError`。
 *
 * 但那 10 个里只有 **1** 个真的有问题：
 *   · 8 个**根本没有 `statusCode`** —— 它们本就该是 500 的内部错，
 *     给它们套上 `DomainError` 反而会凭空造出一个"带 code 的领域错"；
 *   · 1 个继承自己的内部基类（`CardGenerationPipelineErrorV2`），那是有意的层级；
 *   · 1 个（`ReviewQueueProjectionError`）**带 `statusCode = 409` 却不继承**
 *     `DomainError` —— 那就是这条要防的那一个。
 *
 * ## 风险到底在哪
 *
 * `lib/error-envelope.ts` 的 `asDomainError` 只认 `DomainError` 及其子类。
 * 一个带 `statusCode` 却不被认出来的错误类，它那两个字段就是**装饰**——
 * 真正把状态码送出去的是某个调用方里的 `catch (error) { if (error instanceof X) }`。
 * 换一个端点抛同一个错、忘了那段 catch，就退化成 500，**而且不报错、不留痕**。
 *
 * 所以判据不是"都继承 `DomainError`"，而是
 * **"带 `statusCode` 就必须走 `DomainError` 那条路"**——按后者写才既治了病，
 * 又不会把 8 个本来正确的内部错改坏。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

type Finding = { file: string; cls: string; base: string };

function collect(root: string = API_ROOT): Finding[] {
  const found: Finding[] = [];
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /export class (\w*Error)\s+extends\s+([\w.]+)\s*\{([\s\S]*?)\n\}/g,
    )) {
      const [, cls, base, body] = m;
      // 判据落在"类体里自己挂了 statusCode"上
      if (/\bstatusCode\b/.test(body)) found.push({ file, cls: cls!, base: base! });
    }
  }
  return found;
}

const OFFENDING: Readonly<Record<string, readonly string[]>> = {
  // 带 statusCode 的错误类走的是自己的内部基类，且那个基类**本身**要么继承
  // DomainError、要么由信封显式特判。列在这里是**有意的**，不是漏网。
  "modules/card-generation-v2/helpers.ts": ["CardGenerationV2ServiceError"],
};

test("带 statusCode 的错误类都被 asDomainError 认得出来", () => {
  const offenders: string[] = [];
  for (const { file, cls, base } of collect()) {
    const rel = file.replace(`${API_ROOT}`, "");
    // 已经是 DomainError 的没问题
    if (base === "DomainError") continue;
    if ((OFFENDING[rel] ?? []).includes(cls)) continue;
    offenders.push(`${rel}: ${cls} extends ${base}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "这些错误类自己挂了 statusCode，却不被 lib/error-envelope.ts 的 asDomainError 认出来"
    + "（那两行字段就成了装饰，真正发状态码的是某个调用方里的 instanceof 分支）。\n"
    + "换一个端点抛同一个错、忘了那段 catch，就会退化成 500 且不留痕。\n"
    + "修法：继承 DomainError。若确实该走自己的内部基类，把类名登记到本文件顶部的"
    + " OFFENDING 表里并写明理由——别只是把它从检查里删掉。\n"
    + offenders.join("\n"),
  );
});

test("OFFENDING 表里登记的类确实还在，且理由不是空的", () => {
  // 防止有人往表里塞名字、然后把那个类删掉或改掉——表会变成陈年旧账。
  const present = new Set(collect().map((f) => `${f.file.replace(`${API_ROOT}`, "")}:${f.cls}`));
  for (const [file, names] of Object.entries(OFFENDING)) {
    for (const name of names) {
      assert.ok(
        present.has(`${file}:${name}`),
        `OFFENDING 表里的 ${file}:${name} 已经不存在了（被删掉或改了基类）——`
        + "请把这条登记一并清掉，别让表变成陈年旧账",
      );
    }
  }
});

test("【自证】判据真的会红：真落一个带 statusCode 又绕过 DomainError 的类", () => {
  // 走**与上面完全相同**的 collect() 路径（落到临时目录再扫），
  // 而不是在这里另写一份正则——另写一份就可能与判据悄悄跑偏，
  // 自证变成"验证了另一个东西"。
  const dir = mkdtempSync(join(tmpdir(), "domain-error-probe-"));
  try {
    writeFileSync(join(dir, "probe.ts"), `
export class __ProbeError extends Error {
  readonly code = "x" as const;
  readonly statusCode = 418 as const;
  constructor(message: string) { super(message); this.name = "__ProbeError"; }
}
`, "utf8");
    const found = collect(dir).filter((f) => f.cls === "__ProbeError");
    assert.equal(found.length, 1,
      "自证样本没造好：collect() 应当认得出这个类，实际认出 " + found.length + " 个");
    assert.equal(found[0]!.base, "Error");
    // 关键：它必须**不在**豁免表里——否则上面第一条就是空跑
    const rel = found[0]!.file.replace(`${dir}/`, "");
    assert.equal(
      (OFFENDING[rel] ?? []).includes("__ProbeError"),
      false,
      "自证样本竟然落在豁免表里——那第一条检查对它根本不会报",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── code → status 映射表（P2 的「code→status 映射表」那一项）───────────────── */

/**
 * 每个 `DomainError` 子类都必须**显式**给出 statusCode。
 *
 * `DomainError` 构造函数的 `statusCode` 默认是 500。于是"忘了写"不会编译失败、
 * 不会测试失败，只会让一个本该是 400 的错误**静悄悄变成 500**——请求照样返回，
 * 只不过换了个语义。这正是审计说的"漏一个 statusCode 映射就变 500"。
 *
 * 允许两种写法：
 *   · 字面量：`statusCode: 409`
 *   · 透传：构造函数收一个 `statusCode: number` 形参再传给 super
 *     （CompanionAuditError 等 8 个是这一类）
 * 两种都算数；**只有"完全没有"这一种**要被挡住。
 */
test("每个 DomainError 子类都显式给了 statusCode（否则静默变 500）", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of walk(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /class (\w*Error)\s+extends\s+DomainError\s*\{([\s\S]*?)\n\}/g,
    )) {
      const [, cls, body] = m;
      checked += 1;
      // 判据落在**传给 super 的那个对象字面量**上，而不是"类体里出现过 statusCode"：
      //   EdgeTtsError   → statusCode: status     （形参，可以是 undefined）
      //   RecallRevealError → statusCode: status  （形参带默认值 400）
      //   …Error(409)     → statusCode: 409        （字面量）
      // 三种都算数；只有 super 里**压根没传**这一种会静默取 500。
      //
      // 第一版写成"类体里出现过 statusCode 就算"，那更弱——一句注释就能骗过它。
      const superCall = body.match(/super\(\{([\s\S]*?)\}\)/);
      if (!superCall || !/\bstatusCode\b/.test(superCall[1]!)) {
        offenders.push(`${file.replace(API_ROOT, "")}: ${cls}`);
      }
    }
  }
  assert.ok(checked > 0, "自证：判据必须至少认出一个 DomainError 子类，否则它在空跑");
  assert.deepEqual(
    offenders,
    [],
    "这些 DomainError 子类没有给出 statusCode，会静默取默认的 500：\n" + offenders.join("\n"),
  );
});

/**
 * 映射表快照：现有各类按 statusCode 的分布。
 *
 * 这不是要"优化"分布，而是让漂移**看得见**：多一个 500、少一个 409，
 * 都意味着某个错误被改成了另一种语义，而这类改动在 review 里很容易滑过去。
 *
 * 基线是 2026-09-29 的实测值。**只允许往下走**（把某个类从"静默 500"改成显式状态
 * 会减少未分类数）；新增错误类时同步更新这里的数字并说明理由。
 */
const STATUS_INVENTORY = {
  "500": 8,        // 内部/上游错误
  "400": 4,
  "409": 3,
  "404": 2,
  "502": 1,
  "503": 1,
  "透传（形参）": 8,
} as const;

test("code→status 分布没有漂移（快照 ratchet）", () => {
  const counts: Record<string, number> = {};
  let checked = 0;
  for (const file of walk(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /class (\w*Error)\s+extends\s+DomainError\s*\{([\s\S]*?)\n\}/g,
    )) {
      const body = m[2]!;
      checked += 1;
      const superCall = body.match(/super\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
      const literal = superCall.match(/statusCode:\s*(\d+)/);
      if (literal) counts[literal[1]!] = (counts[literal[1]!] ?? 0) + 1;
      else counts["透传（形参）"] = (counts["透传（形参）"] ?? 0) + 1;
    }
  }
  assert.equal(checked, 27,
    `DomainError 子类数从 27 变成了 ${checked}——增删了错误类。`
    + "这是好事，但要同步更新 STATUS_INVENTORY 并写明为什么。");
  assert.deepEqual(counts, STATUS_INVENTORY,
    "各 statusCode 的类数变了。常见原因是某个错误被改成了另一种语义，"
    + "而这种改动在 review 里很容易滑过去。");
});
