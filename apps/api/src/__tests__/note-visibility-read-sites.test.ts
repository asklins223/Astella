/**
 * 笔记读点的可见性棘轮（批次 4.5）。
 *
 * 为什么必须有这一条：`notes` 的 RLS 本轮没重开，「仅自己可见」这条边界目前
 * **完全靠每个读点自己带上 `visibleNotesCondition`**。一个人漏写一处就是"列表挡住了、
 * 搜索没挡"那一类分裂——而那正是 2026-09-20 那份审查反复指出的东西。指望人记住
 * 27 个读点是不现实的，所以改成：新增一个读点而没有带上判据，CI 就红。
 *
 * 口径是"每个文件里：守卫出现次数 ≥ 读点次数 − 允许数"。允许数逐条写明理由，
 * 只能随着修好而变小；把允许数调大去迁就新代码，需要在这里解释为什么那一处不该按人筛。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const API_ROOT = new URL("..", import.meta.url).pathname;
const READ_PATTERNS = [
  /\bfrom\(notes\)/g,
  /\bquery\.notes\./g,
  // 大小写都要覆盖：`.innerJoin(notes,` 与 `.leftJoin(notes,` 如果被漏掉，
  // join 上带来的判据就会被算成"多余的守卫"，这条棘轮于是形同虚设
  // （第一版就是这样：删掉 activity 的一处判据仍然全绿）。
  /\b\w*[jJ]oin\(notes[,)]/g,
  /\bFROM\s+notes\b/gi,
];
const GUARD_TOKENS = [
  "visibleNotesCondition",
  "noteVisibleSqlText",
  "searchDocumentsVisibleSql",
  // 只按作者筛是同一句话的**更严**形式（onboarding 探针、里程碑判定只看自己的），
  // 所以它算带上判据，不算漏。
  "eq(notes.createdBy",
  // 作者判据（归属动作自己用）：能改这一列的人只有写下这篇的那个账号，比按人筛更严。
  "createdBy !== userId",
  // 索引正文里只收人人可见的那部分（objective 的标题来自 shared 笔记）。
  "eq(notes.shareScope",
];

/**
 * **经轮次间接取笔记内容**那一族（39d W5-6 刀一新增）。
 *
 * 为什么不并进上面那份 `READ_PATTERNS`：上面那组认的是「这一发直接读 `notes`」，
 * 而轮次的讲解与产物读点是 `from(noteLearningRoundTeachings)`、
 * `from(noteLearningRoundArtifacts)`——它们**根本不碰 `notes` 表**，内容是经
 * `roundId → noteLearningRounds.noteId → notes` 间接取到的。
 *
 * 于是 2026-09-27 量到一个真实破口：`readRound` / `readOpenRound` /
 * `findReusableTeaching` / `readTeachingArtifactRef` / `readRoundArtifactHtml`
 * 五个读点全都只按 `(workspace, user)` 过滤，作者撤回共享之后**本轮问题、缓存讲解
 * 与整份讲解 HTML 仍然取得到**（§16.13「失权后不能靠旧快照继续学习」、
 * §14.4「失权后停止受保护内容的展示、练习与外发」），而这条棘轮**全绿**——
 * 守卫是绿的而产品规则已破，那比缺功能更难发现，所以这一族必须单独立一组模式。
 *
 * 口径与上面那组一致：**就近** ±12 行窗口里必须有判据，不是文件级计数。
 *
 * **刀二之后这一族扩到 `noteLearningRounds` 本身**（刀一只认了两张内容表）。
 * 那一族量下来 15 处，逐条看过之后：**一处是真缺口**——`listRoundHistory` 返回整页
 * 轮次含驱动问题，而路由 `GET /notes/:noteId/rounds` 不先验笔记，于是撤回共享之后
 * 那一页历史照样端得出去（已补判据）。其余 14 处按"不取内容"或"下游已过闸"逐条
 * 写明理由列进豁免，不是"一次性全豁免"。
 */
const ROUND_INDIRECT_READ_PATTERNS = [
  /\bfrom\(noteLearningRoundTeachings\)/g,
  /\bfrom\(noteLearningRoundArtifacts\)/g,
  /\bfrom\(noteLearningRounds\)/g,
];

