/**
 * 40b §6.2 层边界守卫：**公共运行层 ↔ 伴星领域层**的归属判据。
 *
 * ## 它守的是什么
 *
 * 40b §2.4 第 1 条：「人格、记忆目录、表达手册与声音在领域侧；公共层只装配有身份和版本的
 * 任务输入，**不携带具体角色常量**。」`packages/shared/src/ai-task-kernel.ts` 就是那句
 * "公共层"——它管一次任务能否可靠、可控地执行（身份、预算、超时、检查点、提交）。
 * 它**不该**知道伴星是谁、记忆目录长什么样、日记选材怎么做。
 *
 * 这条边界一旦被跨过去，症状不会立刻出现，而会以别的形式出现：内核为了判断"这句话算不算
 * 空回复"而 import 判据函数，于是内核的 import 图里长出了 worker handler 依赖——
 * 下一个人改判据会被 typecheck 挡一下，改不动就加一层 re-export，最后公共层里出现一份
 * 人格副本，而两份副本永远不会同步。
 *
 * ## 三条判据（都是依赖事实，不是词数）
 *
 *   ① **公共运行层不导入人格/领域写入口。** 从 `ai-task-kernel.ts` 出发做可达闭包，
 *      闭包里任何文件都不得 import `companion-persona` / `pet-persona-presets` /
 *      `companion-agent-registry` / `companion-proactive-policy` / `db-schema/*` /
 *      `apps/api/src/modules/*`。判据看的是**解析后的路径**，不是文件里有没有那些词——
 *      所以注释里提到"人格"不算违规，`import` 了才算。
 *   ② **公共接口不暴露人格/领域写入口。** 闭包各文件导出的名字里不得出现领域概念
 *      （`COMPANION_*` 前缀 / persona / diary / memory / pet profile）。这条抓的是另一类
 *      真实失效：`re-export` 一个类型出去，公共层就在类型层面承认了自己有这 responsibility。
 *   ③ **反向断言（40b §2.5 A37）：人格仍在领域侧。** 人格常量必须还住在
 *      `companion-persona.ts` 与 `pet-persona-presets.ts`，公共层闭包里**一次都不许提到**它们
 *      的名字，而且必须有领域侧文件真的 import 它们——只声明不装配，同样是没装配。
 *
 * ## 为什么必须有正反样本
 *
 * 一份只会绿的文件证明不了任何事。所以这里：
 *   - 用**真实的** `packages/shared/src/index.ts` 当阳性对照（它的闭包里真的有人格模块），
 *     证明 forbidden 词表不是空的、解析器认得出真实的 import；
 *   - 现场造一份故意违规的最小源文件，跑完判据后删掉，证明判据对"新造的违规"同样灵敏；
 *   - 断言真实的合法结构通过；
 *   - 根目录定位写错时**抛错**，不静默返回空闭包（假绿的典型形状）。
 *
 * 40b §6.2 明确否掉了另一条路：不以专有词数或否定句数量的 ratchet 代替层边界。所以本文件
 * 全程不数"文本里出现了几次某个词"。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// ── 仓库根定位 ───────────────────────────────────────────────────────────────
// 写死"往上第几层"的话，文件被搬一次就要改一次，而忘了改的症状是**扫到空目录然后全绿**。
// 所以向上找同时具备三个标记的目录；找不到就抛。
function findRepoRootFrom(startDir: string): string {
  let dir = startDir;
  for (let hop = 0; hop < 12; hop += 1) {
    if (
      existsSync(join(dir, "packages/shared/src/ai-task-kernel.ts"))
      && existsSync(join(dir, "apps/api/src/modules"))
      && existsSync(join(dir, "workers/ai-worker/src/handlers"))
    ) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "定位仓库根失败：向上 12 层都没同时看到 packages/shared/src/ai-task-kernel.ts、"
    + "apps/api/src/modules 与 workers/ai-worker/src/handlers。"
    + "找不到就返回空闭包的话，下面三条判据会永远绿。",
  );
}

const ROOT = findRepoRootFrom(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_LAYER_ENTRY = join(ROOT, "packages/shared/src/ai-task-kernel.ts");

/** 公共层**不得** import 的人格 / 领域写入口（仓库相对路径）。 */
const FORBIDDEN_EXACT: ReadonlySet<string> = new Set([
  // 人格、目录与声音
  "packages/shared/src/companion-persona.ts",
  "packages/shared/src/pet-persona-presets.ts",
  // 领域装配：工具面、主动策略、闸与记忆载荷
  "packages/shared/src/companion-agent-registry.ts",
  "packages/shared/src/companion-capability-manifest.ts",
  "packages/shared/src/agent-capability-catalog.ts",
  "packages/shared/src/agent-capability-manifests.ts",
  "packages/shared/src/companion-proactive-policy.ts",
  "packages/shared/src/companion-proactive-quota.ts",
  "packages/shared/src/companion-leak-gates.ts",
  "packages/shared/src/companion-memory-job-payload.ts",
  "packages/shared/src/companion-memory-temporal.ts",
]);

