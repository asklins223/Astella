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

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
/** 集成测试可能住在哪些包（递归找 `*.integration.ts`）。 */
const SCAN_ROOTS = ["apps", "workers", "packages"];
/** 能真正执行它们的地方。文档里的提及不算注册。 */
const SURFACES = [
  "package.json",
  "apps/api/package.json",
  "apps/desktop-client/package.json",
  "packages/shared/package.json",
  "workers/ai-worker/package.json",
  ".github/workflows/ci.yml",
];
const SURFACE_DIRS = ["scripts"];

/**
 * 已知"没有任何注册面"的存量（2026-09-26 逐份数出来的 27 份）。
 * 这条清单是**待办**，不是永久豁免：每接进一份点名单就该短一行。
 */
const DARK_FILES_AWAITING_REGISTRATION = new Set([
  "card-generation-v2-domain-events.integration.ts",
  "card-generation-v2-bounded-repair-postgres.integration.ts",
  "card-generation-v2-c-cases.integration.ts",
  "card-generation-v2-live-progress-postgres.integration.ts",
  "card-generation-v2-llm-natural-activation.integration.ts",
  "card-generation-v2-postgres.integration.ts",
  "card-generation-v2-redaction-quota.integration.ts",
]);

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

/** CI 那份点名单里的**注释行**不算点名（否则在说明里提一句就"注册"了）。 */
function surfaceText(rel: string): string {
  const text = readFileSync(join(REPO_ROOT, rel), "utf8");
  if (!rel.endsWith(".yml")) return text;
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

function registeredNames(): Set<string> {
  const haystack: string[] = [];
  for (const rel of SURFACES) {
    if (existsSync(join(REPO_ROOT, rel))) haystack.push(surfaceText(rel));
  }
  for (const dir of SURFACE_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry);
      if (statSync(full).isFile()) haystack.push(readFileSync(full, "utf8"));
    }
  }
  const joined = haystack.join("\n");
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
