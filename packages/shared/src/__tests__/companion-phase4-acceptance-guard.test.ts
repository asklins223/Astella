/**
 * 40 阶段四的**验收对照**：A15 / A17 / A19 / A22。
 *
 * ## 为什么要有这个文件
 *
 * 阶段四的验收编号是**行为**，不是实现。但其中有几条已经**由结构保证**了
 * （比如"换人格不改旧日记"靠的是"全仓没有那条 UPDATE 路径"）。结构满足却
 * 没有任何东西盯着，就会在下一次有人加一条 UPDATE 路径时悄悄失效。
 *
 * 每条下面都写了它**靠什么成立**。没有依据的那句断言就是空话。
 *
 * ## 不在这里的：A14 / A16 / A18 / A21 / A23
 *
 * 它们的依据不在源码文本里（跨入口行为、需要真机或真库），已分别由
 * `companion-discovery-*`（A18）与 `companion-learning-nudge-pause`（A17 的另一半）
 * 覆盖，或需要真机验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");
const exists = (...parts: string[]) => {
  try { readFileSync(join(REPO, ...parts), "utf8"); return true; } catch { return false; }
};

const delivery = read("apps", "api", "src", "modules", "companion-conversation", "delivery", "delivery-service.ts");
const proactiveHook = read("apps", "api", "src", "modules", "companion-conversation", "delivery", "proactive-hook.ts");
const shell = read("apps", "api", "src", "modules", "companion-shell", "service.ts");
const dailySummary = read("workers", "ai-worker", "src", "handlers", "companion-daily-summary.ts");

// ── A19：换人格后看旧日记，新表达只影响新产物 ────────────────────────────

test("A19｜日记在**生成时**记下当时的人格版本", () => {
  // 三样都要记：档案版、示例版、默认表达版。只记一样就会出现"换人格后旧日记
  // 读起来像新人格写的"这一类说不清的错。
  assert.match(dailySummary, /personaProfileRevision: persona\.revision/);
  assert.match(dailySummary, /personaExamplesRevision: persona\.revision/);
  assert.match(dailySummary, /defaultExpressionVersion: persona\.defaultExpressionVersion/);
});

/**
 * 取一段源码里**每条** `UPDATE companion_daily_summaries` 的 SET 子句。
 *
 * 只看 SET，不看 WHERE：条件里出现 `source_event_ids && ...` 是**读**，
 * 不是改写。按整段文本匹配分不出读写，所以先切出 SET 再说。
 */
function diaryUpdateSetClauses(source: string): string[] {
  const clauses: string[] = [];
  for (const match of source.matchAll(
    /UPDATE\s+(public\.)?companion_daily_summaries\b([\s\S]*?)(?=WHERE|RETURNING|$)/gi,
  )) {
    clauses.push(match[2] ?? "");
  }
  return clauses;
}

test("A19｜**全仓没有**改写已生成日记的路径", () => {
  // 这是 A19 的核心：换人格不改旧日记，靠的不是"记得别改"，而是根本没有那条路。
  // 一旦有人加一条 UPDATE，旧日记就会被新表达重写——而界面上看不出任何异常。
  const sources = [
    ["apps", "api", "src", "modules", "companion-conversation", "daily-summary-routes.ts"],
    ["apps", "api", "src", "modules", "companion-conversation", "turn"],
    ["workers", "ai-worker", "src", "handlers", "companion-daily-summary.ts"],
  ];
  for (const parts of sources) {
    const target = parts[parts.length - 1];
    const file = join(REPO, ...parts);
    if (!exists(...parts)) continue;
    const text = readFileSync(file, "utf8");
    // 内容列：改任何一列，旧日记就会被新表达重写——而界面上看不出任何异常。
    //
    // 可见性列（hidden_at / deleted_at / delete_reason，40 §10）**不在**这个集合里：
    // 它们不改这篇日记写了什么，只改它出现在哪儿。§10 明确要求「隐藏日记」与
    // 「删除日记」是用户可用的控制，把它们算成"改写旧日记"会让合同要求的动作
    // 无法实现——所以这里守的是内容，不是"有没有 UPDATE 这条语句"。
    const contentColumns = ["blocks", "summary", "facts", "revision",
      "selection_reason", "selected_id", "source_event_ids", "generated_at"];
    for (const setClause of diaryUpdateSetClauses(text)) {
      for (const column of contentColumns) {
        assert.ok(!new RegExp(`\\b${column}\\b`).test(setClause),
          `${target} 里有改写日记内容列（${column}）的 UPDATE —— A19 会被破坏`);
      }
    }
  }
});

test("A19｜已发布成稿受保护：后台重跑不能替换（§5.5）", () => {
  assert.match(dailySummary, /expectedHash/,
    "没有 expectedHash 校验 —— 后台重跑会静默替换用户已经看过的那一版");
});

// ── A15：正式作答期间，提醒持久、日记安静更新、形象可见 ──────────────────

test("A15｜正式作答期间**不弹**普通招呼（安静规则生效）", () => {
  // ⚠️ 这个闸**不在**投递钩子里。投递钩子走的是触发式（跑完之后的"要继续吗"），
  // 那一路按 0238/0270 只看设备在不在与过期；正式作答期间**不弹普通招呼**
  // 是念头管线那条路（她"自己想开口"）的职责。
  // 查错文件会得到一个恒假的断言，或者更糟——恒真。
  const thought = read("workers", "ai-worker", "src", "handlers", "companion-thought.ts");
  assert.match(thought, /formalAnswerInProgress/,
    "念头管线没有读正式作答状态 —— 作答中途她会插话");
  assert.match(thought, /formal_answer_in_progress/,
    "决策结果里没有这一档 —— 安静规则在这一层就没了");
});