/** 领域写入口的目录：表结构与后端模块。 */
const FORBIDDEN_PREFIXES: readonly string[] = [
  "packages/shared/src/db-schema/",
  "apps/api/src/modules/",
  "workers/ai-worker/src/handlers/",
];

/**
 * 公共接口不得暴露的领域概念。
 *
 * `/^COMPANION_/` 是主判据：伴星领域常量一律带这个前缀，公共层一个都不该有。
 * 其余几条按词根抓——它们抓的是"名字本身就承认了责任"这件事，与注释里提到什么无关。
 */
const FORBIDDEN_EXPORT_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^COMPANION_/, why: "伴星领域常量前缀（人格 / 记忆 / 日记 / 工具面）" },
  { pattern: /persona/i, why: "人格概念" },
  { pattern: /diary/i, why: "日记概念" },
  { pattern: /memor(?:y|ies)/i, why: "记忆概念" },
  { pattern: /pet_?profile|pet_?persona/i, why: "桌宠人格档案概念" },
];

/** 领域侧装配点：人格必须被真的接上去，不能只是"还定义着"。 */
const DOMAIN_ASSEMBLY_ROOTS: readonly string[] = [
  "workers/ai-worker/src/handlers",
  "apps/api/src/modules",
];

// ── import 扫描 ──────────────────────────────────────────────────────────────

/**
 * 读一个文件里的全部模块 specifier。
 *
 * 刻意**不**做词法级的注释剥离：只丢掉整行都是注释的那些行。理由是按行丢注释便宜得多，
 * 代价是「注释里写着一句 import」会被当成真的 import——那种假阳性是**可修的**（判据会红，
 * 并把文件、行号和 specifier 原样打出来，作者一眼能看出来那是注释）；而漏扫不是。
 * 注释里写 import 而不搬走，是这个仓库里不该出现的形状。
 */
function readImportSpecifiers(file: string): { spec: string; line: number }[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: { spec: string; line: number }[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trimStart();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    const patterns = [
      /\bfrom\s*["']([^"']+)["']/g,      // import … from / export … from（含 export * from）
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // 动态 import()
      /\bimport\s+["']([^"']+)["']/g,      // 副作用 import
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of raw.matchAll(pattern)) found.push({ spec: match[1]!, line: index + 1 });
    }
  });
  return found;
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|mts)$/.test(path) && !path.includes("/node_modules/");
}

/**
 * 把 specifier 解析成仓库内的绝对路径；解析不出来（裸包、node: 内建）返回 null。
 *
 * `@astella/shared` 加子路径按 apps/api tsconfig 的 paths 顺序试：先 `contracts/`，
 * 再平铺，最后目录的 index.ts。少这一步，`@astella/shared/db-schema/job` 会被当成
 * 「外部依赖」跳过——而它恰恰是最该拦的那一类。
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    candidates.push(base, `${base}.ts`, join(base, "index.ts"));
  } else if (spec === "@astella/shared") {
    candidates.push(join(ROOT, "packages/shared/src/index.ts"));
  } else if (spec.startsWith("@astella/shared/")) {
    const rest = spec.slice("@astella/shared/".length);
    candidates.push(
      join(ROOT, "packages/shared/src/contracts", `${rest}.ts`),
      join(ROOT, "packages/shared/src", `${rest}.ts`),
      join(ROOT, "packages/shared/src", rest, "index.ts"),
      join(ROOT, "packages/shared/src/contracts", rest, "index.ts"),
    );
  } else {
    return null;
  }
  for (const candidate of candidates) {
    if (isSourceFile(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

function repoRelative(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

function isForbiddenTarget(absolute: string): boolean {
  const rel = repoRelative(absolute);
  if (FORBIDDEN_EXACT.has(rel)) return true;
  return FORBIDDEN_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

/** 公共运行层的可达闭包：只跟着仓库内的相对 import 与 `@astella/shared` 别名走。 */
function publicLayerClosure(entry: string): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, line } of readImportSpecifiers(file)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) {
        if (spec.startsWith(".")) unresolved.push(`${repoRelative(file)}:${line} → ${spec}`);
        continue;
      }
      queue.push(resolved);
    }
  }
  return { files: [...seen], unresolved };
}

