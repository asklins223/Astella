# 57 · 学习卡并入笔记与取消复习/今日

> **2026-10-21 窗口复查补充：** 已检查并修复放大布局、练习退出焦点、原文预览、题号精确跳转及报告／庆祝返回焦点，补充应用内关闭动效的连续窗口验证；题目语义等完整验收仍未结束。见[真实窗口检查记录](../../testing/plan-57-58-window-check-2026-10-21.md)。

> **2026-10-21 implementation audit:** The note-card flow is implemented, but earlier completion records did not cover all active contracts, grading paths or source/version navigation. Those gaps and remaining formal-answer/tutor stubs have now been corrected, with real model/API and desktop-window checks. Broader semantic-content and UI/platform acceptance remains open. See the [current audit, fixes and evidence](../../testing/plan-57-58-audit-2026-10-21.md).

> **2026-10-21 evening follow-up:** The documented per-question discard ("校验失败先重试一次；仍失败则丢弃该题，并在卡上报告有 N 道题未通过校验，没有收录；有效题少于 4 道才整卡失败") is now implemented end to end (worker generation/review, `omitted_question_count`, API contract, card-front notice), together with note-preview/title and tab-semantics fixes. Live probe still produced a 6/6 card; generation reliability and semantic duplicate detection remain open. See [defects, fixes and evidence](../../testing/plan-57-58-followup-2026-10-21.md).


> **2026-10-20 desktop decision, superseding the inline layout below:** The note still owns one versioned learning card, but its entry opens a dedicated full-window page. The card front presents question count/types, actual practice history, best score and stars. A missing card has working 4/6/8-question settings and an honest generation state. Answering shows one question with a persistent answer sheet, arbitrary jumps, explicit skips and saved drafts. It contains no correctness, note citations, AI explanations or companion interruptions. Submission explicitly confirms unfinished questions as skips; every question remains in the equal-weight denominator. Results begin with a skippable full-window completion celebration and the existing Live2D celebration action, followed by correct/partial/wrong/skipped review, reference answers, versioned source passages and the actual summary. Celebration acknowledges completion, including a zero-star attempt; it does not claim mastery. Motion Off and system reduced motion keep the final result and controls available. This decision introduces no global card library or review queue. The user approved implementation directly and requested newly drawn backgrounds rather than the earlier prototype images. See [implementation and verification](../../testing/learning-card-desktop-2026-10-20.md).

**Latest clarification, 2026-10-20:** “Separate page” means the independent `note-card` room destination and `LearningCardSurface`, rather than another leaf inside `NotebookDesk`. Reusing the project's visual language does not mean reusing its notebook container. The front retains normal directory navigation and the page-title plaque; the existing companion sits at bottom right. Return controls belong inside the paper at its upper left, with no external return-to-note pill or decorative stripe across the card. Practice and grading isolate the room chrome. Celebration and reports keep the normal left directory, upper-right room-control island, page heading and internal return action, with content positioned below and beside those controls. The card, report and reward papers follow the directory’s collapsed/expanded gutter and use the existing directory motion. Practice joins the question, jump sheet and footer in one board; reports join statistics, filters, details and summary in one sheet. No background blur or fog overlay is used. Celebration lights earned stars in sequence and drives the normal companion component. Earlier inline and notebook-leaf layout descriptions below are superseded.

日期：2026-10-19，Asia/Shanghai。

> 2026-10-19 用户决定：学习卡不再做独立模块或全局列表，改为每篇笔记一张学习卡，卡内多题；题目各自固定题型，不再有主观/客观切换，题干必须是明确疑问句；主观题要支持操作题（交互网页，用户操作页面元素做实践）。每张卡、每道题都必须有笔记原文依据；拓展题要给出拓展知识点文段，最多 1–2 道；允许 AI 生成拓展文段并明确标注，若生成过程联网检索必须标注网址。复习、今日学习、到期队列与催促式提醒全部取消；回看笔记即复习，改由伴星按用户意向定期提醒或生成复习/专项计划。用户同时要求审计并移除“闲功能”，本软件不养闲功能。
>
> **2026-10-19 追加决定：旧链路完全抛弃，先整条移除，再搭建新链路。** 不保留 `learning_runs`/`objective`/`note round`/`validation`/旧 card/review 引擎，不做双轨、不做兼容层。学习卡、复习/今日、首次验证、「这一轮学习」、旧卡生成、旧卡库和旧作答/评分引擎全部删除；星图、笔记架、伴星统计与搜索等旧链消费者同步改接新学习卡/笔记数据。新建的学习卡不得 import 旧 objective/card/review/learning-run 模块。
>
> 本方案取代 [41](./41-note-companion-learning-experience-2026-09-28.md) 中关于长期复习、学习卡独立入口与卡库、「这一轮学习」以及旧作答/评分链路的安排，以及原 39 系列中复习队列、今日学习、学习卡列表的产品安排。41 的笔记正文、速看、回想、往外学、批注、学习记录与版本规则继续有效；本方案只改学习卡、复习/今日、这一轮学习与旧作答/评分引擎。

## 1. 用户这次确认的体验

用户要的是一条更短的学习路径：**打开一篇笔记，读它，做这篇的练习，看到自己练成了什么样。** 学习卡不是另一款产品，也不是一个需要先进入的卡库；它属于这篇笔记。

- 一篇笔记只有一张学习卡；卡里有多道题，题量默认 6，可选 4 或 8。
- 每道题在生成时定死一个题型；没有“主观题/客观题”总开关，也不允许在同一道题里切换。
- 题干要让人一眼知道在问什么；陈述句、“请回忆原文”这类题不算合格。
- 主观题里要有操作题：用户操作网页元素完成一个具体任务，而不是只打字。
- 每道题都要有笔记原文依据；拓展题还要有拓展知识点文段，不能空口出题。
- 学完一次，卡点亮；星级按整卡得分给，满星五颗；可以多次答题，取最佳一次。
- 没有复习队列、到期数、连续打卡、每日催促；回看笔记就是复习。伴星可以按用户意向提醒或生成复习/专项计划。
- 不养闲功能：重复入口、失效页面和没有证据的功能要删掉。

## 2. 产品模型

### 2.1 一篇笔记一张卡

| 概念 | 定义 |
| --- | --- |
| 学习卡 | 一篇笔记的一套练习；同一篇笔记同一版本至多一张有效卡 |
| 题 | 卡内的一道题；题有固定题型、题干、答案/评分、依据 |
| 作答 | 一次完整答题；一次作答可以多次重做 |
| 得分 | 一道题 0–100；整卡得分为题分等权平均 |
| 星级 | 整卡得分映射到 0–5 星；取最佳一次完整作答 |
| 点亮 | 至少完成一次完整作答；0 星也算点亮 |

学习卡的数据归属不离开笔记：从笔记页的「学习卡」入口进入独立整窗页面；笔记封面保留轻量星级标记。没有全局卡库和首页卡列表。

### 2.2 卡的状态