/**
 * 这一族里逐条豁免的读点（同样只许随修好而变小）。
 * 数字是"这一族里抵不上判据的条数"，理由逐条写明。
 *
 * `round-service.ts` 的十二处，按所在函数逐个看过（函数边界 479/576/650/721/795/997/1030/1223）：
 *  - `readRoundHistoryFactsV1` 里的 `selectDistinct({ roundId })`（讲过没有）与
 *    `from(noteLearningRounds)` 那发（练过没有／系统不确定）：返回的形状是几个 **id**
 *    的集合，**没有正文**。这一整个函数**连 `scope` 都不收**——入参就是调用方已经验过
 *    的 id 列表，这是设计不是疏漏：它去数事实，不去端内容。
 *  - `listPersonalRoundHistory` 里那处 `select({ id })`：游标/存在性检查；同一个函数里
 *    真正取内容的那两发自己带了判据。
 *  - `advanceRound`／`reviseDrivingQuestion`／`appendPlanRevision` 三个写路径的整行 CAS 读
 *    （都带 `.for("update")`）：调用方每一条都先过 `readRound`（已按笔记判过可见性，
 *    判不过去路由直接 404），所以这一发在写之前拿不到"失权之后还能改"的机会。
 *  - `countTeachings`：`count(*)`，只数条数。
 *  - `createTeaching` 里 `max(ordinal)`：写路径上给新产物算序号。
 *  - `readTeachingArtifactRef` 的**第二发**（取 artifact 元数据）：它的 `artifactId` 是
 *    从**上一发**取的，而上一发已经带了判据；这一发只取 id/kind/createdAt，不含 html。
 *
 * `reflection-service.ts` 的两处都在 `requireVisibleNote` 下游：那一发带了
 * `visibleNotesCondition`，而且 `.for("share")` 把整段读与共享撤回串行化
 * （共享是显式动作，这一发就是为它准备的）。一处取讲解正文、一处只取 id 做存在性检查。
 *
 * `prerequisite-proposal.ts` 的那处是**这条棘轮当场抓到的**：那个文件在刀一之后
 * 才落盘，它第一句就是 `readRound`（已按笔记判过可见性，判不过去直接回
 * `no_usable_material`），自己那一发只取 `sourceBlockOrdinals`——块序号，不是正文。
 *
 * `round-activity-sweep.ts` 是后台清扫器：定时跨用户跑，只取 `{ id, noteId }` 去过期，
 * 不返回任何内容给查看者。
 *
 * `round-service.ts` 的**第十二、十三处**（`readMaskedRoundHistoryV2` 里的两发，
 * 2026-09-27 随 §10.3「失权后仍展示非内容元数据」新增）：那一发**刻意不带**判据——
 * 它存在的全部意义就是在可见性判不过去之后仍然读得到"我什么时候练过、练到哪了"。
 * 它只取 `id/phase/outcome/createdAt/closedAt` 这五列（**没有** `drivingQuestion`，
 * 那一格是固定遮蔽句；**没有** `noteVersionId` 与任何指向内容的列），
 * 且按 `(workspace, user, noteId)` 三格收窄——那三格是本人自己的记录，不是别人的。
 * 给它加判据会让 §10.3 那一整格失效：判不过去 ⇒ 返回空数组 ⇒ 屏上与"这一篇从来没有
 * 过轮次"完全一样，而那是**关于用户自己的**一条假事实。
 *
 * `run-service.ts` 的两处分别是"这一轮现在什么相位"（`{ id, phase }`，`note_round`
 * 起手时挑未完轮次，而那条起手路先过 `resolveV2OriginExtras`）与
 * "返回目标还在不在"（`{ id }`，跳转可用性，与卡片那一族同一条口径）。
 *
 * 带 stale 检查：豁免数比实际多会红，所以有人把闸补上，这里必须跟着减。
 */