interface ImportViolation {
  readonly from: string;
  readonly line: number;
  readonly spec: string;
  readonly target: string;
}

/** 判据①的本体：把一个文件里指向人格/领域写入口的 import 逐条列出来。 */
function findForbiddenImports(file: string): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const { spec, line } of readImportSpecifiers(file)) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved !== null && isForbiddenTarget(resolved)) {
      violations.push({ from: repoRelative(file), line, spec, target: repoRelative(resolved) });
    }
  }
  return violations;
}

// ── 判据②的本体：顶层 export 名字 ────────────────────────────────────────────

function exportedNamesInSource(source: string): string[] {
  const names: string[] = [];
  const declarations = source.matchAll(
    /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm,
  );
  for (const match of declarations) names.push(match[1]!);
  for (const list of source.matchAll(/\bexport[ \t]*\{([^}]*)\}/g)) {
    for (const part of list[1]!.split(",")) {
      const alias = part.includes(" as ") ? part.split(" as ")[1] : part;
      const cleaned = alias.replace(/^type[ \t]+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) names.push(cleaned);
    }
  }
  return [...new Set(names)];
}

interface ExportViolation {
  readonly from: string;
  readonly name: string;
  readonly why: string;
}

function findDomainExportsIn(file: string): ExportViolation[] {
  const violations: ExportViolation[] = [];
  for (const name of exportedNamesInSource(readFileSync(file, "utf8"))) {
    for (const { pattern, why } of FORBIDDEN_EXPORT_PATTERNS) {
      if (pattern.test(name)) {
        violations.push({ from: repoRelative(file), name, why });
        break;
      }
    }
  }
  return violations;
}

// ── ① 公共运行层不导入人格/领域模块 ──────────────────────────────────────────

test("① 公共运行层（ai-task-kernel 及其可达模块）不导入人格/领域写入口", () => {
  const { files, unresolved } = publicLayerClosure(PUBLIC_LAYER_ENTRY);
  assert.deepEqual(unresolved, [],
    "公共层里有解析不到的相对 import——闭包是残的，下面那条结论就是建立在残图上的：\n  "
    + unresolved.join("\n  "));

  const violations = files.flatMap((file) => findForbiddenImports(file));
  assert.deepEqual(
    violations.map((v) => `${v.from}:${v.line}  import "${v.spec}"  →  ${v.target}`),
    [],
    "违反 40b §2.4 第 1 条「公共层只装配有身份和版本的任务输入，不携带具体角色常量」。\n"
    + "任务内核要知道自己是谁、记忆目录长什么样、日记怎么选材，于是内核的 import 图里"
    + "长出了领域依赖：换判据会被 typecheck 挡一下，改不动就再加一层 re-export，"
    + "最后公共层里出现第二份人格，而两份永远不会同步。\n"
    + "要引用的能力应该是一个**端口**（像 workspace-transaction 那样），由领域侧传进来。\n  "
    + violations.map((v) => `${v.from}:${v.line}  import "${v.spec}"  →  ${v.target}`).join("\n  "),
  );
});

// ── ② 公共接口不暴露人格/领域写入口 ─────────────────────────────────────────