| 状态 | 条件 | 界面 |
| --- | --- | --- |
| 未开始 | 没有已完成的作答 | 空心星、暖灰卡面、主按钮「开始学习」 |
| 进行中 | 有一次作答尚未完成 | 卡片边缘微亮、显示「2/6」、主按钮「继续作答」 |
| 已点亮 | 至少一次完整作答 | 实心星、显示「最佳 4★」、主按钮「再练一次」 |
| 旧版 | 笔记在卡生成后又保存了新版本 | 卡面标「基于 v3」；可继续练旧版，或按新版更新 |
| 生成失败 | 生成任务失败或有效题不足 | 说明原因、重试；不生成半张卡 |

不显示“掌握度”“已掌握”“待复习”这类词。星级只表示这张卡这次练习的得分，不冒充考试成绩或掌握度。

### 2.3 星级

| 整卡得分 | 星级 |
| --- | --- |
| 90–100 | 5★ |
| 75–89 | 4★ |
| 60–74 | 3★ |
| 40–59 | 2★ |
| 1–39 | 1★ |
| 0 | 0★ |

- 卡分 = 所有题得分的等权平均，四舍五入到整数。
- 星星取**最佳一次完整作答**；重练低分不降星，历史里仍保留每次成绩。
- 0★ 也点亮，显示「已尝试」和「再练一次」；星槽全暗，完成庆祝不增加未获得的星级。
- 只有完整作答才产生星级。未答完、批改失败、中途退出都不算一次完整作答。
- 笔记改版后，旧卡与旧星保留为历史；新版本重新生成一张卡，不继承旧星。
- 不设排行榜、不设连续打卡、不设每日重置、不与其他用户比较。

### 2.4 题量与题型

- 默认 6 题；可选 4 或 8 题。
- 题型池：单选、多选、判断、填空、简答、排序、匹配、操作。
- 每张卡按内容混排，至少 3 种题型；不要求每张卡都出现全部题型。为了凑题型而出烂题，比少一种题型更糟。
- 拓展题最多 1–2 道；没有合格拓展文段就出 0 道，改出原文题。
- 生成选项只保留「题量」；不再让用户勾选题型、详略、主观/客观。题型由内容决定。

## 3. 题干与依据

### 3.1 题干规则

- 题干必须是明确的疑问句（以 `？` 结尾），或操作题的明确任务指令。
- 必须让读者知道问的是哪个对象、要做什么；不能只写“请回忆原文”“说说你的理解”。
- 陈述句、新闻式标题、没有任务的空泛题一律不合格。
- 选择题的选项必须是同一维度的候选答案；不能把不同题型混在一道题里。
- 操作题要有目标状态、可操作区域和完成条件；不能只是“点一点看看”。

示例：

| 不合格 | 原因 | 合格 |
| --- | --- | --- |
| 秦统一后统一度量衡。 | 陈述句，没有提问 | 秦统一后为什么要把度量衡也统一起来？ |
| 请回忆原文关于统一度量衡的内容。 | 指向空泛，答什么算对不清楚 | 根据第 12 段，统一度量衡给赋税和工程带来了哪两个直接好处？ |
| 说说你的理解。 | 没有对象和判据 | 如果把度量衡换回六国旧制，秦的赋税征收会先在哪一步出问题？ |
| 点击页面。 | 没有目标 | 把左边的四项措施拖到右边对应的治理目标下，使四项都匹配。 |

### 3.2 依据结构

每道题都必须带 `grounding`：

```ts
type CardQuestionGrounding = {
  note: Array<{
    blockOrdinal: number;
    quote: string;
  }>; // 至少 1 条
  extension?: {
    kind: "existing_source" | "ai_generated" | "web";
    title: string;
    quote: string; // 拓展知识点文段截取，必填
    relation: string; // 这段和本题的关系
    url?: string; // kind = web 时必填
  };
};
```

规则：

- `note.quote` 必须能在该 `noteVersionId` 的正文里核对到；允许规范化空白、标点和引号，不允许改写原意。
- 引文可以跨段，但必须给出起止段落；界面上回到原文时定位到第一段。
- 拓展题必须同时有原文依据和拓展文段；不能只有拓展文段。
- 拓展文段允许 AI 生成，但界面必须标「AI 补充」；如果生成过程联网检索，`kind=web` 且必须带网址；没有网址就按 `ai_generated` 展示，不能伪装成来源。
- 选项、答案、评分标准必须能由 `note` 或 `extension` 支撑；生成后做一致性校验，不合格重试或丢弃该题。
- 作答记录存一份依据快照；笔记改版后旧卡仍能回看当时的依据。

### 3.3 生成闸门

生成结果必须逐题通过以下检查，任何一项失败都不能静默放过：

1. 结构：符合题型 schema；选项/答案/评分字段齐全。
2. 题干：疑问句或操作任务指令；不是空泛回忆。
3. 原文：至少一条 `note.quote`，且能在笔记版本中定位。
4. 拓展：`extension.quote` 非空；`kind=web` 时有 `url`；AI 生成有明确标记。
5. 一致性：答案能由依据支撑；选择题正确项唯一；判断题命题明确；简答题 rubric 可判。
6. 类型：整卡至少 3 种题型；拓展题不超过 2 道。
7. 去重：同一卡内不能有两道题问同一个点。

校验失败时先重试一次；仍失败则丢弃该题，并在卡上报告“有 N 道题未通过校验，没有收录”。有效题少于 4 道时整卡生成失败，不落半张卡。

## 4. 界面与流程

### 4.1 笔记页

笔记页保留现有正文、速看、回想、往外学、记录；新增/替换「学习卡」页签。页签里只有一张卡：

```text
┌────────────────────────────────────────────┐
│ 学习卡 · 6 道题                 最佳 4★    │
│ ★★★★☆                                    │
│ [开始学习]  [再练一次]       基于 v3        │
├────────────────────────────────────────────┤
│ 1  单选  秦统一后为什么先统一度量衡？  ✓   │
│ 2  简答  统一度量衡对赋税有什么影响？  ◐   │
│ 3  操作  把四项措施拖到对应目标下      ○   │
│ ...                                        │
└────────────────────────────────────────────┘
```

- 没有卡：显示「为这篇生成学习卡」和一句“会从这篇的原文出 6 道题，每题都能回到原文”。
- 有卡：卡头显示题量、最佳星级、开始/继续/再练；下面列出题目与上次结果。
- 笔记封面/页头只显示轻量标记：`学习卡 · 4★`；点它进学习卡页签，不新开全局页面。
- 笔记有未保存改动时，生成前先让用户选择使用已保存版本或保存后生成；沿用现有速看/回想的版本规则。

### 4.2 答题

- 一次只展示一道题；顶部显示「第 2/6 题」，答题卡支持自由跳转和跳过，不显示倒计时。
- 每题只出现该题型的控件：单选/多选/判断/填空/排序/匹配/简答/操作；没有题型切换。
- 整卡提交后统一批改；客观题按固定规则判分，不调用模型，简答题由伴星批改，操作题由可信宿主按目标状态判分。页面显示「伴星正在给你批改这张卷子…」；批改失败明确说「这次没批完」，允许重试，不按 0 分算。
- 作答过程中不显示依据、解析或正误。交卷后的逐题结果可展开原文引文、段落号；拓展题再加「AI 补充/来源」、文段截取、网址（如有）。
- 全部批完先生成总评，再显示结果纸：整卡得分、星级、总评、每题得分、依据、重练、回笔记。
- 重练是整卡重做；低分不降星；历史保留每次得分。
- 退出未完成时保留进度；下次从断点继续，不把未完成当一次成绩。

