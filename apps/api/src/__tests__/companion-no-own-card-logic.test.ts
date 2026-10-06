/**
 * W7-9 判据一：**伴星入口不另写制卡提示/判分/调度逻辑**（39 §12.2.1、§15.6；判据 §16.27）。
 *
 * ## 这一格今天**结构上成立**，但**没有任何判据钉住**
 *
 * 实读结论（2026-09-27）：`components/companion/` 整个目录里**没有** `reviewSchedules`、
 * `ensurePendingReviewSchedule`、`semanticSpecHash`、`candidateRevisionHash`、
 * `calculateDiscreteV2Schedule` 的任何一处；`apps/api/src/modules/companion-conversation/`
 * 里**没有** `createGenerationRunV2` / `generation-run-service` 的引用。伴星要制卡，走的
 * 是**同一个审核台**（`open-card-generation` 那条房间路径），不是自己另开一条。
 *
 * 这正是 W7-8 刀四/刀五那一类：**机制在，但没有判据钉住**。而它一旦破，后果是
 * **屏上读不出来**的：伴星自己写一套制卡提示，于是"同一篇笔记"在两个入口产出两套卡，
 * 而两套都各有各的哈希与判分——审核台上看不出任何异常。
 *
 * ## 第二条：伴星**不因写权限自动开始学习**
 *
 * §12.2.1 那一族：伴星可以提议、可以写，但**提议 ≠ 开始**。这一条今天也成立（没有那一格
 * 触发点），同样钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 本文件在 apps/api/src/__tests__ 下，到仓库根是**四**层（__tests__ → src → api → apps → 根）。
// ⚠️ 这是我**第三次**数错这一类路径（另两次：W7-4 刀六的接线守卫、W7-4 刀八的用例）。
// 症状是 ENOENT；而**只检查读到的内容**的判据在路径不存在时会一路绿到底——
// 所以这类判据必须**先确认目录读得到**再谈内容。
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const COMPANION_UI = join(REPO, "apps/desktop-client/src/renderer/src/components/companion");
const COMPANION_API = join(REPO, "apps/api/src/modules/companion-conversation");

/** 目录里全部 .ts / .tsx 的源码（递归）。 */
function sourcesIn(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesIn(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push({ file: full, text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

test("W7-9 前置：两个目录都读得到（数错层级的症状是 ENOENT，而内容判据会一路绿）", () => {
  for (const dir of [COMPANION_UI, COMPANION_API]) {
    assert.ok(existsSync(dir), `读不到 ${dir}：这一份判据在数错的路径上会**一路绿到底**`);
  }
  assert.ok(sourcesIn(COMPANION_UI).length > 0, "伴星 UI 目录读得到却没有源文件：判据会变成空转");
});

test("W7-9 判据一：伴星不自己写制卡提示/判分/调度逻辑", () => {
  // 这五样是"另写一套"的**最小可判读集**：命中任何一样，就说明伴星有了自己的那一套。
  const forbidden = [
    "semanticSpecHash",
    "candidateRevisionHash",
    "candidateEvidenceBindingPlanHash",
    "calculateDiscreteV2Schedule",
    "ensurePendingReviewSchedule",
  ];
  const offenders: string[] = [];
  for (const { file, text } of sourcesIn(COMPANION_UI)) {
    for (const needle of forbidden) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [],
    "伴星里出现了制卡/调度的那几样，**后果是屏上读不出来的**："
    + "同一篇笔记在两个入口会产出两套卡，而两套各有各的哈希与判分，审核台上看不出异常。");
});

test("W7-9 判据一 正对照：伴星**不自己发起制卡 run**（它走同一个审核台）", () => {
  const offenders: string[] = [];
  for (const { file, text } of sourcesIn(COMPANION_API)) {
    for (const needle of ["createGenerationRunV2", "generation-run-service"]) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [],
    "伴星自己建制卡 run 了：它走的不再是同一个审核台，于是「两处口径一致」这件事失效。");
});

test("W7-9 判据二：伴星**不因写权限自动开始学习**", () => {
  // 「可以写」与「可以开始学」是两件事。这一格判的是：伴星那几处**没有**把两者连起来。
  // 命中下面任何一个名字，就是有人写了"拿到写权限就顺手开始"那一格。
  const autoStartMarkers = [
    "autoStartLearning",
    "autoStartRun",
    "startLearningOnWrite",
    "beginRunOnWrite",
  ];
  const offenders: string[] = [];
  for (const dir of [COMPANION_UI, COMPANION_API]) {
    for (const { file, text } of sourcesIn(dir)) {
      for (const marker of autoStartMarkers) {
        if (text.includes(marker)) offenders.push(`${file}: ${marker}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "出现了「拿到写权限就顺手开始学」那一格：§12.2.1「可以提议、可以写，但提议 ≠ 开始」。");
});

/**
 * W7-9 刀二：**「情境制卡携带同一材料版本与目标范围进同一审核」今天没有生产者。**
 *
 * ## 实读结论（2026-09-27）
 *
 * 伴星的提议体（`createCompanionMenuProposal` 的 `body`）只有：
 * `conversationId` / `clientMessageId` / `candidateId` / `expectedContextRevision` /
 * `expectedPayloadSha256` / `sourceSurface`，而 `candidateId` 只有
 * `"learning_run_resume" | "learning_run_start"` **两档**——**没有制卡那一档**。
 *
 * 加上刀一那条（伴星侧没有任何 `createGenerationRunV2` 引用），合起来是：
 * **伴星今天根本无法发起制卡**。所以「携带同一材料版本与目标范围进同一审核」这一条
 * **没有生产者**，它不是"版本带错了"，而是**根本没有那条路**。
 *
 * ## 为什么值得写成判据
 *
 * 因为这一格**读起来像已完成**：伴星能提议、能写、审核台确实只有一个。可是"进同一审核"
 * 那一半**没有生产者**时，它看上去就等于"伴星制卡会走同一审核"——而那句话今天**不成立**。
 * **一个空缺被一句读起来像已完成的话盖住，比空缺本身更坏。**
 *
 * ## 这一格**怎么才算做完**
 *
 * 要么（甲）给 `candidateId` 加一档 `"card_generation"`，并让它携带**笔记版本 id** ＋
 * **目标范围**（§4.2 那三档之一），由 `createGenerationRunV2` 封进 `semanticSpecHash`；
 * 要么（乙）**明确不做**，并把这一条从台账上划掉——两条都算完，**停在"没做"不算**。
 */
test("W7-9 刀二：伴星的提议体**没有制卡那一档**（所以「进同一审核」没有生产者）", () => {
  const bridge = readFileSync(
    join(REPO, "apps/api/src/modules/companion-conversation/learning-action-bridge.ts"),
    "utf8",
  );
  // ⚠️ 第一版这里用的是 `bridge.match(...)`——**只取第一处**。而 `candidateId` 在这一份
  // 里有**两处**声明（`menuProposalRequestHash` 的行内类型与 `createCompanionMenuProposal`
  // 的 body 类型），而我只改了后一处——于是**变异没红，我差点以为判据成立**。
  // 现在匹配**全部**并逐处断言。教训同上一条：**判据要盯住"每一处"，不是"某一处"**。
  const declarations = [...bridge.matchAll(/candidateId:\s*([^\n;]+);/g)].map((m) => m[1]!);
  assert.ok(declarations.length >= 2,
    `只找到 ${declarations.length} 处 candidateId 声明（第一版只取第一处就绿了）：`
    + "这一格要按新形状重写");
  assert.ok(declarations.every((d) => d.includes("learning_run_start")),
    "candidateId 的形状变了：这一格要按新形状重写");
  const withCard = declarations.filter((d) => d.includes("card_generation"));
  assert.deepEqual(withCard, [],
    "伴星多了一档制卡提议——那**很好**，但它必须携带**笔记版本 id ＋ 目标范围**，"
    + "并由 createGenerationRunV2 封进 semanticSpecHash；否则「携带同一材料版本与目标范围」"
    + "这一条只是多了一个入口，而那一半仍然落空。");
});

test("W7-9 刀二 正对照：伴星**能**提议的仍然只有学习轮次那一族", () => {
  const bridge = readFileSync(
    join(REPO, "apps/api/src/modules/companion-conversation/learning-action-bridge.ts"),
    "utf8",
  );
  // 这一条是**反向**的：确保刀二那条不是因为"整段被删了"而绿。
  // ⚠️ 第一版用 `includes("createCompanionMenuProposal")`——**改名成
  // `createCompanionMenuProposalRenamed` 时它照样包含那个子串**，所以那条反向判据在
  // "整段被改名"面前不响。改成**词边界**。
  assert.match(bridge, /export async function createCompanionMenuProposal\s*[(<]/,
    "伴星的提议那一发不见了（或被改名了）：刀二那条会对着一个空缺绿，而那正是它要防的。");
  assert.ok(bridge.includes("expectedContextRevision"),
    "提议体里那个乐观令牌不见了：并发时伴星会拿一份过期的上下文去做决定。");
});

/**
 * W7-9 刀三：「**持续授权/停订经唯一调度**」今天**成立**——而 `companion_reminders`
 * **不是第二条调度路径**（39 §16.31）。
 *
 * ## 刀三开题那一轮我以为查到了问题，核完三问之后结论相反
 *
 * 开题时看到伴星 `companion_schedule_reminder` 往 `companion_reminders` 写，而复习走
 * `review_schedules`，于是疑心有第二条路径。**核完三问，结论是它们不是同一件事**：
 *
 *  1. **不是同一概念的两份实现。** `companion_reminders` 的列是
 *     `text / fire_at / status / note_id`——**没有 `subject_type`、`subject_id`、
 *     `review_dimension`，也没有 `reminder_kind`**。它压根**不是一个复习主体**。
 *     `review_schedules.reminder_kind='one_time'` 那一档是**挂在某颗目标上的一次性复习
 *     提醒**；伴星那条是「提醒我三���后交某篇笔记」——自由文本 ＋ 笔记范围。
 *  2. **停订管不到它，也不需要管。** 0303 的订阅以
 *     `(subject_type, subject_id)` 为键（`note` 或 `objective`）。`companion_reminders`
 *     **不在那个键空间里**，所以「暂停卡片订阅」对它没有语义——这不是漏，是它本来就不
 *     是复习授权。
 *  3. **屏上不是同一个队列。** 复习到期队列（`review/service.ts`）**不读**伴星那张表
 *     （0 处引用）；伴星的投递走 `astella_fire_due_companion_reminders()` 这个
 *     SECURITY DEFINER 函数（迁移 0238），一分钟一次。
 *
 * ## 那为什么还要钉
 *
 * 因为**「两处都叫『提醒』」这件事本身会误导下一个人**。开题那一轮我自己就信了
 * 半个钟头。§16.31 那一格要防的是"伴星另起一套排期"，而这一格今天**不成立**——
 * 但它**读起来像可疑**，所以把它连同「为什么不是可疑」一起钉住。
 */
test("W7-9 刀三：`companion_reminders` **不是复习排期表**（没有复习主体那几列）", () => {
  // 判据的**形状**在迁移与 drizzle 声明两处都核——只核一处的话，那一处改了另一处会绿。
  const migration = readFileSync(
    join(REPO, "apps/api/src/db/migrations/0238_companion_reminders.sql"),
    "utf8",
  );
  // ⚠️ **只有迁移这一处**：全仓**没有** `companionReminders` 的 drizzle 声明——这张表
  // 只活在 SQL 迁移里，访问全走 `tx.execute(sql\`…\`)`（agent-runtime 那一支与 0238 的
  // SECURITY DEFINER 函数）。第一版判据按"迁移 ＋ drizzle 两处都核"写，于是对着一个
  // **不存在的第二处**红了——**判据按想象写，比判据写错更贵**，它会让人以为代码有问题。
  // 所以改成核迁移这一处，并把"没有 drizzle 声明"这件事本身记进注释。
  for (const [name, text] of [["迁移", migration]] as const) {
    assert.ok(text.includes("companion_reminders"), `${name} 里找不到 companion_reminders`);
    // 复习主体那几列**一律不许有**。
    for (const forbidden of ["subject_type", "subject_id", "review_dimension", "reminder_kind"]) {
      assert.ok(!new RegExp(`${forbidden}\\s+[a-z]`).test(text),
        `companion_reminders 上多了 ${forbidden}：它**开始像一个复习主体**了，`
        + "而 §16.31「伴星不另起一套排期」那一格就不成立了——"
        + "要么它就该并进 review_schedules，要么这一格要重新判。");
    }
  }
});

test("W7-9 刀三 正对照：复习那条路**不读**伴星那张表（两处各读各的）", () => {
  const offenders: string[] = [];
  for (const dir of [
    join(REPO, "apps/api/src/modules/review"),
    join(REPO, "apps/api/src/modules/card-generation-v2"),
  ]) {
    for (const { file, text } of sourcesIn(dir)) {
      if (text.includes("companion_reminders")) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    "复习那条路读伴星那张表了：两条路一旦互相读，「经唯一调度」就变成了「经两条互相读的调度」。");
});

test("W7-9 刀三 正对照：伴星的投递仍走那个 SECURITY DEFINER 函数（0238 的形状没变）", () => {
  const scheduler = readFileSync(
    join(REPO, "workers/ai-worker/src/handlers/companion-reminder-scheduler.ts"),
    "utf8",
  );
  // 它必须**不能**被改成一条普通的 SELECT：那一句的注释里写着为什么（生产 worker 非
  // superuser、无 BYPASSRLS，直接 SELECT 会被 RLS 滤成空集——dev 正常、生产静默）。
  assert.match(scheduler, /astella_fire_due_companion_reminders/,
    "伴星提醒的投递函数不见了：换掉它之前先读它头上那段注释——"
    + "「dev 正常、生产静默什么都不做」是这类定时器最难查的失效方式。");
});

/**
 * W7-9 刀四：「**进度与回执与实际业务一致**」今天**结构上成立**（39 §16.31 后半）。
 *
 * ## 成立在哪
 *
 * 伴星报的那些学习数字（到期数、任务队列、这一轮做到哪）**都出自一个共用的读器**
 * `readLearningStats`（`workers/ai-worker/src/handlers/companion-here-and-now.ts`）：
 * 她答话的口径与"用户问到学习数据时先注入的真值"是**同一个数**。
 *
 * 那个读器的到期数**直接数 `review_schedules`**（`status='pending' AND
 * next_review_at <= now()`），**不是**从别处推的——所以伴星嘴里那个「待复习 N」与
 * 复习队列是**同一份事实**。
 *
 * ## 为什么还要钉
 *
 * 这三样（共用读器、直接数 `review_schedules`、队列与到期同一个子查询）**都长得像实现
 * 细节**。任何一次"给伴星加一个更快的统计"（比如从 `companion_reminders` 数、或从
 * 任务队列推）都会让两处分叉，而**屏上读不出来**：伴星说"还有 3 张要复习"，而复习
 * 那一屏列着 5 张，两边各自都像对的。
 */
test("W7-9 刀四：伴星的学习数字出自**一个共用读器**（两处不各写一份）", () => {
  // 2026-09-30（B2）：工具执行族已拆进 `companion-tool-execution.ts`，
  // 那一支随之搬走了。判据的对象是「伴星的学习数字出自**一个**共用读器」，
  // 不是「它在 companion-agent-runtime.ts 里」——所以读 handlers/ 整个目录。
  const runtime = readdirSync(join(REPO, "workers/ai-worker/src/handlers"))
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => readFileSync(join(REPO, "workers/ai-worker/src/handlers", n), "utf8"))
    .join("\n");
  // 工具那一支必须调 `readLearningStats`，不许自己再查一遍。
  const branchStart = runtime.indexOf('case "companion_get_learning_stats"');
  assert.ok(branchStart > 0, "那一支不见了：这一格要按新形状重写");
  const branch = runtime.slice(branchStart, branchStart + 900);
  assert.match(branch, /readLearningStats\(/,
    "伴星的学习统计不调共用读器了：她答话的口径与注入的真值会分叉，"
    + "而两处各自都像对的。");
});

test("W7-9 刀四 正对照：那个读器的到期数**直接数 `review_schedules`**", () => {
  const reader = readFileSync(
    join(REPO, "workers/ai-worker/src/handlers/companion-here-and-now.ts"),
    "utf8",
  );
  // 直接数排期表，而不是从任务队列或伴星自己的提醒推。
  assert.match(
    reader,
    /count\(\*\)\s*FROM review_schedules[\s\S]{0,200}status = 'pending'[\s\S]{0,120}next_review_at <= now\(\)/,
    "共用读器的到期数不直接数 `review_schedules` 了：伴星嘴里那个「待复习 N」"
    + "于是和复习队列不是同一份事实——**屏上读不出来**。",
  );
  // 三条查询同源：外层别名固定为 s（该文件自己的注释就是这么写的）。
  assert.ok((reader.match(/FROM review_schedules s/g) ?? []).length >= 2,
    "到期数与别的那几条不再同源了：同一份事实被数成了两个口径");
});

test("W7-9 刀四 正对照：伴星**不把自己的提醒**算进「待复习」", () => {
  // ⚠️ 第一版我写的是「读器里不许出现 `companion_reminders`」——**过宽**，当场红了。
  // 实读：它**确实**读那张表，但读的是**「下一条待兑现的提醒」**（`SELECT text …
  // LIMIT 1`）——那是给伴星念的一句提醒，**不是复习到期数**。两件事。
  //
  // 所以这一格要断言的是**那两件事不许混**：数到期的那几条查询里不许出现它，
  // 而它自己那一条必须是**独立语句 + LIMIT 1**（"念一条"而不是"数一遍"）。
  const reader = readFileSync(
    join(REPO, "workers/ai-worker/src/handlers/companion-here-and-now.ts"),
    "utf8",
  );
  // ① 数到期的那几条（`FROM review_schedules s`）里不许有它。
  const reviewBlocks = [...reader.matchAll(/\(\s*SELECT count\(\*\)[\s\S]{0,220}?\)/g)].map((m) => m[0]);
  assert.ok(reviewBlocks.length >= 2, `到期相关的子查询只找到 ${reviewBlocks.length} 处：这一格要按新形状重写`);
  for (const block of reviewBlocks) {
    assert.ok(!/companion_reminders/.test(block),
      "到期数那条查询里出现了 companion_reminders：那就不是复习到期数了，"
      + "而它会被当成复习到期数报出去——**屏上读不出来**。");
  }
  // ② 它自己那一条必须**独立语句 + LIMIT 1**（"念一条"），不是并进到期那一族。
  const reminderQuery = reader.match(/SELECT text,[\s\S]{0,300}?FROM companion_reminders[\s\S]{0,300}?;/);
  assert.ok(reminderQuery, "读不到伴星那条提醒查询了：这一格要按新形状重写");
  assert.match(reminderQuery[0], /LIMIT 1/,
    "伴星那条提醒不再是「念一条」了：它变成了数一遍，而那会被读成待复习的条数。");
});