test("② 公共层导出的名字里没有人格/领域写入口", () => {
  const { files } = publicLayerClosure(PUBLIC_LAYER_ENTRY);
  const violations = files.flatMap((file) => findDomainExportsIn(file));
  assert.deepEqual(
    violations.map((v) => `${v.from} → ${v.name}（${v.why}）`),
    [],
    "违反 40b §6.2「公共接口不暴露私有人格/领域写入口」。\n"
    + "哪怕只是 re-export 一个类型，公共层也在类型层面承认了自己对这件事负责："
    + "调用方于是可以用一个看起来中立的名字拿到人格/记忆/日记的东西，层边界在类型上就没了。\n  "
    + violations.map((v) => `${v.from} → ${v.name}（${v.why}）`).join("\n  "),
  );
});

// ── ③ 反向断言：人格仍在领域侧（A37） ───────────────────────────────────────

test("③ 人格、目录与文风仍住在领域侧，且真的被领域侧装配（反向断言）", async () => {
  // 反向断言的价值：防止有人"顺手清理"把人格搬进 shared 根部、让公共层自带角色常量。
  // 上面两条守的是"不许进公共层"，这一条守的是"还在原地"——搬走了就等于 ① ② 一起失效。
  const persona = await import(pathToFileURL(join(ROOT, "packages/shared/src/companion-persona.ts")).href) as Record<string, unknown>;
  for (const name of ["COMPANION_HOST_PROTOCOL_V8", "COMPANION_IDENTITY_BOUNDARY_V4", "COMPANION_CHARACTER_BASE_V12"]) {
    assert.equal(typeof persona[name], "string",
      `companion-persona.ts 不再导出 ${name}：人格被搬走了或者被删了。`
      + "这一条红的时候，① ② 两条的「还成立」已经没有意义了——它们守的公共层已经空了。");
  }
  const presets = await import(pathToFileURL(join(ROOT, "packages/shared/src/pet-persona-presets.ts")).href) as Record<string, unknown>;
  assert.ok(Array.isArray(presets.PET_PERSONA_PRESETS) && presets.PET_PERSONA_PRESETS.length > 0,
    "pet-persona-presets 不再提供人格预设：桌宠人格档案的目录侧也没了");

  // 公共层一次都不许提到这些名字。判的是**标识符**，不是"文本里出现了几个词"。
  const { files } = publicLayerClosure(PUBLIC_LAYER_ENTRY);
  const personaConstantNames = [
    "COMPANION_HOST_PROTOCOL_V8",
    "COMPANION_IDENTITY_BOUNDARY_V4",
    "COMPANION_CHARACTER_BASE_V12",
    "COMPANION_PERSONA_V13",
    "COMPANION_HOST_PROTOCOL_V6",
    "COMPANION_IDENTITY_BOUNDARY_V2",
    "COMPANION_CHARACTER_BASE_V7",
    "COMPANION_PERSONA_V7",
    "PET_PERSONA_PRESETS",
  ];
  const smuggled: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const name of personaConstantNames) {
      if (new RegExp(`\\b${name}\\b`).test(source)) smuggled.push(`${repoRelative(file)} 提到 ${name}`);
    }
  }
  assert.deepEqual(smuggled, [],
    "公共层里出现了人格常量名：哪怕只是 import 一个字符串，公共层就已经开始携带角色常量了。\n  "
    + smuggled.join("\n  "));

  // 非空断言：只定义不装配，等于没有装配。
  //
  // 领域侧**不是**从 `packages/shared/src/companion-persona.ts` 这个子路径 import 的——
  // 它 import 的是 `@astella/shared` 桶。所以判据要认「从人格模块**或**桶 import」，
  // 再加上「这个文件真的点名了某个人格常量」两个条件。只认子路径的话，这条会恒假。
  const personaModule = "packages/shared/src/companion-persona.ts";
  const sharedBarrel = "packages/shared/src/index.ts";
  const assemblers: string[] = [];
  for (const dir of DOMAIN_ASSEMBLY_ROOTS) collectPersonaAssemblers(join(ROOT, dir), personaModule, sharedBarrel, assemblers);
  assert.ok(assemblers.length > 0,
    `没有任何领域侧文件从 ${personaModule} 或 ${sharedBarrel} 引入人格常量：`
    + "人格还定义着，却没有人把它装配进提示词。判据 ③ 只钉「还定义着」是空的——"
    + "真正要守的是「领域侧把它接上了」");
});