const ROUND_INDIRECT_SYSTEM_LEVEL_READS: Record<string, number> = {
  "modules/note-learning-rounds/round-service.ts": 12,
  "modules/note-learning-rounds/reflection-service.ts": 2,
  "modules/note-learning-rounds/prerequisite-proposal.ts": 1,
  "modules/note-learning-rounds/round-activity-sweep.ts": 1,
  "modules/learning-runs/run-service.ts": 2,
};

/**
 * 两个**点名的**轮次读函数必须自带判据。
 *
 * 为什么点名而不靠模式：`from(noteLearningRounds)` 在这个文件里有 15 处，混着写路径
 * 与列表读，按模式一刀切要么全红要么全豁免（见上面那段）。但"读回整份轮次"这两处
 * 是 §16.13 那条产品规则**最直接**的落点（冻结快照就是从这里端出去的），
 * 它们必须被这一条钉住，而且这一条要能独立红。
 */
const ROUND_CONTENT_READERS: Array<{ file: string; fn: string }> = [
  { file: "modules/note-learning-rounds/round-service.ts", fn: "readRound" },
  { file: "modules/note-learning-rounds/round-service.ts", fn: "readOpenRound" },
];

/**
 * 系统级读点：这些位置没有"查看者"可言，也不该有。
 *
 * - `note/maintenance.ts`、`scripts/cleanup-soft-deleted-notes.ts`：定时物理清理，
 *   跨所有用户跑。带上按人判据反而会把已过期的私有笔记永久留在库里。
 * - `search/service.ts` 的前 3 处：`reindexWorkspaceSearch` 建索引与漂移检测。索引是
 *   全空间共用的一份数据，按某个人裁等于把他的视角烧进共用数据（下一次 owner 重索引，
 *   私有笔记连作者自己都搜不到）。发不发结果由查询侧那次 join 判，那一处有守卫。
 *   数字对不上时会红，改这里必须同步看 `search()` 里的那一次 join 还在不在。
 *
 * 这个数衡量的是"判据 token 抵不上的读点条数"，不是"有几处故意不按人筛"——一个 token
 * 可以服务多处（比如那段索引片段被查询与总数各用一次）。口径单调，所以新增读点不带判据
 * 一定红，删掉判据也一定红。
 * - `note/collaboration.ts` 的 1 处：`onStoreDocument` 落盘时按 noteId 取当前版本指针，
 *   不读正文；连接本身已在 `onAuthenticate` 按归属与空间拒过（那条有守卫）。
 */
const SYSTEM_LEVEL_READS: Record<string, number> = {
  // 定时清理与 CLI：跨所有用户跑，带上按人判据会把已过期的私有笔记永久留在库里。
  "modules/note/maintenance.ts": 1,
  "scripts/cleanup-soft-deleted-notes.ts": 1,
  // 建索引、索引清理与漂移检测三处：索引是全空间共用的一份，见 `search()` 里的 join。
  "modules/search/service.ts": 3,
  // `onAuthenticate` 按 `shareScope` + 空间拒连接，那是比"按人可见"更强的要求。
  "modules/note/collaboration.ts": 1,
  // `checkExportSize` 是体积保险丝，刻意取超集（见该处的注释）。
  "modules/export/service.ts": 1,
  // 写入过程中"这篇还在不在"的复查：把它按人筛会把一次并发删除变成对可见性不足的假报错。
  "modules/upload/upload-service.ts": 1,
  // 解散先睹计数（审计 F39 ③）：刻意取**超集**——回收站里的笔记也会随空间一起消失，
  // 按人筛会少报，而少报一个"会毁掉多少"的数字比多报更糟。这里只回四个整数，
  // 不回任何一篇的标题或正文。（同一处读点在卡片棘轮里另计一次。）
  "modules/identity/service.ts": 1,
  // 证据预览要把锚点重落到**当前版本**的块行上（39d D3 §3 第 2 层）：从 `notes` 只取
  // `current_version_id` 一列，不回任何正文。从这里出去的文字由调用方各自的对象判据
  // 挡着（卡列表 `visibleCardsCondition`、候选 reveal 的 run/candidate 归属）。
  // 这里按人再筛一次会把"看不见这篇笔记"当成"落点还在"——正是这一刀在修的那个瞎法。
  "modules/card-generation-v2/evidence-preview.ts": 1,
};

