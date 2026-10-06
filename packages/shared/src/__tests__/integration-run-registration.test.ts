/**
 * 回归网点名对账：每一份 `*.integration.ts` 都必须被某个**注册面**点名。
 *
 * 为什么这条要常驻：集成测试不会自己跑。真正执行它们的只有三样东西——包里的
 * `package.json` 脚本、CI 里那份点名单、`scripts/` 下的台子。一份文件谁都没提，
 * 它就是**零次执行**：既不会绿，也不会红，改坏了它的人一辈子看不见它。
 * 2026-09-26 数过一次：`apps/api` 那份 `test` 脚本的 find 条件是 `*.test.ts`，
 * 而集成测试一律叫 `*.integration.ts` ⇒ 通配根本不覆盖它们，全靠点名。
 * 那天在 111 份里找到 **27 份没有任何注册面**（第一例见 §19 那行"从来没跑过的 RLS 隔离集测"：
 * 它缺一个全仓没人注入的变量，自写下那天起一次没跑过）。
 *
 * 判据方向：**允许清单只能变短**。新写一份集测又没登记 ⇒ 红；把某份接进点名单而忘了
 * 从清单里删掉它 ⇒ 也红（清单留在原地就等于台账在说谎）。见 [[add-migration-must-register-journal]]。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/** 集成测试可能住在哪些包（递归找 `*.integration.ts`）。 */
const SCAN_ROOTS = ["apps", "workers", "packages"];
/**
 * 能真正执行它们的地方。文档里的提及不算注册。
 *
 * 2026-10-06：`.github/workflows/main-ci.yml` 移出这张表。CI 已经不再跑
 * postgres 集测（见 main-ci.yml 顶部决定），把它留在这儿会让"工作流里还写着
 * 那个文件名"继续被当成注册面——于是集测被移出 CI 之后，台账还在说它们有人跑，
 * 实际已经变成暗文件。注册面必须是**真的会执行**的地方。
 */
const SURFACES = [
  "package.json",
  "apps/api/package.json",
  "apps/desktop-client/package.json",
  "packages/shared/package.json",
  "workers/ai-worker/package.json",
];
const SURFACE_DIRS = ["scripts"];

/**
 * 已知"没有任何注册面"的存量（2026-09-26 逐份数出来的 27 份）。
 * 这条清单是**待办**，不是永久豁免：每接进一份点名单就该短一行。
 * 2026-09-27 短两行：`card-generation-v2-live-progress-postgres` 与
 * `card-generation-v2-llm-natural-activation` 随四阶段链一起删除（判据对象没了）。
 * 2026-10-06 清空：CI 不再是注册面（postgres 集测整体退出 CI，改由 `make
 * test-postgres` / `npm run test:*:postgres` 在本地跑），原先只被工作流点名的
 * 21 份 api 集测与 7 份 worker 集测已全部接进 package.json 脚本；
 * `card-generation-v2-domain-events.integration.ts` 在 worker 那侧的同名文件
 * 已随重构删除，但 apps/api 这侧同名的那份还在，于是也一并接进了脚本。
 */
const DARK_FILES_AWAITING_REGISTRATION = new Set<string>();

function integrationFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".integration.ts")) out.push(full.slice(REPO_ROOT.length + 1));
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort();
}

/**
 * 一个注册面里**真会执行这份文件**的那部分文本。
 *
 * package.json 只取 `scripts` 的值。动因（2026-09-27）：`apps/api/package.json` 里
 * `@astella/shared` 那条依赖声明被粘上了两个集成测试路径（接点名单时锚错了行），
 * 而"整个文件里出现过文件名就算注册"的旧口径当场判成已注册——那两份集测其实没进任何脚本、
 * 一次都没跑过。同一处损坏还让 pnpm 装不动：谁跑一次 `pnpm run` 就会把 `apps/api/node_modules`
 * 剪掉一半。⇒ 声明位置与执行位置在判据里必须是两个地方。
 *
 * CI 那份点名单里的**注释行**不算点名（否则在说明里提一句就"注册"了）。
 */
function registrationText(rel: string, raw: string): string {
  if (rel.endsWith(".json")) {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Object.values(parsed.scripts ?? {}).join("\n");
  }
  if (rel.endsWith(".yml")) {
    return raw.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  }
  return raw;
}

function registeredNames(): Set<string> {
  const parts: string[] = [];
  for (const rel of SURFACES) {
    if (!existsSync(join(REPO_ROOT, rel))) continue;
    parts.push(registrationText(rel, readFileSync(join(REPO_ROOT, rel), "utf8")));
  }
  for (const dir of SURFACE_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry);
      if (statSync(full).isFile()) parts.push(readFileSync(full, "utf8"));
    }
  }
  const joined = parts.join("\n");
  return new Set(
    integrationFiles()
      .filter((f) => joined.includes(f.split("/").pop()!))
      .map((f) => f.split("/").pop()!),
  );
}