### 4.3 结果

- 卡面点亮，星级按最佳成绩更新；结果先进入可立即离开的全屏庆祝页，依次点亮本次获得的星级，配合纸花、奖章和伴星庆祝。Off 与减少动态直接展示最终结果。
- 结果显示「最佳 4★ · 本次 3★」；0★ 时显示「已尝试 · 再练一次」，不写“失败”。
- 总评放在分数下面，覆盖整张卷子（客观题和主观题）：说这次哪里稳、哪些题丢分、下一步练什么；不写“已掌握/未掌握”。
- 每题结果可点开依据和反馈；答错时反馈指回具体原文或拓展文段。
- 操作题可重开当时的操作页面，只读回看用户的操作结果。

### 4.4 笔记改版

- 卡生成后笔记保存了新版本：卡标「基于 v3 · 笔记已更新」。
- 用户可继续练旧版；旧星保留为旧版历史。
- 选择「按新版更新」时，用新版本重新生成一张卡；旧卡历史仍可查，不把旧星继承到新卡。
- 不自动用新版本覆盖旧卡；用户主动选择。

## 5. 数据模型

### 5.1 新表

```sql
note_learning_cards (
  id uuid primary key,
  workspace_id uuid not null,
  note_id uuid not null,
  note_version_id uuid not null,
  status text not null,              -- active | stale | archived
  generated_from_run_id uuid null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
-- 同一 note 同一 version 至多一张卡；同一 note 至多一张 active；旧版 stale 可多张
create unique index ... on note_learning_cards(workspace_id, note_id, note_version_id);
create unique index ... on note_learning_cards(workspace_id, note_id)
  where status = 'active';

note_learning_card_questions (
  id uuid primary key,
  card_id uuid not null references note_learning_cards(id),
  ordinal int not null,
  question_type text not null,       -- single_choice | multi_choice | true_false |
                                     -- fill_blank | short_answer | ordering |
                                     -- matching | operation
  stem text not null,
  options jsonb null,
  answer jsonb null,
  rubric jsonb null,
  grounding jsonb not null,          -- note[] + extension?
  operation_artifact_id uuid null,
  created_at timestamptz not null
);

note_learning_card_attempts (
  id uuid primary key,
  card_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  status text not null,              -- in_progress | grading | completed | grading_failed | abandoned
  score int null,                    -- 0..100
  stars int null,                    -- 0..5
  summary jsonb null,                -- 总评；null = 未生成或生成失败
  started_at timestamptz not null,
  completed_at timestamptz null
);

note_learning_card_answers (
  id uuid primary key,
  attempt_id uuid not null,
  question_id uuid not null,
  answer jsonb not null,
  score int null,                    -- 0..100
  feedback jsonb null,
  grounding_snapshot jsonb not null,
  used_hint boolean not null default false,
  graded_at timestamptz null
);
```

- 逐题答案、反馈、依据快照都留；旧的作答不覆盖。
- “最佳星级”不落冗余列，按 attempt 的 `max(score)`/`max(stars)` 聚合；需要索引 `(card_id, user_id, completed_at)`.
- 操作题的 HTML 复用 `note_learning_artifacts`，新增 owner kind `card_question`；答案状态落在 `note_learning_card_answers.answer`。
- 学习卡作答/评分走新的 `note_learning_card_attempts`/`note_learning_card_answers`，**不复用** `learning_runs`/`learning_assessments`。
- 动态讲解/互动演示继续使用 `note_learning_artifacts`（它不存作答）；旧首次验证（validation）与「这一轮学习」的旧 run/assessment 引擎整条删除，不在新链中保留。

### 5.2 旧链路：整条删除

本方案不做兼容层，也不保留“给旧功能用”的例外。以下全部删除，删完再搭新链：

- **旧学习卡/目标**：`learning_objectives_v2`、`learning_objective_revisions_v2`、`learning_objective_origins_v2`、`learning_cards_v2`、卡曝光账本。
- **旧卡生成**：旧 card-generation runs/plans/candidates 及其 worker handlers、prompts、activation、审核页。
- **旧作答/评分引擎（旧 assessment 表）**：`learning_runs`、`learning_tasks`、`learning_artifacts`、`learning_assessments`、`learning_run_events`、`learning_run_action_ledger`；`LearningRunSurface`/`LearningRunBody`；`validation` 与首次验证。
- **这一轮学习**：`note_learning_rounds`、`note_learning_round_artifacts` 及 round routes/IPC/UI/history；相关 CSS、测试与文案。
- **复习/今日**：`review_schedules`、`objective_review_holds_v2`、`review_subscriptions_v2`、`daily_review_batches_v2`、`home_suggestion_dismissals_v2`、`initial_validation_reminders_v2`；review/learning-dashboard/today 的 routes、IPC、worker jobs、通知。
- **旧 UI/入口**：全局卡库/卡详情、review、study/today、今日批次、首页建议、未完成学习页、validation、round、assessment dispute；DirectoryRail/Home 的对应入口。
- **旧合同/消费者**：objective/card/review/learning-run/note-round 的 shared contracts、desktop IPC、companion tools/page destinations、搜索类型、统计字段、项目投影字段。

保留：

- `note_learning_artifacts`（动态讲解/互动演示，不存作答）、笔记/来源、速看/回想/往外学/批注、学习记录（去掉 round 记录）、搜索、设置、伴星。
- 星图保留，但节点/边改接新学习卡与笔记，不再读 objective/review；未接完前只显示笔记/来源节点，不显示旧“理解恒星”。

数据：项目未发布，旧卡/复习/轮次/作答数据不迁移；开发库清空后按新模型重新生成。若需要保留某次真实样本，先导出留档，不做双写。

**防回流**：新 `learning-card` 模块不得 import 旧 objective/card/review/learning-run/note-round/validation 模块；删完后由 import guard 与目录守卫扫描，CI 红即视为回流。旧模块名不再保留为兼容出口。

## 6. 接口

### 6.1 新接口

```text
GET    /v2/notes/:noteId/learning-card
POST   /v2/notes/:noteId/learning-card/generate
POST   /v2/learning-cards/:cardId/attempts
POST   /v2/learning-cards/:cardId/attempts/:attemptId/answers
POST   /v2/learning-cards/:cardId/attempts/:attemptId/complete
GET    /v2/learning-cards/:cardId/attempts
GET    /v2/learning-cards/:cardId/questions/:questionId/artifact
```

- `GET learning-card` 返回卡、题、最佳星级、最近一次成绩、当前进行中的 attempt。
- `generate` 幂等：同一笔记同一版本已有 active 卡时返回已有卡；生成中返回冲突状态，不另开一批。
- `attempts` 开始一次作答；`answers` 逐题提交（客观题可即时判，主观/操作题提交后判）；`complete` 结算整卡得分与星级。
- 所有写接口走现有权限、workspace epoch、commandId 与 AI 外发同意门禁。

### 6.2 删除的接口

