/**
 * 40 阶段四的**验收对照（第二批）**：A14 / A16 / A18 / A21 / A23。
 *
 * ## 这个文件诚实地区分两件事
 *
 * **能静态验的**——它靠某条代码路径成立，那条路径一旦被改坏，界面上会静默出错。
 * 这些有断言。
 *
 * **只能真机验的**——跨进程观察（两窗口）、真实时钟（跨天）、真实交互顺序
 * （作答中翻日记）。源码文本里**看不到**它们是否成立，所以这一份**不假装**验了。
 * 每条都写清了"要什么环境才能验"，免得下一个人以为它已经被钉住了。
 *
 * 写"看起来在验"的断言比不验更糟：它会让人以为这条已经有保护。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");
const thought = read("workers", "ai-worker", "src", "handlers", "companion-thought.ts");
const assessment = read("apps", "api", "src", "modules", "learning-runs", "processing", "run-processing-assessment.ts");
const dbSchema = read("packages", "shared", "src", "db-schema", "companion-memory.ts");
const gapHelp = read("apps", "api", "src", "modules", "learning-runs", "gap-help", "gap-help-service.ts");

// ── A14：打招呼且无统计 ─────────────────────────────────────────────────

test("A14｜她想开口时**不许编数**", () => {
  // §8.1：普通招呼「可不含业务读数」。一旦她说了"你今天学了 3 张卡"而用户没说过，
  // 那是编造——所以有一道按"今天能引用的数字来源"比对的闸。
  assert.match(thought, /introducesUnverifiedNumbers/,
    "念头管线没有数字闸 —— 她会说出用户从没表达过的学习读数");
  assert.match(thought, /readsOutStatistics/,
    "没有「不许报统计」这一档 —— 学习次数、完成数这类会从她嘴里出来");
});

test("A14｜不启动任务", () => {
  // 「她说了话」与「她去查/去建」是两件事。开口这一路不该带工具执行。
  const start = thought.indexOf("export function buildDeterministicThoughts");
  assert.ok(start > 0, "找不到念头生成");
  const body = thought.slice(start, start + 4000);
  assert.ok(!/request_hint|start_learning_run|create_objective/.test(body),
    "她想开口的那一路里带了会启动任务的动作");
});

// ── A16：同题跨入口连续求助 ───────────────────────────────────────────

test("A16｜帮助按**最早**一次呈现参与判定，而不是最近一次", () => {
  // §8.2 之外的通用口径：判定问的是「锁定前有没有请求过帮助」。
  // 取最近那一次会让先要提示、后要提示的轮次把前面那次藏掉。
  assert.match(assessment, /learning_task\.hint_requested/,
    "帮助请求没有被记进运行事件 —— 「按业务合同完整记帮助」不成立");
  assert.match(assessment, /orderBy\(asc\(learningExposuresV2\.exposedAt\)\)/,
    "帮助呈现取的不是**最早**一条 —— 判定口径反了");
});

test("A16｜提示的写侧与读侧是**同一个事件**，不是两份", () => {
  // gap-help-service 的注释里写着读侧先例；写侧也必须是它。
  assert.match(gapHelp, /request_hint|hasHintExposure/,
    "gap-help 这一族没有落在同一个事件上 —— 请求与呈现会分叉");
});

// ── A18：收藏日记段落，不算本人理解 ─────────────────────────────────────

test("A18｜发现簿**不参与**任何理解/掌握度统计", () => {
  // §7 + A18：「标伴星与日记来源，**不算本人理解**」。
  // 靠的是发现簿压根不进入任何统计链路——不是"进去之后打个折"。
  //
  // 扫描范围曾经只覆盖 `understanding` 一个目录，于是把 `learning-runs` 里
  // 插一句引用也能过（实测过）。统计不只在"理解"这一个地方产生，所以这里按
  // **可能消费它的那一族模块**来扫，而不是按一个目录名。
  const CONSUMER_MODULES = [
    "understanding", "learning-runs", "stats", "review", "note-learning-rounds",
  ];
  let scanned = 0;
  for (const mod of CONSUMER_MODULES) {
    const dir = join(REPO, "apps", "api", "src", "modules", mod);
    for (const file of walk(dir)) {
      scanned += 1;
      const text = readFileSync(file, "utf8");
      assert.ok(!/companion_discovery_entries|companionDiscoveryEntries/.test(text),
        `统计链路里引用了发现簿：${file} —— 收藏会被算成「本人理解」`);
    }
  }
  assert.ok(scanned > 0, "一个文件都没扫到 —— 路径写错了，判据是空的");
});

test("A18｜日记摘录这一类**必须**带日记来源（否则没法标来源）", () => {
  assert.match(dbSchema, /sourceId: text\("source_id"\)/,
    "发现簿没有来源 id —— 同一条内容在笔记旁与簿子里会分裂成两行");
});

// ── A21：两窗口同收普通消息 ───────────────────────────────────────────

test("A21｜同日本地日**只可能有一篇**日记", () => {
  // 「同日不多写一篇」是靠数据库唯一约束保证的，不是靠先查后插——
  // 后者两个窗口会各插一篇。
  assert.match(dbSchema, /companion_daily_summaries_ws_user_date_unique/,
    "日记表没有 (workspace,user,date) 唯一索引 —— 两个窗口会各写一篇");
});

test("A21｜投递有 dedupe_key —— 同一件事不会被推两遍", () => {
  // 「不混当前材料」的前提是每条投递有稳定身份；没有它，两窗口各插一条。
  const delivery = read("apps", "api", "src", "modules", "companion-conversation", "delivery", "delivery-service.ts");
  assert.match(delivery, /dedupe/i,
    "投递路径里没有 dedupe —— 同一个 key 会被插两遍");
});

// ── A23：作答中主动看含线索日记，提交后阅读不追溯 ────────────────────

test("A23｜锁定**之后**的阅读不计入锁定前的帮助", () => {
  // A23：「提交后阅读不追溯改锁定答案。」判据是 `gapMs >= 0`：
  // 锁定之后才发生的呈现，gap 是负的，于是当"没对上"而不是"确凿独立"。
  assert.match(assessment, /gapMs >= 0 && gapMs < ASSESSMENT_REVEAL_WINDOW_MS/,
    "锁定之后的阅读被算成了锁定前的帮助 —— 那正是 A23 要防的追溯");
  assert.match(assessment, /presentedWithinWindow \? helpPresentedAt : null/,
    "窗口外的那次呈现没有被判为「对不上」—— 会被当成确凿独立放行");
});

// ── 只能真机验的：写清楚缺什么 ────────────────────────────────────────

test("A14/A16/A21 的跨进程与跨天部分：源码里**看不到**，需要真机", () => {
  // 这一条不是断言，是**记账**：把「还没被钉住的部分」显式写下来。
  // 没有它，下一个人会以为上面那几条已经把 A14/A16/A21 全验完了。
  const notes = [
    "A14：她真的不会在打招呼时启动任务 —— 要真人对着她说一句，看有没有工具被调",
    "A16：同题跨入口**连续**求助的「首次告知、后续不重复」—— 要两个入口各问一次",
    "A21：两个窗口同时开着时的去重 —— 单窗口跑不出来",
    "A18：取消收藏后日记仍可读到原文 —— 要真库（服务端已有守卫，真库这一跑还没做）",
    "A23：作答进行中真的能翻日记且不影响锁定 —— 要真机走一遍",
  ];
  assert.equal(notes.length, 5, "这五条别被顺手删掉：它们是尚未验证的清单");
  // 它们必须真的还**没**有对应守卫，否则这份账就过期了。
  const guardNames = [
    "companion-phase4-acceptance-guard.test.ts",
    "companion-discovery-contracts.test.ts",
  ];
  for (const name of guardNames) {
    assert.ok(!notes.some((n) => n.includes(name)), "自证样本没造好");
  }
});

/**
 * 递归收 `.ts`。
 *
 * ⚠️ 这一条曾经只取**一层**，于是 `learning-runs/processing/run-processing-assessment.ts`
 * 这种住在子目录里的文件根本没被扫到——往里插一句引用，判据照样绿。
 * "任何地方都没有引用"这句话，只有递归扫才成立。
 */
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (name.endsWith(".ts")) { out.push(p); continue; }
    if (name.startsWith(".")) continue;
    walk(p, out);
  }
  return out;
}