const PERSONA_CONSTANT_REFERENCE =
  /\bCOMPANION_(?:HOST_PROTOCOL|IDENTITY_BOUNDARY|CHARACTER_BASE|PERSONA|VOICE_STYLE_LINES)_V\d+\b/;

/**
 * 谁把人格常量接进了自己的装配。
 *
 * 判据是两条**同时**成立：从人格模块或 shared 桶 import，且文件里出现了某个人格常量名。
 * 单看第二条会被注释里的举例命中，单看第一条则整个 shared 桶的调用方都算进来。
 */
function collectPersonaAssemblers(
  dir: string,
  personaModule: string,
  sharedBarrel: string,
  out: string[],
): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      collectPersonaAssemblers(path, personaModule, sharedBarrel, out);
      continue;
    }
    if (!isSourceFile(path) || /\.(test|integration)\.ts$/.test(name)) continue;
    const importsPersonaHome = readImportSpecifiers(path).some(({ spec }) => {
      const resolved = resolveSpecifier(path, spec);
      if (resolved === null) return false;
      const rel = repoRelative(resolved);
      return rel === personaModule || rel === sharedBarrel;
    });
    if (!importsPersonaHome) continue;
    if (PERSONA_CONSTANT_REFERENCE.test(readFileSync(path, "utf8"))) out.push(repoRelative(path));
  }
}

// ── 正样本：用真实的 index.ts 当阳性对照 ─────────────────────────────────────

test("【正样本 A】以 index.ts 为入口时，判据必须抓到真实的违规（否则词表是空的）", () => {
  const { files } = publicLayerClosure(join(ROOT, "packages/shared/src/index.ts"));
  assert.ok(files.length >= 20, `index.ts 的闭包只数到 ${files.length} 个文件——解析器多半坏了`);

  const violations = files.flatMap((file) => findForbiddenImports(file));
  const targets = new Set(violations.map((v) => v.target));
  for (const expected of [
    "packages/shared/src/companion-persona.ts",
    "packages/shared/src/companion-agent-registry.ts",
    "packages/shared/src/pet-persona-presets.ts",
    "packages/shared/src/companion-proactive-policy.ts",
  ]) {
    assert.ok(targets.has(expected),
      `解析 index.ts 的闭包时没认出 ${expected}：要么解析器坏了，要么 forbidden 词表漏了它。`
      + `当前抓到的是：${[...targets].join("、") || "（一个都没有）"}`);
  }
  // 同一批文件上，判据②也必须真的判出东西。
  const exportViolations = files.flatMap((file) => findDomainExportsIn(file));
  assert.ok(exportViolations.length > 0,
    "同一批文件上判据②一个都没判出来：它比判据①还灵敏是假的，说明它恒真");
});

// ── 正样本：现场造一份违规文件 ───────────────────────────────────────────────