- `GET /v2/learning-objectives`、`GET /v2/cards`、objective 详情/激活接口。
- 旧卡生成 `note.cardGeneration.*` 与 card-generation-v2/v3 routes、worker jobs、候选/激活接口。
- `learning-runs` 全套 routes 与桌面 IPC `learningRun.*`；`validation` 入口。
- `note-learning-rounds` 全套 routes/IPC 与 round 历史。
- `GET /v2/reviews/queue`、defer、hold/resume、subscription、one-time reminder。
- `learning-dashboard` 的 today/home suggestion/today batch/action。
- `activity/today`（若只服务今日学习页；伴星动态另走 companion activity）。
- companion `companion_list_due_reviews`、`companion_open_page` 的 `review` 目标、round/validation 页面目标。
- 桌面 IPC `objective.*`、`review.*`；这些名称不保留兼容别名。

## 7. 生成管线

### 7.1 输入

- 已保存的笔记版本（`noteVersionId`）与全篇正文块。
- 笔记关联的来源片段。
- 已收下的「往外学」记录（若存在）。
- 用户选择的题量（4/6/8）。
- 没有“主观/客观”“策略勾选”输入。

### 7.2 输出

一次生成产出一张卡：

```json
{
  "questions": [
    {
      "type": "single_choice",
      "stem": "秦统一后为什么要把度量衡也统一起来？",
      "options": ["..."],
      "answer": { "correctOptionId": "..." },
      "grounding": {
        "note": [{ "blockOrdinal": 11, "quote": "..." }]
      }
    },
    {
      "type": "short_answer",
      "stem": "统一度量衡给赋税和工程带来了哪两个直接好处？",
      "rubric": { "...": "..." },
      "grounding": {
        "note": [{ "blockOrdinal": 11, "quote": "..." }],
        "extension": {
          "kind": "ai_generated",
          "title": "秦制与度量衡",
          "quote": "……",
          "relation": "补充说明统一度量衡与赋税征收的关系"
        }
      }
    }
  ]
}
```

### 7.3 生成约束

- 默认 6 题；有效题 4–8 道；至少 3 种题型。
- 拓展题最多 2 道；没有合格拓展文段就 0 道。
- 题干疑问句/任务指令；不能用陈述句或空泛回忆。
- 每题至少 1 条原文引文；引文必须能定位。
- 答案必须能由引文或拓展文段支撑；选择题正确项唯一。
- 生成后做结构、题干、依据、一致性、去重五项检查；失败重试一次，仍失败则丢弃并报告。
- 生成过程可见进度；失败有明确原因；不静默用半成品覆盖旧卡。
- 生成完成后直接写入这篇笔记的学习卡，不逐题候选审核；不满意可重新生成，旧卡历史保留。
- 模型调用预算按现有 Agent 上限处理，不设新的硬截断；长笔记分段读取，但生成只输出题卡，不复制全文。

### 7.4 拓展文段与联网

- 先尝试从笔记关联来源和已收下的往外学记录中取文段；有则 `existing_source`。
- 没有可引用文段时，允许模型生成 `ai_generated` 文段，明确标「AI 补充」。
- 如果模型在生成过程中联网检索，必须保存使用的网址与片段，`kind=web`；没有网址就不要写成 web。
- 联网失败时退回 `ai_generated` 或不出拓展题；不能伪装成已验证来源。
- 界面上 AI 补充与真实来源分开；`web` 可点开网址，`ai_generated` 不提供假链接。

## 8. 批改、总评与星星

### 8.1 批改顺序

1. **客观题**（单选、多选、判断、填空、排序、匹配）提交即判，直接出分，**不调用模型**。
2. **操作题**按模板检查，服务端按期望状态判分；只有确实需要语义判断时才调用模型。
3. **简答/需要语义判断的操作题**在全部题目提交后由伴星批改；页面显示「伴星正在给你批改这张卷子…」。批改失败显示「这次没批完」，可重试，不按 0 分算，也不产生星级。
4. 所有题批完，算卡分与星级。
5. 生成**总评**（覆盖全部题，含客观题），再显示结果纸。

### 8.2 题型评分

| 题型 | 评分 |
| --- | --- |
| 单选 | 正确 100，错误 0 |
| 多选 | 正确选中/应选总数 − 错选/不应选总数，clamp 0–100；全对 100 |
| 判断 | 正确 100，错误 0 |
| 填空 | 每个空按规范化答案匹配；按空数平均 |
| 简答 | rubric 0–100；由伴星按 rubric 批改，返回分数与反馈 |
| 排序 | 位置正确数/总项数 × 100 |
| 匹配 | 正确配对/总配对数 × 100 |
| 操作 | 模板检查 0–100；服务端按期望状态判分，不相信 iframe 自报分数 |

- 简答/操作题的 rubric/检查必须至少有一个可判据；没有判据的题不准生成。
- 客观题的答案在生成时定死；批改时不再让模型重判。
- 用到提示的题可以记录 `used_hint`，但不扣分；学习卡是练习，不是考试。结果页可以显示“用过提示”。
- 批改失败：attempt 进入 `grading_failed`，不产生星级；用户可以重试，不按 0 分算。

### 8.3 总评

- **总评覆盖整张卷子，包括客观题和主观题**：客观题的正误、得分、错题点，和主观题的批改反馈一起进入总评；不是只评主观题。
- 客观题已经直接判分，不叫模型重判；它们的得分和错题仍作为总评输入。
- 总评由伴星在全部题批完后生成：这次哪里稳、哪几道客观题丢了分、主观题哪里没答到、下一步练什么。不写「已掌握/未掌握」，也不冒充考试成绩。
- 低分/0★ 不训斥，只指出一两个可改的点。
- 总评失败不挡星级：先显示分数、星星和每题结果，总评位置给「重试总评」。
- 总评存在 `note_learning_card_attempts.summary`；历史里的总评可回看。

### 8.4 整卡

- 卡分 = 所有题得分的等权平均，四舍五入。
- 一次作答只有在所有题都有答案或明确跳过时才可 `complete`；跳过题按 0 分并在结果里标明。
- 星级按第 2.3 节映射；取最佳一次完整作答。
- 结果页显示本次得分、最佳星级、每题得分、总评；历史页显示每次日期、得分、星级、总评。

## 9. 操作题

### 9.1 第一版模板

第一版只做受控模板，不开放自由生成整页 HTML：

1. **排序/流程**：把步骤拖到正确顺序；复用现有排序题的判分。
2. **匹配/连线**：把概念和目标配对；复用现有匹配题。
3. **参数实验**：拖动 2–3 个滑杆或选择参数，把系统调到目标状态；模板检查目标值。
4. **修复**：在页面里点出错误项或替换错误步骤，使结果正确。

模板由我们维护；模型只填内容（题干、选项、初始状态、目标状态、依据），不生成脚本。后续再看是否允许模型生成整页 HTML。

### 9.2 通信与安全

```text
host -> iframe: { type: "astella.card.question", nonce, spec, grounding }
iframe -> host: { type: "astella.card.answer", nonce, value }
host -> iframe: { type: "astella.card.result", score, feedback }
```