/**
 * 目标读点的可见性棘轮（批次 4.5 最后一段）。
 *
 * 目标的 `concept_label` / `public_summary` / `objective_statement` 也是从笔记正文
 * 生成的，所以同一句话必须盖到这一层。判据走"目标 → 卡 → 笔记版本 → 笔记"，
 * 而不是"目标 → origins → 笔记"：dev 真实数据上量过，214 条 active 目标只有 43 条
 * 有 origin 行，按 origins 判等于给 80% 的目标发通行证；而 214/214 都有卡。
 */
const OBJECTIVE_READ_PATTERNS = [
  /\bfrom\(learningObjectivesV2\)/g,
  /\bfrom\(learningObjectiveRevisionsV2\)/g,
  /\b\w*[jJ]oin\(learningObjectivesV2[,)]/g,
  /\b\w*[jJ]oin\(learningObjectiveRevisionsV2[,)]/g,
  /\bFROM\s+learning_objectives_v2\b/gi,
  /\bFROM\s+learning_objective_revisions_v2\b/gi,
];
const OBJECTIVE_GUARD_TOKENS = [
  "visibleObjectivesCondition",
  // 更严的形式：只放自己写的笔记那一条，或按人筛过的卡。
  "eq(learningObjectivesV2.createdBy",
  "visibleCardsCondition",
  "visibleNotesCondition",
];
/**
 * 系统级 / 非展示读点。口径与上面两条一样：数的是"判据 token 抵不上的读点条数"，
 * 只能随着修好而变小。
 */
const OBJECTIVE_SYSTEM_LEVEL_READS: Record<string, number> = {
  // 39d W5-6 刀六：`linkPersonalBindingToObjectiveV2` 里那一发只为**判据快照**取两列——
  // `current_objective_revision_id` 与 `revision`（"当初凭什么说它们是同一条"的那份记录）。
  // 没有题面、没有概念标题，所以不是内容读点。真正的可见性在**上一个函数**
  // `listBindingLinkCandidatesV2` 里判着，那一发返回题面，那一发带了
  // `visibleObjectivesCondition`（写在 join 条件上）。
  "modules/learning-objectives/personal-binding-service.ts": 2,
  // 生成与激活侧：调用方刚提交的那一批的闭环（能走到这里说明这篇笔记对他可读），
  // 以及按 objectiveId 精确取一行的 CAS。
  "modules/card-generation-v2/activation-service.ts": 7,
  "modules/card-generation-v2/target-snapshot-adapter.ts": 2,
  "modules/card-generation-v2/card-service.ts": 5,
  // 练习与复习：排程/回合本身就是按人的行（RLS + user_id），这里读的是"自己要做什么"，
  // 不是把目标的正文广播给别人。
  "modules/learning-runs/run-service.ts": 3,
  "modules/learning-runs/run-processing-tick.ts": 2,
  "modules/review/service.ts": 3,
  // 排程"这条目标还有没有能做的卡"的多态判定：只回答是/否，不返回任何文字。
  // 2026-09-24（39d W2-3）：这条判据迁去了 `@ailearn/shared/review-consumable-target`
  // （伴星的到期读数要与队列共用一份），登记随之取消——它已经不在本守卫扫的这棵树里。
  // 复习队列的证据完备性判据（审计 F28）：只回答"这个目标的必选评分点缺哪几个"，
  // 返回的是单元 id，不从这里出去任何目标正文。调用方是队列自己——那批排程已经
  // 按人取过（与上面 `modules/review/service.ts` 那三条同一个理由）。
  "modules/review/frozen-evidence.ts": 1,
  // 目标自己的附属记录：origin 的增删与历史，都按 objectiveId 精确取。
  "modules/learning-objectives/origin-service.ts": 1,
  "modules/learning-objectives/origin-migration.ts": 1,
  "modules/learning-objectives/history-route-service.ts": 2,
  // 搜索索引是全空间共用的一份，按某个人裁会把他的视角烧进共用数据（见 notes 那条
  // 同样的理由）；目标这一侧的出口按同一套口径判。三处都在索引维护这条线上，读的都是
  // 同一个对象集合：reindex 的目标行（`learningObjectivesV2`）、它当前修订的标题
  // （`learningObjectiveRevisionsV2`），以及 drift 侧同形状的两次读取 + 清理幽灵目标
  // 文档的那条 DELETE（审计 F15 把检测补到目标这一表之后）。
  "modules/search/service.ts": 3,
  // `checkExportSize` 的体积保险丝，刻意取超集。
  "modules/export/service.ts": 2,
  // 游标行：只取 createdAt / id 定位分页，不返回任何文字。
  "modules/learning-objectives/surface-service.ts": 1,
};