test("【正样本 B】临时造的违规文件被判违规，合法的同形文件判合法（用完删掉）", () => {
  const fixtureDir = mkdtempSync(join(ROOT, ".companion-boundary-guard-"));
  try {
    const violating = join(fixtureDir, "public-layer-with-persona.ts");
    writeFileSync(violating, [
      'import { COMPANION_CHARACTER_BASE_V12 } from "../packages/shared/src/companion-persona.ts";',
      'import { companionTurnRuns } from "../packages/shared/src/db-schema/companion-conversations.ts";',
      'import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";',
      "export const companionPersonaProtocol = COMPANION_CHARACTER_BASE_V12;",
      "export const diaryRows = companionTurnRuns;",
      "export const toolSurface = resolveAllCompanionAgentTools;",
      "",
    ].join("\n"), "utf8");

    assert.ok(PERSONA_CONSTANT_REFERENCE.test(readFileSync(violating, "utf8")),
      "人格引用扫描漏掉了两位数版本，会把只装配新角色底座的模块误判为没有装配");

    const violations = findForbiddenImports(violating);
    assert.equal(violations.length, 3,
      `判据只抓到 ${violations.length} 条（${violations.map((v) => v.target).join("、")}），`
      + "期望 3 条：相对路径的 persona、相对路径的 db-schema、@astella/shared 别名的工具注册表");
    assert.ok(violations.some((v) => v.target.endsWith("db-schema/companion-conversations.ts")),
      "目录前缀这条没抓到——写死文件名的版本会让新增一个 db-schema 表就绕过去");
    assert.ok(violations.every((v) => v.line > 0), "每条违规都得带行号，否则读不出是哪一句 import");

    const exportViolations = findDomainExportsIn(violating);
    assert.deepEqual(exportViolations.map((v) => v.name).sort(), ["companionPersonaProtocol", "diaryRows"],
      "判据②没认出这两个导出名（或者多判了）——判据②的词根表需要跟真实命名对齐");

    // 反过来：同形但不违规的文件必须干净。正负样本只做一半，判据就是在测自己。
    const legal = join(fixtureDir, "public-layer-legal.ts");
    writeFileSync(legal, [
      'import { assertOutsideWorkspaceTransaction } from "../packages/shared/src/workspace-transaction.ts";',
      "import { z } from \"zod\";",
      "export const outsideTransactionGuard = assertOutsideWorkspaceTransaction;",
      "export const schema = z.object({});",
      "",
    ].join("\n"), "utf8");
    assert.deepEqual(findForbiddenImports(legal), [],
      "一个只依赖公共基础设施的同形文件被判违规：词表过宽会把合法抽象也拦下来");
    assert.deepEqual(findDomainExportsIn(legal), [],
      "合法文件的导出被判成领域概念：词根表过宽");
  } finally {
    // 用完就删：这份文件如果留在仓库里，apps/api 的 tsc 与 lib/ 分层守卫都会看见它。
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// ── 负样本：当前真实结构通过 ─────────────────────────────────────────────────

test("【负样本】真实的公共层当前通过全部三条判据（不是空断言）", () => {
  const { files } = publicLayerClosure(PUBLIC_LAYER_ENTRY);
  // 判据确实扫到了东西：闭包为空的话上面两条都是"零条违规 = 通过"。
  assert.ok(files.length >= 2,
    `公共层闭包只有 ${files.length} 个文件：ai-task-kernel 与它 import 的东西没被算进来，`
    + "三条判据都退化成空跑");
  assert.ok(existsSync(files[0]!));
  assert.equal(repoRelative(files[0]!), "packages/shared/src/ai-task-kernel.ts");
  // 至少有一条 import 边被真正解析过（而不是"一个 import 都没找到"）。
  const totalEdges = files.reduce((sum, file) => sum + readImportSpecifiers(file).length, 0);
  assert.ok(totalEdges >= 2, `公共层只数到 ${totalEdges} 条 import：判据多半没在读文件`);
});

// ── 自证：路径写错时判据要失败，而不是假绿 ───────────────────────────────────

test("【自证】根目录定位不到时**抛错**，不是返回空闭包", () => {
  // 必须用**仓库之外**的目录：向上找的算法在仓库内的任何目录都会找到根，
  // 拿仓库内的目录当反例，这条用例就只是在测一个恒真的断言。
  const outside = mkdtempSync(join(tmpdir(), "companion-boundary-root-"));
  try {
    assert.throws(
      () => findRepoRootFrom(outside),
      /定位仓库根失败/,
      "从一个仓库外的目录出发居然定位成功了：这条判据在错误路径上会假绿",
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  // 同一个函数在正确目录上必须成功——否则上面那条只是在测一个恒抛的函数。
  assert.equal(findRepoRootFrom(join(ROOT, "apps/api/src/__tests__")), ROOT);
});

test("【自证】入口路径写错时闭包计算立刻失败，而不是扫出空集", () => {
  assert.throws(() => publicLayerClosure(join(ROOT, "packages/shared/src/ai-task-kernel-v99.ts")),
    /ENOENT|no such file/,
    "入口文件不存在时竟然返回了空闭包：那种形状会让 ① 永远绿");
});

// ── 判据覆盖面自检 ───────────────────────────────────────────────────────────

test("【自证】forbidden 词表覆盖了 40b 点名的那几类，且每条都真的在仓库里", () => {
  for (const target of FORBIDDEN_EXACT) {
    assert.ok(existsSync(join(ROOT, target)), `forbidden 词表里的 ${target} 已经不存在了：`
      + "文件被搬走时词表必须同步，否则这条守卫正在守一个空地址");
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    assert.ok(existsSync(join(ROOT, prefix)), `forbidden 前缀 ${prefix} 不存在`);
  }
});