- iframe 继续使用现有 `astella-app://artifact` 沙箱与 `sandbox="allow-scripts"`。
- host 校验 `event.source === iframe.contentWindow`、nonce、消息形状；只接收答案状态，不接收分数。
- 分数由 host 按 `spec.expected` 计算；模板不能自报分数。
- 操作题必须有键盘操作、焦点可见、减少动态下可用；不设倒计时。
- 操作 HTML 存在 `note_learning_artifacts`，owner kind `card_question`；作答记录只读回放。

## 10. 复习/今日的摘除

### 10.1 用户可见面

删除：

- DirectoryRail 的「今日学习」「复习」「学习卡」；保留首页、来源、笔记、星图、搜索、伴星、设置。
- Home V2 的 `today-review`、`continue`（今日学习）、`current-target`（学习卡）；书桌岛改成「继续这篇/查看学习卡」，不显示到期数和每日重置。
- `StudySurface`、`TodayBatchSurface`、`HomeSuggestionCard`、`ReviewSurface` 及其 CSS/路由。
- 首页到期数、复习通知、复习徽章、`R` 快捷键、设置里的 R 说明、引导里的今日/复习话题、搜索里的学习卡类型、学习记录里的学习卡/round 入口。
- `ResumableSurface`（未完成的学习）单独页面；需要时只保留笔记/首页的「继续这篇」。
- 笔记页的复习订阅、目标挂起/恢复块。
- **这一轮学习**：笔记页的 `learning` leaf、`RoundDeskLine`/`NotebookRoundRecap`/round artifact/round history 与「学这篇笔记」入口；`LearningRunSurface`/`LearningRunBody`；round 相关 CSS/测试。
- **首次验证/validation**：`ValidationSurface`、首页/学习页/伴星路由里的 `validate` 入口、`AssessmentDisputeStrip`；旧 `learningRun.*` UI 与合同。
- 旧卡生成/候选审核页 `CardGenerationSurface` 与旧卡入口；由新的笔记内学习卡生成替代。

### 10.2 写入与接口

- 旧链整条停写：卡片激活、作答结算、笔记轮次、validation、复习排期不再产生新记录。
- `learning_runs`/`learning_artifacts`/`learning_assessments`/`note_learning_rounds`/`review_schedules` 等表在客户端摘除、回归通过后直接删除；不保留双写。
- 所有返回合同改为 `note.detail` 或 `room.home`；不再有 review.queue/round/validation 落点。
- companion 的 `companion_list_due_reviews`、`allowNudgeLearning` 到期数、review/round/validation page destination 全部移除。
- 统计里的 `reviewsDue`、objective/round 计数从 UI 移除；相关统计口径改接新学习卡的作答历史。
- 旧 runner/worker job 与 outbox 类型停止注册；旧 handler 文件删除，不保留 feature flag。

### 10.3 伴星计划

复习不再有队列，但“定期提醒/按意向生成计划”要有落点：

- v1：伴星在用户明确要求（“帮我安排这周把这几个练习过一遍”）或合适的主动机会里，读取笔记与新学习卡的作答历史，提出一份计划（哪几篇、哪几张卡、什么时候、做几次）。
- 计划以现有长期目标/提醒承载；用户接受后生成具体提醒或卡片入口，不生成到期数/徽章。
- 不接受、忽略、改期都不产生催促；伴星最多在合适的对话里提一次。
- 不读旧 `learning_runs`/objective/round/review 表；计划的数据源只有笔记、学习卡、作答历史与用户明确意向。
- v2：若目标/提醒承载不了计划项，再建 `companion_study_plans`，不在本轮先造一套空计划系统。

## 11. 闲功能清理

这一轮删：

- 复习、今日学习、今日批次、首页建议、到期数/通知、`R` 快捷键。
- 全局学习卡库/详情、rail 学习卡、学习记录里的学习卡入口、搜索学习卡类型。
- 未完成的学习页。
- **这一轮学习**与首次验证/validation：旧 run/objective/round/assessment 引擎、页面、IPC、worker job、测试。
- 伴星中心「动态」页并入「近况」：近况里保留待处理/最近动态的展开入口，不再单独占一个 tab。
- 只服务上述页面的 routes、IPC、worker job、CSS、测试与死代码。

不动：

- 书房、伴星、笔记、来源、搜索、设置、速看、回想、往外学、批注、学习记录（去掉 round 记录）。
- 星图保留，但节点/边改接新学习卡与笔记；未接完前只显示笔记/来源节点，不显示旧“理解恒星”。
- 发现簿属于伴星差异化能力；没有使用证据前不删，下一轮单独审计。

## 12. 实施顺序

### 阶段 0 · 旧链硬删除（先做）

- 删除 §5.2 列出的全部旧表、routes、IPC、worker jobs、contracts、UI、CSS、测试：旧卡库/卡生成、review/today、首次验证、这一轮学习、旧 run/objective/assessment 引擎。
- 笔记页「学习卡」入口先隐藏，不留下点不开的按钮；首页/rail/设置/搜索/引导/通知同步去掉旧入口。
- 星图先只保留笔记/来源节点；笔记架去掉 objective/review 状态；伴星统计去掉 review/round/objective 口径。它们暂时少一块，但不再读旧链。
- 删旧数据表；开发库清空后重新生成。不建双写、不建兼容别名。
- 加 import guard：新 `learning-card` 目录不得 import 旧 objective/card/review/learning-run/note-round/validation 模块；CI 扫目录与合同名。
- 验收：全量类型检查/构建通过；应用无死入口；旧表和旧路由不再注册；星图/笔记架不崩；旧链无 import。

### 阶段 1 · 新卡合同与数据模型

- 新增 §5.1 的四张表与 shared 合同、desktop IPC、API 路由；不接 UI。
- 抽取卡分/星级纯函数、题型 schema、依据 schema 与生成闸门；测试边界。
- 验收：迁移可在空库/开发库执行；星级/题型/依据合同测试全绿；旧表不再被引用。

### 阶段 2 · 笔记内学习卡 v1

- 笔记页「学习卡」页签重新上线；生成、作答、结果、重试、版本状态。
- 生成接固定题型、疑问句题干、原文/拓展依据、最多 1–2 道拓展题。
- 星级/最佳一次/0★/按版本保留全部接通；不接复习/今日。
- 验收：一篇笔记只有一张卡；4–8 题；固定题型；每题有依据；星级规则通过；全局无卡库入口。

### 阶段 3 · 操作题

- 受控模板与 host 判分；iframe 消息协议；只读回放。
- 验收：排序/匹配/参数实验/修复四类中至少两类真实窗口可完成；键盘、减少动态、失败恢复通过。

### 阶段 4 · 旧链消费者改接与清理

- 星图改接新学习卡/笔记节点（“理解恒星”= 新卡题目或卡，状态=点亮/星级/作答历史，不再有 due/objective）。
- 笔记架改接新卡星级；伴星统计/搜索/首页投影去掉旧 objective/review/round 口径，改接新卡历史。
- 伴星计划 v1（目标/提醒承载）；未完成学习页、动态 tab、旧死代码清理。
- 验收：星图/笔记架/伴星统计不再读旧表；无到期数/徽章/每日催促；伴星能按用户意向提出计划；全量类型检查与相关套件通过。