/**
 * 抹掉注释内容但**保住行号**：直接删掉整行会让报出来的 `file:line` 对不上源码，
 * 而这条测试存在的意义就是告诉人来修——行号错了就没人修。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "integration-tests") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 卡片读点的可见性棘轮（批次 4.5 收尾）。
 *
 * 卡是从笔记正文抽出来的（`front` 是题面、`public_summary` 是一句摘要），所以
 * 「仅自己可见」的笔记只要生成过卡，正文就还有一条路能到别人手里。`visibleCardsCondition`
 * 把那扇门关上；这一条保证以后新增的卡读点不会悄悄不带上它。
 *
 * 判据不是"所有卡读点都要筛"，而是"**往外返回正文列的**要筛"。只取 `cardId` 的（跳转
 * 目标还在不在）、只取 `noteVersionId` 的（回填来源）、按 `cardId` 做 CAS 的（调用方
 * 自己刚发起的生成意图）都不返回内容，所以进豁免清单，并在那里写明理由。
 *
 * `learning_cards_v2` 的 `public_summary` / `front` 两列就是"内容"的判据：一次读点如果
 * 整行 `select()`，也算取内容（整行必然带上这两列）。
 */
const CARD_READ_PATTERNS = [/\bfrom\(learningCardsV2\)/g, /\bFROM\s+learning_cards_v2\b/gi];
const CARD_GUARD_TOKENS = [
  "visibleCardsCondition",
  "visibleNotesCondition",
  "eq(notes.createdBy",
  // 2026-09-27（39d W5-6 刀三）：目标级的同一句话也是**跟着笔记判**——
  // `visibleObjectivesCondition` 走的是「目标 → 卡 → 笔记」那一支（见
  // `modules/note/visibility.ts` 的注释），所以它算带上判据，不算漏。
  //
  // 补这一条是被这个守卫抓出来的：`modules/review/shared-card-review-service.ts`
  // 落盘后一分钟这里就红了，那一处其实带着 `visibleObjectivesCondition`，
  // 只是 token 表里没有它。**不是**把那处列进豁免——豁免的前提是"没有判据"，
  // 它有；这里要做的是让守卫认得它。
  "visibleObjectivesCondition",
];
const CARD_SYSTEM_LEVEL_READS: Record<string, number> = {
  // 解散先睹计数：同上，只数不取内容（判据与理由见笔记棘轮里同一条豁免）。
  "modules/identity/service.ts": 1,
  // 跳转目标可用性：只回答"这张卡还在不在"，取的是 `cardId` 一列。
  "modules/learning-runs/run-service.ts": 1,
  // 回填 `learning_objective_origins_v2`：取的是 `noteVersionId`，不回给任何人正文。
  "modules/learning-objectives/origin-migration.ts": 1,
  // 目标表面：从卡上只取 `cardId` / 两个 revision / `sourceLabel`（激活时写死为 null），
  // 题面与摘要都不从这里出去。
  "modules/learning-objectives/surface-service.ts": 4,
  // 星图 v3 的 objective→cardId 映射，同上。
  "modules/understanding-v3/topology-repository.ts": 2,
  // 生成侧：按 `cardId` 做 CAS（调用方自己刚提交的激活意图），以及截断告警里的总数。
  // 能走到这里的笔记已经过 `generation-run-service` 的按人判。
  "modules/card-generation-v2/activation-service.ts": 2,
  "modules/card-generation-v2/target-snapshot-adapter.ts": 1,
  // 取 `cardId` 的反查两处 + 截断告警的总数一处（v2 星图那一版）。
  "modules/understanding/projection-read-service.ts": 4,
  // 伴星"打开这张卡"的跳转：只把 cardId 换成 objectiveId，正文不从这条路出来
  // （到了目标页仍要过上面那些读点）。
  "modules/companion-conversation/learning-action-bridge.ts": 1,
  // `checkExportSize` 是体积保险丝，刻意取超集（与笔记那一处同一个理由）。
  "modules/export/service.ts": 1,
};