test("分母自证：真的扫到了一批集成测试文件", () => {
  const files = integrationFiles();
  assert.ok(files.length > 80, `只扫到 ${files.length} 份 *.integration.ts：walk 坏了，这条判据就空转了`);
  // 阳性对照：已知被点名的那份必须扫得到。
  assert.ok(files.some((f) => f.endsWith("learning-runs-postgres.integration.ts")),
    "扫描没覆盖到 apps/api 那一族");
});

test("注册面判据是灵敏的：被点名的算注册，没人提的不算", () => {
  const registered = registeredNames();
  assert.ok(registered.has("learning-runs-postgres.integration.ts"),
    "CI 点名单里那份被判成未注册 ⇒ 判据读不到注册面");
  assert.ok(!registered.has("这一份不存在.integration.ts"),
    "一个没人提的名字被判成已注册 ⇒ 判据恒真");
});

test("注册口径是「会执行它的那一行」：依赖声明里出现文件名不算注册", () => {
  // 09-27 真实形状：两份集测被粘进 @astella/shared 的 specifier，脚本里一份都没有。
  const corrupt = JSON.stringify({
    scripts: { test: "node --import tsx --test $(find src -name '*.test.ts')" },
    dependencies: { "@astella/shared": "file:../../packages/shared src/dark-one.integration.ts" },
  });
  assert.ok(!registrationText("apps/api/package.json", corrupt).includes("dark-one.integration.ts"),
    "package.json 的 dependencies 被当成注册面 ⇒ 粘在声明里的文件名会替一份没人跑的集测作证");
  const honest = JSON.stringify({
    scripts: { "test:companion:postgres": "node --import tsx --test src/integration-tests/dark-two.integration.ts" },
    dependencies: { "@astella/shared": "file:../../packages/shared" },
  });
  assert.ok(registrationText("apps/api/package.json", honest).includes("dark-two.integration.ts"),
    "脚本值里的点名也不算了 ⇒ 收窄把真注册一起切掉了");
  // 本轮修好的那两份：现在只活在脚本值里，声明行已经干净。
  for (const name of ["history-search-postgres.integration.ts", "proactive-hook-postgres.integration.ts", "companion-memory-budget-postgres.integration.ts"]) {
    assert.ok(registeredNames().has(name), `${name} 没在任何脚本值里被点名（它仍是暗文件）`);
  }
  // 覆盖面不许只盯一份 manifest：同一只手会改错任何一个包。
  const manifests = SURFACES.filter((rel) => rel.endsWith("package.json") && existsSync(join(REPO_ROOT, rel)));
  assert.ok(manifests.length >= 4, `只扫到 ${manifests.length} 份 package.json ⇒ 声明位置那道形状闸基本没在扫`);
  const specifiers: Array<[string, string]> = [];
  const collect = (node: unknown, at: string): void => {
    if (typeof node === "string") { specifiers.push([at, node]); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collect(value, `${at}.${key}`);
    }
  };
  // 只看声明位置（overrides 是嵌套的，要往下走一层）；scripts 是执行位置，取值本来就该带空格。
  for (const rel of manifests) {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")) as Record<string, unknown>;
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
      if (group in parsed) collect(parsed[group], `${rel}·${group}`);
    }
  }
  const spaced = specifiers.filter(([, value]) => /\s/.test(value));
  assert.deepEqual(spaced.map(([where]) => where), [],
    `声明位置里出现了带空白的取值（${spaced.map(([where, value]) => `${where}=${JSON.stringify(value)}`).join(", ")}）：`
    + "像把测试路径粘进了依赖声明——这种形状让 pnpm 装不动，旧口径还会替暗文件作证");
});

test("每一份集成测试要么有注册面，要么在待办清单里（清单只能变短）", () => {
  const registered = registeredNames();
  const files = integrationFiles();
  const dark = files.filter((f) => !registered.has(f.split("/").pop()!));
  const newDark = dark.filter((f) => !DARK_FILES_AWAITING_REGISTRATION.has(f.split("/").pop()!));
  assert.deepEqual(newDark, [],
    `这些集测文件没有任何注册面（谁都不会跑它）：${newDark.join(", ")}；`
    + "接进 package.json 脚本或 CI 点名单之后本条才绿");
  const stale = [...DARK_FILES_AWAITING_REGISTRATION].filter(
    (name) => !dark.some((f) => f.endsWith(name)),
  );
  assert.deepEqual(stale, [],
    `清单里这几份已经有注册面了（或文件已不在了），把条目删掉：${stale.join(", ")}`);
});

test("待办清单里的文件确实还在（改名或删掉就同步清单，别留悬空条目）", () => {
  const present = new Set(integrationFiles().map((f) => f.split("/").pop()!));
  const gone = [...DARK_FILES_AWAITING_REGISTRATION].filter((name) => !present.has(name));
  assert.deepEqual(gone, [], `清单里有已不存在的文件：${gone.join(", ")}`);
});
