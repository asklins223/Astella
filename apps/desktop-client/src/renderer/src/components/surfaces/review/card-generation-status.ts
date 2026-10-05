import type {
  CardGenerationActiveSummaryV1,
  CardGenerationPracticeQuotaV1,
  CardGenerationProgressV1,
  CardGenerationCandidateV1,
  CardActivationSchedulingV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { isCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";
import { formatDate } from "../notebook/surface-data.tsx";

export { isCardGenerationReviewOpen };

/**
 * Shared language for the Card Generation workbench (mockup pages 12 / 13) and
 * the note page's generation entry. Both pages describe the *same* server run,
 * so the status vocabulary lives here once — a label change lands on both.
 */

export const cardGenerationStatusLabels: Record<string, string> = {
  queued: "排队中",
  source_sealing: "正在阅读笔记",
  planning: "正在挑选值得记住的内容",
  authoring: "正在把内容写成卡",
  checking: "正在核对问题与笔记",
  review_ready: "等待审核",
  no_cards_recommended: "没有推荐候选",
  needs_attention: "需要处理",
  activating: "正在保存到卡组",
  activated: "卡组已收到结果",
  closed_without_activation: "已结束，没有保存到卡组",
  failed: "生成失败",
  cancelled: "已取消",
  stale: "来源已过期",
};

export function cardGenerationStatusLabel(status: string): string {
  return cardGenerationStatusLabels[status] ?? "还在处理";
}

/** The list can be newer than the separately fetched run counters. Both are server facts. */
export function cardGenerationObservedProgress(
  progress: CardGenerationProgressV1 | null | undefined,
  candidates: readonly CardGenerationCandidateV1[],
): CardGenerationProgressV1 {
  const written = candidates.filter(candidate => isLandedCandidate(candidate.qualityState)).length;
  const passed = Math.max(progress?.gatePassed ?? 0, candidates.filter(candidate => candidate.qualityState === "passed").length);
  return {
    plannedCards: progress?.plannedCards ?? 0,
    authored: Math.max(progress?.authored ?? 0, written, passed),
    gatePassed: passed,
    gateFailed: progress?.gateFailed ?? 0,
  };
}

/** Counts come from the server; no stage mapping implies an overall percentage. */
export function cardGenerationProgressView(
  status: string,
  progress: CardGenerationProgressV1 | null | undefined,
): { detail: string } | null {
  const planned = progress?.plannedCards ?? 0;
  const authored = progress?.authored ?? 0;
  const passed = progress?.gatePassed ?? 0;
  if (status === "queued") return { detail: "这次已排队，轮到后会从这篇笔记开始。" };
  if (status === "source_sealing") return { detail: "正在读取这一版已保存的笔记。" };
  if (status === "planning") return { detail: planned > 0
    ? `已写出 ${authored} / ${planned} 张候选` : "正在挑出适合做成问题的内容。" };
  if (status === "authoring") return { detail: planned > 0
    ? `已写出 ${authored} / ${planned} 张候选` : `已写出 ${authored} 张候选` };
  if (status === "checking") {
    const total = Math.max(authored, planned);
    return { detail: total > 0 ? `已通过核对 ${passed} / ${total} 张候选` : "正在对照笔记，核对问题和依据。" };
  }
  return null;
}

/** The manual-resync receipt: re-reading status must say what re-reading found. */
export function cardGenerationSyncReportText(status: string | null, changed: boolean): string {
  if (!status) return "这次没读到最新进度，页面显示的还是上一次的结果。";
  const label = cardGenerationStatusLabel(status);
  return changed
    ? `已刷新 · 这次生成到了「${label}」。`
    : `已刷新 · 后台仍是「${label}」，这一步还没有新的进展。`;
}

/**
 * A run that stopped without a recovery contract. The stage track cannot say
 * anything true about it — it does not record how far the run got — so the board
 * shows this instead of lighting up "等待审核" for work that already stopped.
 */
export function isCardGenerationStopped(status: string): boolean {
  return status === "cancelled";
}

/** Statuses where the server is still working — the chip spins, buttons wait. */
const inFlightStatuses = new Set([
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "activating",
]);

export function isCardGenerationInFlight(status: string): boolean {
  return inFlightStatuses.has(status);
}

const reviewStageStatuses = new Set([
  "review_ready",
  "no_cards_recommended",
  "needs_attention",
  "activating",
  "activated",
  "closed_without_activation",
]);

export function isCardGenerationReviewStage(status: string): boolean {
  return reviewStageStatuses.has(status);
}

/**
 * 已经落进库里、可以算作「写好的卡」的候选。
 *
 * 被门禁判掉（`failed`）与牌堆定论后被丢弃（`dropped`）的那几张不算：把它们也列进来，
 * 这一行就在替一个并不存在的结果报数——§52 那个 `quality_state` 撒谎的缺陷，落到界面上
 * 就是这个形状。
 */
export function isLandedCandidate(qualityState: string): boolean {
  return qualityState !== "failed" && qualityState !== "dropped";
}

export const cardGenerationRecoveryReasonLabels: Record<string, string> = {
  provider_unavailable: "生成服务暂时不可用",
  quality_gate_failed: "候选没有通过质量检查",
  source_outdated: "生成来源已经过期",
  run_failed: "这次生成任务已经失败",
  attention_required: "需要后台再看一次才能继续",
  unknown: "暂时说不清这次生成到哪一步了",
};

export function cardGenerationRecoveryReasonLabel(reasonCode: string): string {
  return cardGenerationRecoveryReasonLabels[reasonCode] ?? "需要后台再看一次才能继续";
}

/**
 * 整批练习件的读数（D6 的缺额要有地方看得见）。
 *
 * 只报"点名的那几张"这一个集合：`requiredCount` 张里配上了 `metCount` 张，差的就是缺额。
 * 过去这句还把"带练习件 N 张"并进来，而那个 N 含**自愿多交的**——于是同一行里
 * "带练习件 4 张"与"点名 3 张里漏了 1 张"（只对上 2 张）互相打脸，读者两处数出两个数。
 * 更要紧的是：被点名却整张被门禁丢掉的目标，卡面上根本没有"那张卡"，所以也不能说成
 * "这 N 张里的 M 张"——只有"点名的 R 张里配上了 M 张"在两种缺额下都成立。
 *
 * 数用的是服务端结算的 `practiceQuota`（与 `practice_quota_short` 事件同源）：这里再判
 * 一次形状对不对，就会出现"事件里一个数、屏幕上一个数"。
 *
 * 放在这份共享文件里而不是界面里：这样"接口回来的数 → 用户那句读数"可以被脚本直接
 * 跑一遍量出来，不必等在跑的桌面端里。
 */
export function practiceQuotaLabel(quota: CardGenerationPracticeQuotaV1 | null): string | null {
  if (!quota || quota.requiredCount === 0) return null;
  const missed = quota.requiredCount - quota.metCount;
  if (missed <= 0) return `计划要求的 ${quota.requiredCount} 份练习都已满足`;
  return `计划要求的 ${quota.requiredCount} 份练习中，${quota.metCount} 份已满足要求、${missed} 份未满足`;
}


/**
 * 笔记页那颗入口按下去**会去哪**。
 *
 * 收敛成四句，因为用户在这一格要回答的问题只有两个：现在能不能开始做卡，
 * 以及上次做完了没有。「走到哪一步」是**阶段**——它已经由按钮旁边那颗状态字
 * （生成中／待激活／失败）和 `aria-label` 在说了。入口再按状态细分一遍，
 * 于是同一件事有了七种说法（查看生成进度／审核学习卡／处理生成任务／
 * 查看保存进度／查看学习卡／查看失败原因／查看生成结果），用户在笔记页
 * 每回来一次都可能读到另一句，得先认出它才敢按。
 */
export function cardGenerationEntryLabel(status: string): string {
  // 唯一值得单独说一句的是「等你逐张决定」——那不是进度，是一件在等你做的事。
  if (status === "review_ready") return "审核学习卡";
  if (status === "activated") return "查看学习卡";
  return "查看生成进度";
}

/** A run the note page should surface as "this note's generation is live". */
export function isNoteGenerationLive(status: string): boolean {
  return [
    "queued",
    "source_sealing",
    "planning",
    "authoring",
    "checking",
    "review_ready",
    "needs_attention",
    "activating",
  ].includes(status);
}

export function isLiveGenerationForNote(
  generation: CardGenerationActiveSummaryV1 | null | undefined,
  noteId: string,
): generation is CardGenerationActiveSummaryV1 {
  return Boolean(generation && generation.noteId === noteId && isNoteGenerationLive(generation.status));
}

/**
 * 39d W4-4：生成被规模上限**截断**过时，如实说一句（PRD §3.4：不许"静默截取前半篇
 * 却称为整篇输入"）。
 *
 * 读数来自服务端那一格 `sourceCapped`（它由 worker 的
 * `card_generation.source_content_capped` 事件投影而来）——**界面不自己算**，
 * 也不把"没截断"读成"整篇都读过了"：没截断时这一句根本不画。
 */
export function sourceCappedNotice(capped: { limit: number; originalLength: number }): string {
  return `这一篇较长：本次只把前 ${capped.limit} 字（全文 ${capped.originalLength} 字）交给模型，其余部分这次没有参与生成。`;
}

/**
 * 「保存并开启复习」之后屏幕上那一句（39d W7-2）。
 *
 * 只给最早那一个日期：一次保存十几张时，逐条报日期读起来就是噪音，而"什么时候再来"
 * 对用户本来就是同一件事。
 *
 * 「其中 N 个还在暂不安排里」这句是 W7-3 刀一落进来时才有的：回执里那一档叫 `held`，
 * 意思是"这个目标被你自己标了暂不安排，所以这一发什么都没排"。这一段注释以前写的是
 * "今天没有生产者、别只补文案"——生产者是 `ensurePendingReviewScheduleV2` 里那一句
 * 先看活行的判据，配套的会红的用例在同名的 `card-generation-status.test.ts` 里。
 *
 * 沿用那句（`created` 为假）仍然没报：`held` 与"沿用已有那一条"是两件事，别混着念。
 */
export function reviewSchedulingNotice(
  scheduling: CardActivationSchedulingV1[],
): string {
  const stamps = scheduling
    .map((entry) => (entry.nextReviewAt ? new Date(entry.nextReviewAt).valueOf() : Number.NaN))
    .filter((value) => Number.isFinite(value));
  // 被"暂不安排"挡住的那几条**没有日期可读**（服务端那一发什么都没写），所以它们不进
  // 最早日期，只进这一句计数——不然屏幕上会出现"第一次复习排在 X"而 X 不含那几张。
  const heldCount = scheduling.filter((entry) => entry.held === true).length;
  const heldClause = heldCount > 0 ? `；还有 ${heldCount} 个目标在你标的「暂不安排」里` : "";
  // 日期读不出来时不许编一个："时间未提供"是这一屏既有的说法。
  if (stamps.length === 0) {
    return heldCount > 0 ? `这次没有排出新的复习${heldClause}` : "第一次复习的日期还没排出来";
  }
  return `第一次复习排在 ${formatDate(new Date(Math.min(...stamps)).toISOString())}${heldClause}`;
}

/**
 * 「保存到卡组」那一发（没要复习）在回执上说的一句（39d W7-2）。
 *
 * 这一句**不从 `receipt.scheduling` 缺不缺键来判**：0288 加那一列之前落库的历史回执
 * 也缺同一个键，那一格分不开"这次没要复习"与"那一批在加列之前保存"两件事；
 * 而**按下的是哪颗按钮**分得开。两颗按钮的区别必须在回执上看得见，否则用户只有
 * 在点完之后才知道自己刚才要的是哪一种。
 */
export function saveOnlyReceiptNotice(): string {
  return "这次只保存到卡组，没有安排复习";
}