/**
 * `forward` 是"判据最远可以离读点几行"。默认 12 够一条普通查询；
 * 目标那一层的几个站点中间夹着 `leftJoin(...)` 与一长串 select 列，
 * 判据落在 13-18 行外，所以那一族单独放宽到 18 —— 仍然是"同一条查询内"，
 * 不是文件级计数（文件级计数的害处见上面那条注释）。
 */
function unguarded(
  file: string,
  rel: string,
  patterns: RegExp[],
  tokens: string[],
  forward = 12,
): string[] {
  return unguardedInSource(readFileSync(file, "utf8"), rel, patterns, tokens, forward);
}

/**
 * 同一套窗口逻辑，喂源码文本而不是文件路径。
 *
 * 拆出来是为了让"判据自己能红"这件事**真的能测**：第一版把灵敏度断言写成对着
 * `/tmp/某个不存在的路径` 调 `unguarded`，结果 ENOENT——那条断言从来没量过任何东西，
 * 是空的。拆成吃文本之后，合成一段"确实漏了判据"的源码就能当场量它抓不抓得到。
 */
function unguardedInSource(
  rawSource: string,
  rel: string,
  patterns: RegExp[],
  tokens: string[],
  forward = 12,
): string[] {
  const source = stripComments(rawSource);
  const lines = source.split("\n");
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index ?? 0).split("\n").length - 1;
      // 判据通常在 `where(and(...))` 里，紧跟读点之后；往前几行覆盖 join 条件写在
      // 上方的写法。窗口太宽会退化成"文件级计数"，所以只取 ±12 行。
      const window = lines.slice(Math.max(0, line - 4), line + forward).join("\n");
      if (tokens.some((token) => window.includes(token))) continue;
      out.push(`${rel}:${line + 1} (${match[0]})`);
    }
  }
  return out;
}

test("每一处笔记读点都就近带上可见性判据（或有写明理由的系统级豁免）", () => {
  // 按"这一处读点附近有没有判据"判，不按整个文件计数：第一版按文件计数时，
  // activity 里删掉一处判据仍然全绿——同一个文件里别处的判据把它蒙过去了。
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  const files = sourceFiles(join(API_ROOT, "modules")).concat(sourceFiles(join(API_ROOT, "scripts")));
  for (const file of files) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, READ_PATTERNS, GUARD_TOKENS);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的笔记读点没带可见性判据（或判据离得太远）：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "系统级豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("经轮次间接取笔记内容的读点同样要带判据（§16.13 失权后不能靠旧快照继续学）", () => {
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  for (const file of sourceFiles(join(API_ROOT, "modules"))) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = ROUND_INDIRECT_SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, ROUND_INDIRECT_READ_PATTERNS, GUARD_TOKENS);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处经轮次取笔记内容的读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 这一族的豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [],
    "经轮次间接取笔记内容的读点没带可见性判据（这一族以前不在棘轮里，W5-6 刀一的破口就是从这里漏过去的）：\n"
    + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [],
    "这一族的豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("点名的两个轮次读函数自带判据，且这一条能独立红", () => {
  const missing: string[] = [];
  for (const { file, fn } of ROUND_CONTENT_READERS) {
    const source = stripComments(readFileSync(join(API_ROOT, file), "utf8"));
    const at = source.indexOf(`function ${fn}(`);
    assert.notEqual(at, -1, `${file} 里找不到 ${fn}：守卫该跟着改名一起改`);
    // 取这个函数体（到下一个顶层 function 为止），判据必须落在**它里面**，
    // 而不是文件里别处某一处——后者正是"同一文件里别处的判据把它蒙过去"。
    const rest = source.slice(at);
    const next = rest.slice(1).search(/\n(?:export )?(?:async )?function \w/);
    const body = next === -1 ? rest : rest.slice(0, next + 1);
    if (!GUARD_TOKENS.some((token) => body.includes(token))) {
      missing.push(`${file}:${fn}`);
    }
  }
  assert.deepEqual(missing, [],
    "读回整份轮次的读点没带可见性判据：共享撤回之后冻结快照会继续被端出去（§16.13）\n" + missing.join("\n"));
});