### 阶段 5 · 文档与终验

- 更新 PRODUCT/DESIGN/41 冲突段、README/AGENTS；删除旧链遗留文档引用。
- 真实窗口验收与全量套件；记录未验项。

## 13. 验收

### 13.1 纯函数与合同

- `starsForScore`: 100/90→5, 89/75→4, 74/60→3, 59/40→2, 39/1→1, 0→0.
- 最佳尝试：2★→4★ 取 4★；4★→2★ 仍 4★。
- 0★ 完整作答算点亮。
- 旧版本卡不继承新版本星级。
- 缺原文引文、拓展文缺文段、`kind=web` 缺 URL、陈述句题干：生成闸门拒绝。
- AI 补充/来源/网址的界面标记正确。
- 题型评分：多选部分分、排序/匹配部分分、简答 rubric、操作 host 判分。
- 客观题批改不调用模型；简答题/需要语义判断的操作题走批改模型。
- 批改失败不产出星级，可重试。
- 总评输入包含所有客观题的正误/得分/错题点，以及所有主观题反馈；全客观题卡也必须生成总评，不能跳过。
- 总评失败不挡分数/星级，显示「重试总评」。

### 13.2 集成

- 生成一张 6 题卡：4–8 题、至少 3 种题型、拓展≤2、每题有依据。
- 完成一次作答：客观题立即出分；有简答题时显示「伴星正在给你批改这张卷子…」，批完生成总评；全客观题卡也要生成总评并点出客观题错项；整卡得分/星级正确；重练后最佳星级不降。
- 笔记改版：旧卡标旧版；新卡重新生成；旧星保留历史。
- 旧链清空：旧卡库/卡生成、复习/今日、首次验证、这一轮学习、旧 run/objective/assessment 全部不可达；无旧表/旧路由/旧 IPC 注册；无死入口。
- 回流守卫：新学习卡模块 import 图不含旧 objective/card/review/learning-run/note-round/validation；旧模块名没有兼容出口。
- 星图/笔记架/伴星统计：不再读旧 objective/review/round；星图先只显示笔记/来源，改接后显示新卡节点；笔记架显示新卡星级。
- 闲功能：未完成学习页不可达；动态并入近况；星图/发现簿仍可达。
- 操作题：iframe 不能自报分数；host 校验 nonce/source；键盘可完成。

### 13.3 真实窗口

- 1440×810、1280×720、125%/150%/200% 缩放。
- 笔记页学习卡、开始/继续/结果/重练、依据展开、回到原文。
- 0★、旧版、生成失败、批改失败、断网/来源失败。
- 减少动态/Off：星星不闪烁、不循环；焦点可见。
- 伴星在场时卡面与角色不互压；窄窗重排。

## 14. 风险与边界

- **生成质量**：6 题一次生成比单卡更难；先保证题干和依据，宁可 4 题合格，不交 8 题凑数。
- **延迟**：固定题型+依据校验会增加生成时间；进度可见，失败可重试，不设新的硬截断。
- **AI 拓展幻觉**：允许 AI 补充，但必须标注；没有网址不冒充来源。无法核对的拓展题宁可不收。
- **中文引文核对**：沿用现有引文核对规则；标点/空白规范化，不改写原意。
- **操作题安全**：第一版只做受控模板；iframe 只回传状态，host 算分；不开放模型自由生成脚本。
- **旧链路硬删除**：旧 run/objective/round 被卡片激活、作答结算、复习排期、星图、笔记架、伴星统计共同使用；按依赖图从外向里删，删完保证应用可启动、无死入口。不要留兼容别名，否则新代码会回流。
- **临时功能缺口**：首次验证与「这一轮学习」会先消失，学习卡页签在阶段 2 前隐藏；这是硬切换的代价。星图先只显示笔记/来源，笔记架先不显示旧 objective 状态。
- **星图/笔记架改接**：它们原来读 objective/review，必须改接新卡/笔记；未改完前宁可少一块，不能偷偷保留旧表。
- **数据清理**：项目未发布，旧卡/复习/轮次/作答数据不迁移；开发环境重新生成。若需要样本，先导出留档。
- **伴星计划**：v1 只做目标/提醒承载，不先造一套计划系统；避免“取消复习又长出一套每日任务”。
- **星级语义**：星级是练习成绩，不是掌握度；不得在文案、统计或伴星口中说成“已掌握”。

## 15. 文档同步

- 本方案登记到 [README](./README.md) 与仓库根 [AGENTS.md](../../../AGENTS.md) 的现行入口。
- 实施时同步更新 `PRODUCT.md` 的学习卡/复习/今日/这一轮学习/validation 段落、`DESIGN.md` 的对应段落，以及 41 中与本方案冲突的卡片/复习/轮次/作答描述。
- 41 的笔记正文、速看、回想、往外学、批注、记录（去掉 round 记录）与版本规则继续有效；56 的伴星主动交流继续有效，新增“计划”只作为伴星能力，不恢复催促式学习。
- 星图、笔记架、伴星统计的旧 objective/review/round 口径在实施阶段 4 一并改接新卡；文档同步写明“不再读旧表”，避免下一轮又接回去。

## 16. 实施记录（2026-10-20）

### 16.1 硬切换已完成的部分

- **旧链路删除**：`apps/api/src/modules` 下的 `learning-runs / learning-objectives / card-generation-v2 / review / note-learning-rounds / learning-dashboard / understanding(projection) / stats`、`modules/activity`，客户端 `surfaces/run` 旧 UI、`surfaces/review` 旧审核件、全局卡库与今日日志、worker 的 `card-generation-v2/v3` 与对应 handler，以及它们的契约测试与集成测试。
- **表**：`0449_retire_learning_card_chain.sql` 一次删掉 objectives/revisions/origins/cards、候选与生成批次、证据快照族、review_schedules 族、learning_runs/tasks/artifacts/assessments/outbox、note_learning_rounds 族、validation_assistance_exposures、personal_relation_decisions_v2。同时把 `agent_operations` 的执行体收成只剩 `job` 一支，并重写恢复/取消两个 SQL 函数。
- **Agent 能力**：`card_generation_generate` 从 shared 能力目录、agent-host、worker 执行器与 API 直连路径一并移除；agent 不再能写旧制卡 run。
- **搜索/导出/onboarding/邀请/来源统计**：都改到新链 —— 搜索类型只收 `note|source`；导出只带 `note_learning_cards`（按笔记可见性）；`first_card` 查笔记活卡；来源行只报活卡数。
- **星图**：拓扑合同只保留 `source / note / card_question`，边只保留 `contains_note / contains_question / references`；关系表态、objective/evidence 节点、learning_run 分支整条移除。层二「配套练习」与层三「练习记录」读新卡三张表。
- **笔记架**：`noteShelfLearningFactsV1` 增加 `hasCard / bestCardStars`，新增 `practiced` 档与「学习卡最好 N 星」副签。
- **伴星**：环境块去掉 activeRun/到期复习，学习统计只报今日/本周分钟、卡数、笔记数；到期列表、任务队列、聚焦星图三件工具随旧链退役；卡片检索与「打开这张卡」改读新卡。
- **页面**：笔记页新增「学习卡」页签；设置页去掉旧学习卡计数；搜索页去掉 objective 过滤与「证据不足」开关；伴星动态页去掉「继续学习」候选段。