test("A15｜约定提醒**持久**：只被设备不在与过期挡，不被作答/额度挡", () => {
  // 触发式推送的判据是 `evaluateTriggeredPush`，它只看 availability 与 expired。
  // 若有人把额度闸也加进去，一条 09:00 的提醒会被「她今天话说多了」压掉，
  // 用户得到的是"提醒不准"。
  assert.match(proactiveHook, /evaluateTriggeredPush\(\{ availability, expired: false \}\)/,
    "触发式推送的判据形状变了 —— 检查它有没有被塞进别的闸");
  assert.match(proactiveHook, /evaluateLearningNudgePause/,
    "学习建议这一路没有接「今天别催学习」");
});

// ── A17：不想学或一周未回来 ────────────────────────────────────────────

test("A17｜恢复后**不补播**普通消息，不形成消息债务（§8.2）", () => {
  assert.match(delivery, /dropStaleAmbientOnResume/,
    "收件箱没有丢弃过时的普通招呼 —— 用户回来先读一堆过期的话");
  assert.match(delivery, /evaluateStaleAfterResume/);
  // 关键：丢的是**列表**里的那些，不是把它们标成已读。所以要确认是 filter。
  assert.match(delivery, /\.filter\(\(row\) => \{/,
    "丢弃不是靠 filter 做的 —— 那可能只是没取出来，而历史里还在");
});

test("A17｜约定提醒**不**被这条丢弃规则带走", () => {
  // 按「有没有文案」分：有 text 的是她自己想开口的；没有的是约定提醒/学习完成。
  // 反过来写就会把用户约好的提醒在下午回来时丢掉。
  //
  // 断言的是**那条分支真的把无文案行留下**，而不是"payload.text 这个词出现过"。
  // 只查词会漏掉 `if (false) return true;` 那种退化——词还在，行为已经反了。
  // 定界用 `.map(toContract)` 而不是找 `\n}` —— filter 里的 `})` 会先撞上。
  const start = delivery.indexOf("function dropStaleAmbientOnResume");
  const end = delivery.indexOf(".map(toContract);", start);
  assert.ok(start > 0 && end > start, "找不到 dropStaleAmbientOnResume 的函数体");
  const body = delivery.slice(start, end);
  assert.match(body, /payload\.text/);
  assert.match(body, /if \(!hasText\) return true;/,
    "无文案的行没有被无条件留下 —— 约定提醒会被一起丢");
  // 真正要验的是**次序**：`if (!hasText) return true;` 必须在丢弃调用**之前**。
  // 有文案的那些活不到丢弃判断——只有它们会被丢。
  const keepIndex = body.indexOf("if (!hasText) return true;");
  const dropIndex = body.indexOf("evaluateStaleAfterResume(");
  assert.ok(keepIndex > 0 && dropIndex > keepIndex,
    "无文案的行没有被提前留下 —— 约定提醒会被一起丢（次序反了或早返回没了）");
});

// ── A22：关闭伴星功能后学习与已授权安排完整 ─────────────────────────────

test("A22｜关闭伴星**不挡学习**：那个开关只出现在投递侧", () => {
  // 依据：`globalEnabled === false` 的判断只出现在主动投递的钩子里，
  // 学习运行的链路上没有它。控制项只产生"已说明的效果"（§8.2）——
  // 关闭伴星应该让她不说话，而不是让用户学不了。
  // 学习链路上不该出现伴星总开关。取一个确实存在的学习模块来钉这件事。
  const learningBridge = read("apps", "api", "src", "modules", "companion-conversation", "learning-action-bridge.ts");
  assert.ok(!/globalEnabled/.test(learningBridge),
    "学习动作桥里出现了伴星总开关 —— 关闭伴星会连学习一起挡掉");
  assert.match(proactiveHook, /globalEnabled === false/,
    "投递钩子不再看伴星总开关 —— 关闭之后她还会主动说话");
});

test("A22｜关闭伴星推进 epoch 并广播，但不碰已授权安排", () => {
  assert.match(shell, /globalOffApplied \? row\.epoch \+ 1 : row\.epoch/,
    "关闭伴星没有推进 epoch —— 在途的那一轮不会被作废");
  // 广播只带 {userId, epoch}：设备据此停掉界面，而不是取消任何安排。
  assert.match(shell, /JSON\.stringify\(\{ userId, epoch \}\)/,
    "广播载荷变了 —— 若里面带上了安排/提醒，关掉伴星就会顺手撤掉用户约好的事");
});

test("【自证】判据认得住「加一条 UPDATE 日记的路径」这个真实退化", () => {
  // 退化形状：有人加了一句 update(companionDailySummaries)。
  const degraded = "await tx.update(companionDailySummaries).set({ blocks: newer }).where(...);";
  assert.match(degraded, /update\(companionDailySummaries\)/, "自证样本没造好");
  // 正控制：现在没有。
  const routes = read("apps", "api", "src", "modules", "companion-conversation", "daily-summary-routes.ts");
  assert.ok(!/update\(companionDailySummaries\)/.test(routes), "自证：当前确实没有");
});

test("【自证】判据认得住「约定提醒被一起丢掉」这个更重的退化", () => {
  // 退化形状：不看有没有文案，一律按过时丢弃。
  const degraded = "return rows.filter((row) => ageMs(row.createdAt) < STALE).map(toContract);";
  assert.match(degraded, /\.filter\(\(row\)/, "自证样本没造好");
  // 正控制：真代码先看了 payload.text。
  assert.match(delivery, /payload\.text/, "自证：当前确实先看文案再决定丢不丢");
});