test("这一族的判据自己站得住：豁免指向的文件在，且窗口逻辑仍能抓到漏网的", () => {
  for (const rel of Object.keys(ROUND_INDIRECT_SYSTEM_LEVEL_READS)) {
    assert.equal(statSync(join(API_ROOT, rel)) !== null, true, `${rel} 已经不在了，豁免要删`);
  }
  // 灵敏度一：同一段源码，补了判据读出 0，去掉判据必须读出 1。
  // （这一条第一版写成对 `/tmp/某个不存在的路径` 调 `unguarded`，结果是 ENOENT——
  //   也就是说它从来没量过任何东西。拆成吃文本之后才量得到。）
  const template = [
    "async function fake() {",
    "  const rows = await tx",
    "    .select()",
    "    .from(noteLearningRoundTeachings)",
    "    .where(and(",
    "      eq(noteLearningRoundTeachings.roundId, roundId),",
    "      %TOKEN%",
    "    ));",
    "  return rows;",
    "}",
  ].join("\n");
  const guarded = template.replace("%TOKEN%", "visibleNotesCondition(scope.userId)");
  const bare = template.replace("%TOKEN%", "eq(x, 1)");
  assert.deepEqual(
    unguardedInSource(guarded, "synthetic", ROUND_INDIRECT_READ_PATTERNS, GUARD_TOKENS),
    [],
    "带了判据的合成源码被误报了，判据太宽",
  );
  assert.equal(
    unguardedInSource(bare, "synthetic", ROUND_INDIRECT_READ_PATTERNS, GUARD_TOKENS).length,
    1,
    "去掉判据的合成源码没被抓到，判据已经瞎了",
  );
  // 灵敏度二：判据离读点太远（> forward 行）也必须被抓到——那正是"同一文件里别处的
  // 判据把它蒙过去"的形状。
  const far = template.replace("%TOKEN%", "").replace(
    "    ));",
    "    ));\n" + Array.from({ length: 20 }, () => "  // filler").join("\n")
      + "\n  const guard = visibleNotesCondition(scope.userId);",
  );
  assert.equal(
    unguardedInSource(far, "synthetic", ROUND_INDIRECT_READ_PATTERNS, GUARD_TOKENS).length,
    1,
    "判据离读点 20 行仍然算抵上了，窗口形同文件级计数",
  );
});

test("返回正文的卡片读点都带上「跟着来源笔记判」", () => {
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  for (const file of sourceFiles(join(API_ROOT, "modules"))) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = CARD_SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, CARD_READ_PATTERNS, CARD_GUARD_TOKENS);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处卡读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的卡片读点没带可见性判据：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "卡片豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("返回正文的目标读点都带上「跟着来源笔记判」", () => {
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  for (const file of sourceFiles(join(API_ROOT, "modules"))) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = OBJECTIVE_SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, OBJECTIVE_READ_PATTERNS, OBJECTIVE_GUARD_TOKENS, 18);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处目标读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的目标读点没带可见性判据：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "目标豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("豁免清单里的文件确实存在（防止改名后豁免悬空）", () => {
  for (const rel of [...Object.keys(SYSTEM_LEVEL_READS), ...Object.keys(OBJECTIVE_SYSTEM_LEVEL_READS)]) {
    assert.equal(statSync(join(API_ROOT, rel)) !== null, true, `${rel} 已经不在了，豁免要删`);
  }
});