### 16.2 尚未完成 / 待下一轮

- **新卡 UI 的真实窗口验收**：生成 → 作答 → 批改 → 总评 → 星级这条链已在 dev 库手工跑通，但改版后的星图/笔记页/设置页尚未按 1440×810、125%/150%/200% 做真窗口截图走查。
- **死 CSS**：旧 review/run/round 的样式仍在几份样式表里；`renderer-style-dead-guard` 已把它们登记进 `KNOWN_DEAD`（409 条，含 Plan 57 说明），下一轮清理时随条目一起删。
- **伴星剩余旧词**：`companion-dialogue-content` 等处的「到期复习」识别规则与部分旧文案仍留着；它们不再接旧表，但文案/规则可再收一轮。
- **首次验证 onboarding**：`evidence_review` 步骤已从前端契约与路由移除，存量 `onboarding_states.steps` 里的旧键会在下一次派生时被覆盖。
- **构建与真窗口**：四包 typecheck 绿；桌面主进程测试 584 项全绿；渲染层 2310 项中仍有 14 项失败，集中在伴星对话/时间线/目标日志（与本轮改动无直接关系，属工作区并行改动或既存问题），需单独复核。

### 16.3 收尾复核（2026-10-20 晚）

- **新卡真实窗口**：`笔记 → 秦朝统一与中央集权制度 → 学习卡 → 再练一次`，4 题（单选/多选/简答/单选）逐题作答并核对了每题依据；批改态「伴星正在给你批改这张卷子…」之后出现整卷总评（客观题 275/300 折算 92 分、简答 80 分）与「本次 94 分 · 最佳 5 星」，最佳星级与「再练一次」保持。多选改为可多选后显式提交；题型标题显示中文；960×540、720×405 回流无横向溢出。
- **星图 / 笔记库 / 笔记详情 / 设置**：1440×810 与 125%/150%/200% 回流走查完成；星图底部统计为「全部题目 / 再练 / 没练过 / 练过」，笔记架显示「练过学习卡 · 学习卡最好 5 星」，笔记详情保留「学习卡」页签；四个页面均无「今日学习/待复习/到期复习/复习队列」旧词、无横向溢出、无 console error。
- **验证**：四包 `typecheck` 全绿；桌面构建通过；新卡共享用例 12 项（contracts / grading / operation / quality）通过。主进程 4 条 dashboard 旧用例按新投影重写为「notes+sources 构图、不请求 `/v2/learning-dashboard`、笔记读不到时如实失败」，101 项主进程用例全绿。
- **清理**：删除 5 个零引用旧组件/模块（`assessment-dispute-strip`、`candidate-review-model`、`card-generation-*`、`review-focus`、`learning-run-result-policy`、`objective-library-view-state`）及 2 个旧链测试；死 CSS 台账补 15 条（409 → 424）；首页/目录/设置等处的旧复习文案与注释同步改写；本轮的 p57 探针脚本已删除。
- **渲染层剩余红点**：10 条，全部位于用户并行编辑的伴星文件（`companion-chat-session.history-status`、`CompanionHud.interaction`、`CompanionReplyAttachments`、`companion-process-timeline`、`companion-her-notes-page`、`agent-goals-experience`），单跑仍复现；按既往归属口径记在并行改动，不并入本轮。

### 16.4 全量清收（2026-10-20 深夜）

- **旧 IPC / preload**：删除 `desktop-ipc-learning.ts` 与 54 个旧通道常量（objective / review / learningRun / noteLearningRound / assessmentDispute / cardGeneration / homeSuggestion / todayBatch / companionLearningRun），preload 对应命名空间全部移除；旧网关 `ns-learning` / `ns-assessment`、正式评估守卫、返程标记、run 事件流账本、卡生成处理器与旧类型一并删除。新卡 IPC 收进 `desktop-ipc-input-schemas.ts`。
- **共享包**：删除 `review/*`（15 份）、`card-generation-v2-pipeline`、旧 learning/card 契约与 8 份旧 db-schema；重新导出 `learning/note-learning-card-quality`。伴星活 SQL 全部改读 `note_learning_cards` / `note_learning_card_attempts`（今日小结、最近活动、卡片标签、首页里程碑、提案跳转），不再查询任何已删表。
- **工作区与依赖**：删除 `packages/card-generation` 整包、其依赖声明与 tsconfig/Docker 接线；更新 API / worker / agent-host 三份包锁，桌面端锁未动。三处本地 `@astella/shared` 改为指向源码的符号链接，避免 typecheck 对着旧副本。
- **投影与路由**：`RoomProjectionV1` 收成 `mode + recentNote + recentActivitySummary + captureCapability`；桌面 route kind 去掉 `room.today / review.queue / note.cardGeneration / learningRun.detail / objective.*`，伴星页面词表收成 7 档，页面上下文只保留 note / star_map / conversation / settings / source / other；首页 `homePresentation` 改为“接着最近一篇笔记或从一份材料开始”。
- **发布 smoke**：`smoke-packaged.mjs` 的 owner/member 旅程改为「笔记 → 打开笔记 → 学习卡 → 生成/校验 4–8 题依据」，删除 LearningRun Player、正式评估守卫、制卡审核与返程标记恢复段；笔记卡选择器按真窗口 aria-label 修正。`node --check` 通过。
- **死 CSS**：按 `KNOWN_DEAD` 的 424 个死类删除 1255 条规则 / 1408 个选择器，台账清空；`objective-flow.css` 全死，连文件一起删除。
- **伴星旧词与 HUD 元数据**：页面词表、工具组、工具描述、日记来源类型、`claimsNothingDue` 闸与环境块到期事实全部删除；`hud-pages.ts` / `room-machine.ts` / `scene-camera.ts` 里 today / queue / goals / generating / candidate / assessment / result / resumable 等不可达页与取景档一并删除，HUD 只保留 9 个现役页面（另加 4 个笔记阅读态元数据）。剩在历史迁移与归档脚本里的词不算活文案。
- **验证**：四包 typecheck 全绿；桌面构建通过；共享套件 523 项全绿；API 1965 项 0 失败；worker 1933 项全绿；桌面 2844 项中 10 项失败，全部落在并行编辑的伴星文件（history-status / CompanionHud / ReplyAttachments / process-timeline / agent-goals），与本轮改动无关。真窗口复核：首页“接着读”、笔记库、笔记详情、学习卡页签、星图、设置均正常，无 console error、无横向溢出。

**仍在路上的**（更新见 16.6）：

- **打包 smoke**：已在 16.6 真跑通过；CI 侧 macOS/Windows/Linux 的 offline-only 闸口沿用同一条脚本。
- **桌面 10 条伴星红点**：属于并行改动，需由那条工作线收口。

### 16.5 空卡自愈与生成可靠性（2026-10-20 下午）

- **现象**：打包旅程在一篇只有一句正文的测试笔记上看到「0 道题」，卡仍为 active；生成任务 `d47a411d` 以 `NOTE_OVERVIEW_OUTPUT_INVALID` 死亡。根因有三层：
  1. API 先建空卡行再入队，任务失败后空壳永久占位；`ensureNoteLearningCardRow` 见行即返回 `card_exists`，用户再也无法重生成。
  2. 生成输出偶尔把题干写成陈述句，质量闸一次判错就整轮作废（`maxAutoRetries` 默认 0）。
  3. `astella_worker` 对五张新卡表没有授权；真正落题时 `permission denied for table note_learning_card_questions`，任务重试耗尽后只剩一条泛化的输出错误。
- **修复**：
  - `readNoteLearningCard` 把 0 题活卡当作不存在，并依据是否仍有 pending/running 生成任务返回 `generating`；`startNoteLearningCardAttempt` 拒绝 0 题卡（409 `card_not_ready`）；`ensureNoteLearningCardRow` 在同版空壳且无在飞任务时删除旧壳重新建卡，命中在飞任务则返回 `generating`，生成入口据此进入等待态而不是报「已有学习卡」。
  - 生成任务改为 `maxModelCalls: 2 / maxAutoRetries: 1`（与笔记脑图生成同一口径），提示词明确要求题干出现疑问词，不只靠问号结尾。
  - `roles.sql` 补 `astella_worker` 对 cards / questions / operation_artifacts / attempts / answers 的最小授权，并登记进 worker 权限期望矩阵；API 继续走全表 CRUD。
- **验证（dev API 真调用）**：失败卡 `d008…` 首次 GET 为 `{card:null,generating:false}`；重生成返回新卡 `ec6e…`，19 秒后成功，6 题 / 6 种题型 / 6 题都有原文依据；随后走完开始作答 → 六题作答（客观题即时判分）→ 交卷 → worker 批改，历史记录 `completed`、71 分 3 星，总评包含整卷文本。
- **备注**：新卡 UI 正由并行工作线改版；本轮只确认 API 合同 `{ card, generating }`、答题回执与 `questions[].operation` 与其 hook 对齐，不在真窗口层面重复验收。

### 16.6 兼容层拆净与打包验收（2026-10-20 下午）

- **并行回滚适配**：并行工作线在 15:10 回滚了新卡 UI 改版（`card-session` / `use-note-card-session` / `card-answer-controls` 等一并删除），学习卡面板回到 14:40 的简单版。本轮没有恢复改版，而是在现行面板上重放生成自愈所需的最小状态：`generating` 态 + 3 秒轮询 + 0 题卡不给开始。打包 smoke 的判据同步改成先读卡头「N 道题」再进第一题验证依据，不再依赖已删除的选择器。
- **旧合同收口**：桌面 route schema 删除 `room.today / objective.library / objective.detail / review.queue / learningRun.detail`；namespace 删除 `objective / review / learningRun`；actionCapability 删除 `objective.read / review.read / card_generation.* / learning_run.*`；feature extras 删除 `card_generation_v2 / learning_run_v2`；gateway 事件流删除 `learning_run_changed / card_generation_changed`；navigation 去掉 `learningRunId`。能力投影同步收口：`buildDesktopCapabilityProjection` 不再读 `LEARNING_RUN_ENABLED / CARD_GENERATION_V2_ENABLED`，也不再把 `learning_objective_system_v3` 标成 enabled。
- **伴星桥合同**：`EntityRefV2` 收成 source/note/companion_journey/assistant_session；`AllowedMainRouteV2` 收成 8 个现役页面；`UiTargetRef` 去掉 `note_generate_cards / card_evidence / run_current_task`；系统事件类型收成 `journey.* / generation_job.*`。worker 里 `pageKind === "learning_run"` 的 grounded-tutor fail-closed 判据与 liveView 的 `learningRunId` 一并删除；发现来源 `learning_run` 与其 UI 标签同步移除。
- **配置与运维**：两份 compose 删除 `LEARNING_RUN_ENABLED / CARD_GENERATION_V2_ENABLED / CARD_GENERATION_V3_PROVIDER`；`verify-companion-capability-config.mjs` 的期望表与可治理键收成 `COMPANION_*`（验证通过：api 11 / worker 9）；admin overview 与 labels 去掉旧开关。`CAPABILITY_IDS` 去掉 `learning_run_companion / learning_question_markers / learning_objective_system_v3`。文档（api-and-data 中英、development 中英、feature-flag-inventory）同步改写。
- **库表**：新增迁移 `0452_retire_learning_card_leftovers` 补删漏网表（`note_learning_round_targets`、`note_learning_round_model_attempts`、`assessment_corrections_v2` + `assessment_disputes_v2`）；dev 库已执行，`review*/learning_run*/learning_objective*/card_generation*` 表全部不存在。`roles.sql` 的 worker 期望矩阵与授权清单同步删掉旧行，新卡五表的最小授权保留；`role-grants` 复跑无异常。
- **验证**：四包 typecheck 全绿；共享 523/523、worker 1932/1932、API 1963 项 0 失败（1 skipped）全绿；桌面定向 6 文件 237 项全绿（settings / notebook reading-shape / 学习卡 experience / companion-chat-session / discovery-panel / desktop-gateway / style guard）。打包链路：重建 → 打包 → `package:smoke` 真跑通过（owner 旅程覆盖 笔记 → 学习卡 → 卡头 4–8 道题 → 开始学习 → 第一题依据）。

- **最终复核（17:55）**：并行会话在 17:27–17:38 把学习卡面板换成了新的 `learning/card/`（`lc-*`）全屏改版。四包 typecheck 仍全绿；重新打包后 `package:smoke` 对**新界面**同样真跑通过（判据已改成读界面事实：卡头「N 道题」+ 进入作答面，并同时认旧类名与新 `lc-*` 类名，共享发布闸不再因界面重构而红）。`roles.sql` 清掉旧 learning-card / objective / evidence / candidate 管线的全部授权镜像（含方案 20 那 16 张 V2 表的整段块）后，`role-grants` 复跑干净，权限矩阵无异常。

**仍在收口的**：

- **桌面全量渲染层**：此前在并发构建压力下 31 红；逐文件复跑除登记在案的伴星 history-status 外全绿。需在无并行任务时复跑一次全量，确认只剩伴星那一条。
- **Companion Journey 的完成触发点（需要你拍板）**：`journey-reducer` 里还留着一支 `learning_run.completed → closing / real_first_loop` 的归约分支。它是**死代码**——`learning_runs` 表已随 0449 退役，全仓没有事件生产点（journey-hook 只产 `source/note/card/evidence.created` 四类里程碑）。但 journey 本身是活的 Plan 44 引导功能，所以现在的实际表现是：里程碑能一路推到 `first_evidence`，却永远不会自动走到「完成」。分支不能靠删代码解决（删了只是把死代码换成"永远不完成"），真正的收口是**换一个完成触发点**——最自然的后继是「用户完成第一张笔记内学习卡的完整作答」（提交批改、星级落卡）。这属于 Plan 44 的产品决定，不在方案 57 的范围内，故留给你裁决；一旦你定了后继事件，改动很小（reducer 加一支 `note_learning_card.completed` 归约 + API 侧在批改完成处挂 `hookJourneyEntityCreated`，两处各十几行）。
