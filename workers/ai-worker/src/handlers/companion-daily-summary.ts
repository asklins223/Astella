/**
 * 桌宠日记生成器（22-real-desktop-pet-memory-context-prd-tdd.md §15.4/§15.5）。
 *
 * 2026-09-21 重写：正文从确定性模板改成**她自己按人格写的第一人称日记**。
 * 起因是用户对旧产出的裁决——"这跟系统统计数据有什么区别？"旧实现是
 * `buildSummaryText()` 把 12 个 COUNT 拼成一句"…的学习小结：新增学习卡 4 张；…"，
 * 下面再挂一张数字表；那条链路上既没有模型，也没读过 `pet_profiles`。
 *
 * 现在的形状：
 *   1. 当天**具体发生过什么**（笔记标题、学了什么、她说过的话、说到做到的提醒）当素材；
 *   2. 账号人格 + 空间关系决定语气与篇幅；
 *   3. 模型写正文，服务端按"不许报数"这道机器闸校验，不合规重采样一次；
 *   4. 写不出来就诚实留一行 failed 带成因，不返回任何看起来像日记的兜底文本。
 *
 * 两件事没变、也不能变：
 *   - `facts` 那 12 个计数继续写库（界面不再显示）。`companion-thought.ts` 读
 *     `facts->>'learningRunsCreated'/'learningRunsCompleted'` 算连续学习天数，
 *     少了它们主动念头会静默归零。
 *   - 派生记忆的 `source_event_id = 'daily-summary:<date>'` 与 ≤200 字上限，
 *     「查看关联记忆」按这个键找。存的是**事实备忘**（digest），不是日记正文：
 *     候选记忆一旦确认就每轮注入，把主观创作存成记忆等于让她把自己的情绪
 *     当成回忆引用——这个仓库已经吃过一次"她的谎自己长出引用"。
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  companionDailyBlockV1Schema,
  companionPersonaActivenessV1Schema,
  companionPersonaBoundariesV1Schema,
  readJobPayloadString,
} from "@ailearn/shared";
import { sourceImageUrlFromObjectKey } from "@ailearn/shared/source-image-contracts";
import { PET_PERSONA_PRESET_VERSION } from "@ailearn/shared/pet-persona-presets";
import { toTextArrayLiteral } from "@ailearn/shared/pg-text-array";
import { logger } from "../lib/logger.ts";
import { assertJobLease, isJobLeaseActive, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  AIDataPolicyDeniedError,
  AIProviderNotConfiguredError,
  createGovernedProvider,
  normalizeWorkspaceAIPolicy,
  resolveAIGovernanceContext,
  resolveProviderForTask,
  type AIGovernanceContext,
} from "../lib/governance.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionDiaryTotal } from "../lib/metrics.ts";
import { DailyDiaryOutputError } from "../lib/non-retryable-errors.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import { sanitizePersonaField } from "./companion-dialogue-content.ts";
import { PAGE_KIND_LABELS } from "./companion-here-and-now.ts";
import type { WorkerTransaction } from "../db.ts";
import type { JobPayload } from "./index.ts";
import {
  runAiTask,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";
import { createDiaryCheckpointPort } from "./companion-diary-checkpoints.ts";
import {
  committedDiaryTask,
  diaryTaskAttempt,
  diaryTaskContext,
} from "./companion-daily-summary-task.ts";
import { describeDiaryImage } from "./companion-daily-summary-image.ts";
export { pickImageToRead } from "./companion-daily-summary-image.ts";
import {
  buildDiaryCandidates,
  buildDiarySelectionMessages,
  companionDiarySelectionSchema,
  validateDiarySelection,
  type CompanionDiarySelection,
  type DiaryCandidate,
} from "./companion-diary-candidates.ts";
import {
  clockOf,
  currentDiaryMaterialStart,
  dayEnd,
  dayStart,
  diaryMaterialStartIsCurrent,
  hasDiaryWorthyMaterial,
  type DayScope,
} from "./companion-daily-summary-eligibility.ts";
import {
  buildDiaryPrompt,
  COMPANION_DIARY_DRAFT_PROMPT_VERSION,
  captionEchoIn,
  clipAtBoundary,
  clockPhrase,
  countingToneIn,
  dayPartOf,
  diaryAssistantWeight,
  diaryImageLabel,
  diaryLengthOverflow,
  diaryLengthShortfall,
  diaryParagraphCount,
  endsInQuestion,
  exampleEchoIn,
  fitDiaryToParagraphBudget,
  focusDiaryMaterial,
  groundedDiaryDigest,
  imageShape,
  isQuotableQuote,
  minuteOfDay,
  pickDiarySubject,
  pickImagesPerNote,
  pickQuoteCandidates,
  repeatedMotifIn,
  repeatedOpeningIn,
  recurringMotifs,
  renderMaterial,
  resolveDiaryBlocks,
  stripEmbedRefs,
  selfPutdownIn,
  thirdPersonForUserIn,
  diaryBlockDraftSchema,
  DIARY_MAX_TOKENS,
} from "./companion-diary-content.ts";
import type { DiaryBlock, DiaryDraft, DiaryEmbed, DiaryMaterial, DiaryPersona, DiaryPiece } from "./companion-diary-content.ts";
export {
  buildDiaryPrompt, captionEchoIn, clockPhrase, countingToneIn, dayPartOf, diaryAssistantWeight,
  clipAtBoundary, diaryImageLabel, diaryLengthOverflow, diaryParagraphCount, endsInQuestion, exampleEchoIn,
  fitDiaryToParagraphBudget, focusDiaryMaterial, groundedDiaryDigest, imageShape, isQuotableQuote,
  pickDiarySubject, pickImagesPerNote, pickQuoteCandidates, repeatedOpeningIn, stripEmbedRefs,
  renderMaterial, resolveDiaryBlocks, selfPutdownIn, thirdPersonForUserIn, DIARY_MAX_TOKENS,
};
export type { DiaryBlock, DiaryEmbed, DiaryMaterial, DiaryPersona, DiaryPiece };


/** 界面与 DB 共用的失败成因词表（0250 的 CHECK 约束与它同一套取值）。 */
const diaryFailureReasonSchema = z.enum([
  "consent_required",
  "model_unavailable",
  "diary_output_invalid",
]);
type DiaryFailureReason = z.infer<typeof diaryFailureReasonSchema>;

interface DailyFacts {
  notesCreated: number;
  notesUpdated: number;
  cardsCreated: number;
  sourcesCreated: number;
  jobsCreated: number;
  jobsCompleted: number;
  learningRunsCreated: number;
  learningRunsCompleted: number;
  pageContexts: number;
  conversationMessages: number;
  userMessages: number;
  assistantMessages: number;
}

// ─── 素材 ────────────────────────────────────────────────────────────────

function slice(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 当天 12 个计数。
 *
 * `sources` 与 `learning_cards_v2` 以前只按 workspace 过滤，把**别人**的收录算到
 * 这个人名下（`0243_companion_daily_summary_per_workspace.sql:16-20` 记的就是这笔债，
 * 当时只影响"要不要给他生成小结"，现在它还会进 prompt，所以必须收紧到人名下）。
 */
async function collectFacts(tx: WorkerTransaction, scope: DayScope): Promise<DailyFacts> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*)::int FROM notes WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
        AND deleted_at IS NULL) AS notes_created,
      (SELECT count(*)::int FROM notes WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}
        AND deleted_at IS NULL) AS notes_updated,
      (SELECT count(*)::int FROM learning_cards_v2 c WHERE c.workspace_id = ${scope.workspaceId}
        AND c.created_at >= ${dayStart(scope)} AND c.created_at < ${dayEnd(scope)}
        AND c.note_version_id IN (SELECT nv.id FROM note_versions nv WHERE nv.created_by = ${scope.userId})) AS cards_created,
      (SELECT count(*)::int FROM sources WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS sources_created,
      (SELECT count(*)::int FROM jobs WHERE workspace_id = ${scope.workspaceId} AND requested_by = ${scope.userId}
        AND scheduled_at >= ${dayStart(scope)} AND scheduled_at < ${dayEnd(scope)}) AS jobs_created,
      (SELECT count(*)::int FROM jobs WHERE workspace_id = ${scope.workspaceId} AND requested_by = ${scope.userId}
        AND finished_at >= ${dayStart(scope)} AND finished_at < ${dayEnd(scope)}
        AND status = 'succeeded') AS jobs_completed,
      (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS learning_runs_created,
      (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}
        AND phase = 'completed') AS learning_runs_completed,
      (SELECT count(DISTINCT page_kind)::int FROM assistant_page_contexts
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS page_contexts,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS conversation_messages,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND role = 'user'
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS user_messages,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND role = 'assistant'
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS assistant_messages
  `);
  const row = (Array.isArray(rows) ? rows : [])[0] ?? {};
  return {
    notesCreated: Number(row.notes_created ?? 0),
    notesUpdated: Number(row.notes_updated ?? 0),
    cardsCreated: Number(row.cards_created ?? 0),
    sourcesCreated: Number(row.sources_created ?? 0),
    jobsCreated: Number(row.jobs_created ?? 0),
    jobsCompleted: Number(row.jobs_completed ?? 0),
    learningRunsCreated: Number(row.learning_runs_created ?? 0),
    learningRunsCompleted: Number(row.learning_runs_completed ?? 0),
    pageContexts: Number(row.page_contexts ?? 0),
    conversationMessages: Number(row.conversation_messages ?? 0),
    userMessages: Number(row.user_messages ?? 0),
    assistantMessages: Number(row.assistant_messages ?? 0),
  };
}

/**
 * 她的人格。
 *
 * 取值收窄的口径与对话链路一致（`companion-dialogue.ts:303-338`）：库里可能是
 * null / 数组 / 任意对象，不认识的当"没设置"，绝不原样透进 prompt。
 * 白名单直接用共享契约，不再抄第三份。
 */
async function collectPersona(tx: WorkerTransaction, scope: DayScope): Promise<DiaryPersona> {
  const rows = await tx.execute<{
    profile: unknown;
    revision: number;
  }>(sql`
    SELECT profile, revision
    FROM companion_persona_profiles
    WHERE user_id = ${scope.userId}
    LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  const profile = typeof row?.profile === "object" && row.profile !== null && !Array.isArray(row.profile)
    ? row.profile as Record<string, unknown>
    : null;
  if (!profile) {
    return {
      name: "伴星",
      personalityTags: [],
      speakingStyle: "",
      examples: [],
      activeness: null,
      boundaries: null,
      revision: Number(row?.revision ?? 0),
      defaultExpressionVersion: String(PET_PERSONA_PRESET_VERSION),
    };
  }
  const activeness = companionPersonaActivenessV1Schema.safeParse(profile.activeness);
  const boundaries = companionPersonaBoundariesV1Schema.safeParse(profile.boundaries);
  return {
    name: typeof profile.name === "string" ? profile.name : "伴星",
    personalityTags: Array.isArray(profile.personalityTags) ? profile.personalityTags.map(String) : [],
    speakingStyle: typeof profile.speakingStyle === "string" ? profile.speakingStyle : "",
    examples: Array.isArray(profile.examples)
      ? (profile.examples as Array<{ text?: unknown }>)
          .map((e) => slice(e.text, 200))
          .filter((text) => text.length > 0)
      : [],
    activeness: activeness.success ? activeness.data : null,
    boundaries: boundaries.success ? boundaries.data : null,
    revision: Number(row?.revision ?? 0),
    defaultExpressionVersion: String(PET_PERSONA_PRESET_VERSION),
  };
}

/**
 * 当天具体发生过什么。
 *
 * 关键是给"事"而不是给"数"：数量是旧实现被嫌弃的根因。学习量只给一个模糊的
 * 时长感（半小时/一个来小时），让她有措辞的依据，又不会把日记写成报表。
 */
async function collectMaterial(tx: WorkerTransaction, scope: DayScope): Promise<DiaryMaterial> {
  const pieces: DiaryPiece[] = [];
  // 发生过的事有几件——`quietDay` 的判据。页面轨迹不进这个数。
  let events = 0;

  const noteRows = await tx.execute<{
    at_local: string; title: string; note_id: string; version_id: string | null; created_today: boolean;
  }>(sql`
    SELECT ${clockOf(scope, "GREATEST(created_at, updated_at)")} AS at_local,
           left(title, 40) AS title,
           id::text AS note_id,
           current_version_id::text AS version_id,
           (created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS created_today
    FROM notes
    WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
      AND deleted_at IS NULL
      AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
        OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    ORDER BY GREATEST(created_at, updated_at) ASC
    LIMIT 5
  `);
  for (const row of Array.isArray(noteRows) ? noteRows : []) {
    pieces.push({
      text: `你${row.created_today ? "新建" : "改"}了笔记「${row.title}」`,
      group: "his", weight: 1, at: row.at_local, noteId: row.note_id,
      sourceId: row.note_id, sourceType: "note", sourceVersion: row.version_id ?? undefined,
    });
  }

  const sourceRows = await tx.execute<{ at_local: string; title: string; source_id: string }>(sql`
    SELECT ${clockOf(scope, "created_at")} AS at_local, left(title, 40) AS title, id::text AS source_id
    FROM sources
    WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ORDER BY created_at ASC
    LIMIT 4
  `);
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    pieces.push({
      text: `你收进来一份资料「${row.title}」`, group: "his", weight: 1, at: row.at_local,
      sourceId: row.source_id, sourceType: "source",
    });
  }

  // 学了什么：走 learning_tasks.target_summary。
  // **不能**用 learning_runs.goal——那一列是枚举（stabilize|clarify|…），
  // 喂进去她会说出"你正在学习 stabilize"（companion-here-and-now.ts:37-43 踩过）。
  const runRows = await tx.execute<{
    at_local: string; what: string | null; phase: string; run_id: string; source_version: string;
  }>(sql`
    SELECT ${clockOf(scope, "r.created_at")} AS at_local,
           r.id::text AS run_id, r.updated_at::text AS source_version,
           coalesce(nullif(t.target_summary, ''), nullif(t.prompt, '')) AS what,
           r.phase
    FROM learning_runs r
    LEFT JOIN learning_tasks t ON t.id = r.active_task_id
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND r.created_at >= ${dayStart(scope)} AND r.created_at < ${dayEnd(scope)}
    ORDER BY r.created_at ASC
    LIMIT 5
  `);
  for (const row of Array.isArray(runRows) ? runRows : []) {
    const what = slice(row.what, 60);
    if (!what) continue;
    pieces.push({
      text: `你坐下来学${row.phase === "completed" ? "完" : "了"}「${what}」`,
      group: "his", weight: 1, at: row.at_local,
      sourceId: row.run_id, sourceType: "learning_run", sourceVersion: row.source_version,
    });
  }

  const secondsRows = await tx.execute<{ seconds: string }>(sql`
    SELECT coalesce(sum(active_seconds_used), 0) AS seconds
    FROM learning_metric_events
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND occurred_at >= ${dayStart(scope)} AND occurred_at < ${dayEnd(scope)}
  `);
  const minutes = Number((Array.isArray(secondsRows) ? secondsRows : [])[0]?.seconds ?? 0) / 60;
  const lengthSense = minutes < 10 ? "一小会儿" : minutes < 40 ? "半小时上下" : minutes < 90 ? "一个来小时" : "好几个小时";
  // 以前这行末尾挂着一句「（这只是感觉，别在日记里报数）」——写给模型的说明写在素材里，
  // 等于请她抄：09-20 的日记原句就是「今天学了半小时上下」，一字不差。
  // 措辞改成事实口吻，报数由机器闸拦（`countingToneIn`）。
  if (minutes >= 1) {
    pieces.push({ text: `今天你坐下来学的时间：${lengthSense}`, group: "his", weight: 1, at: "" });
  }

  const pageRows = await tx.execute<{ page_kind: string }>(sql`
    SELECT DISTINCT page_kind
    FROM assistant_page_contexts
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND page_kind NOT IN ('other', 'home')
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    LIMIT 3
  `);
  const visited = (Array.isArray(pageRows) ? pageRows : [])
    .map((row) => PAGE_KIND_LABELS[row.page_kind] ?? row.page_kind)
    .filter((label) => label.length > 0);
  if (visited.length > 0) {
    pieces.push({ text: `你在这些页面上待过：${visited.join("、")}`, group: "backdrop", weight: 0, at: "" });
  }

  const reminderRows = await tx.execute<{ at_local: string; text: string; source_id: string }>(sql`
    SELECT ${clockOf(scope, "fired_at")} AS at_local, left(text, 60) AS text, id::text AS source_id
    FROM companion_reminders
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'fired'
      AND fired_at >= ${dayStart(scope)} AND fired_at < ${dayEnd(scope)}
    ORDER BY fired_at ASC
    LIMIT 3
  `);
  for (const row of Array.isArray(reminderRows) ? reminderRows : []) {
    pieces.push({
      text: `我提醒过你：${row.text}`, group: "her", weight: 2, at: row.at_local,
      sourceId: row.source_id, sourceType: "reminder",
    });
  }

  const thoughtRows = await tx.execute<{ at_local: string; text: string; source_id: string }>(sql`
    SELECT ${clockOf(scope, "delivered_at")} AS at_local, left(text, 60) AS text, id::text AS source_id
    FROM assistant_thoughts
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'delivered'
      AND delivered_at >= ${dayStart(scope)} AND delivered_at < ${dayEnd(scope)}
    ORDER BY delivered_at ASC
    LIMIT 3
  `);
  for (const row of Array.isArray(thoughtRows) ? thoughtRows : []) {
    pieces.push({
      text: `我主动开口说的是：${row.text}`, group: "her", weight: 2, at: row.at_local,
      sourceId: row.source_id, sourceType: "thought",
    });
  }

  const memoryRows = await tx.execute<{ content: string; memory_id: string; source_version: string }>(sql`
    SELECT left(content, 60) AS content, id::text AS memory_id, updated_at::text AS source_version
    FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      -- 排除本篇日记自己派生的那条，否则日记会引用自己。
      AND (source_event_id IS NULL OR source_event_id <> ${`daily-summary:${scope.date}`})
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ORDER BY created_at DESC
    LIMIT 3
  `);
  for (const row of Array.isArray(memoryRows) ? memoryRows : []) {
    pieces.push({
      text: `我记下来的：${row.content}`, group: "her", weight: 2, at: "",
      sourceId: row.memory_id, sourceType: "memory", sourceVersion: row.source_version,
    });
  }

  // 对话按**时间正序**给她（写日记要顺着当天走），但一天可能上百条：
  // 每个角色各留最近 12 条再还原时间序，比"取最后 24 条"更能留住上午那次认真的提问。
  const messageRows = await tx.execute<{
    at_local: string; role: string; text: string; source_id: string; source_version: string;
  }>(sql`
    WITH day AS (
      SELECT m.id, m.role, m.created_at, m.content_sha256,
             to_char(m.created_at AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS at_local,
             coalesce((SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(m.blocks) b
                        WHERE b->>'type' = 'text'), '') AS text,
             row_number() OVER (PARTITION BY m.role ORDER BY m.created_at DESC) AS recent_rank
      FROM companion_messages m
      WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${scope.userId}
        AND m.kind IN ('text', 'voice_transcript', 'proactive')
        AND m.created_at >= ${dayStart(scope)} AND m.created_at < ${dayEnd(scope)}
    )
    SELECT at_local, role, left(text, 120) AS text,
           id::text AS source_id, content_sha256 AS source_version
    FROM day
    WHERE recent_rank <= 12 AND length(trim(text)) > 0
    ORDER BY created_at ASC
  `);
  const touchedNotes = Array.isArray(noteRows) ? noteRows : [];
  const mentionedNoteId = (text: string) => touchedNotes.find(
    (note) => note.title.length >= 8 && text.includes(note.title),
  )?.note_id;
  let lastUserNote: { noteId: string; minute: number } | null = null;
  for (const row of Array.isArray(messageRows) ? messageRows : []) {
    // 她自己说过的话权重最高：用户裁定"日记的主角是她自己的日子"，而这是素材里
    // 唯一属于她的一天、且不是我们编的东西。他自己说的话退成背景。
    const minute = minuteOfDay(row.at_local);
    const directNoteId = mentionedNoteId(row.text);
    if (row.role === "assistant") {
      const noteId = directNoteId ?? (
        lastUserNote && minute !== null && minute >= lastUserNote.minute && minute - lastUserNote.minute <= 5
          ? lastUserNote.noteId : undefined
      );
      pieces.push({
        text: `我说：${row.text}`, group: "her", weight: diaryAssistantWeight(row.text), at: row.at_local, noteId,
        sourceId: row.source_id, sourceType: "companion_message", sourceVersion: row.source_version,
      });
    } else {
      lastUserNote = directNoteId && minute !== null ? { noteId: directNoteId, minute } : null;
      pieces.push({
        text: `你说：${row.text}`, group: "his", weight: 1, at: row.at_local, noteId: directNoteId,
        sourceId: row.source_id, sourceType: "companion_message", sourceVersion: row.source_version,
      });
    }
  }

  // 她一个人的时候在干什么——这是"有人味"的事实底座。
  // 没有这条，她只能写"今天陪了你多久"；有了空档，她才有一个属于自己的时间段可写。
  const rhythmRows = await tx.execute<{
    first_at: string | null; last_at: string | null; gap_label: number | null; gap_at: string | null;
  }>(sql`
    WITH msgs AS (
      SELECT created_at,
             lag(created_at) OVER (ORDER BY created_at) AS prev_at
      FROM companion_messages
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ),
    -- 最长空档必须「整行取」。写成 to_char(max(prev_at)) 配
    -- ORDER BY max(created_at - prev_at) 时，没有 GROUP BY 的整表就是一组，
    -- 排序排不出第二行，拿到的是"最后一次对话的起点"而不是"最长空档的起点"。
    -- 实测 09-20：真起点 07:49（空 2 小时），旧写法报 22:59。
    -- 这是我们自己造出来的假时刻，比模型编的更难被发现——她只是照抄。
    longest_gap AS (
      SELECT prev_at, created_at - prev_at AS length
      FROM msgs
      WHERE prev_at IS NOT NULL
      ORDER BY created_at - prev_at DESC
      LIMIT 1
    )
    SELECT to_char((SELECT min(created_at) FROM msgs) AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS first_at,
           to_char((SELECT max(created_at) FROM msgs) AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS last_at,
           (SELECT to_char(prev_at AT TIME ZONE ${scope.timezone}, 'HH24:MI') FROM longest_gap) AS gap_at,
           (SELECT round(extract(epoch FROM length) / 3600)::int FROM longest_gap) AS gap_label
  `);
  const rhythm = (Array.isArray(rhythmRows) ? rhythmRows : [])[0];
  if (rhythm?.first_at && rhythm.last_at) {
    // 时刻取整成"晚上八点多"：精确到分是她一天里不可能记住的东西，抄进日记就是日志腔。
    // 人称必须是「你」：这两行以前写"他第一次来找我是…"，而规则 1 要求她称对方为你——
    // 09-24 真跑里她第一段写"你"、第二段跟着素材切成"他回了句你好呀"。
    // 素材自己都不统一，就不能怪她抄。
    pieces.push({
      text: `你今天第一次来找我是 ${clockPhrase(rhythm.first_at)}，最后一次是 ${clockPhrase(rhythm.last_at)}`,
      group: "backdrop", weight: 0, at: "",
    });
    if (rhythm.gap_at && rhythm.gap_label !== null && rhythm.gap_label >= 2) {
      // 别说"中间"：空档未必在中间（实测 09-20 那段是从 07:49 起，紧挨着当天开头），
      // 她会把这个词原样抄进日记，变成一个我给的假位置。
      pieces.push({
        text: `从 ${clockPhrase(rhythm.gap_at)} 起有一阵你不在，那段时间是我自己的`,
        group: "backdrop", weight: 0, at: "",
      });
    }
  }

  // 可嵌进去的东西：当天碰过的笔记里的图与原文片段。
  // 上限是**天花板不是配额**（用户原话："想写就写，不想写就不写"）：
  // 图最多 6 张、引用最多 3 段（每篇笔记一条），她一篇日记里通常只会用到一两个。
  const embeds: DiaryEmbed[] = [];
  let imageRef = 0;
  let quoteRef = 0;
  const imageRows = await tx.execute<{
    object_key: string; width: number; height: number; note_title: string; note_id: string;
    position: string; nearby: string | null; mime_type: string; byte_size: number;
  }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title, current_version_id FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    ),
    -- 「这张图属于哪篇笔记」还是按 uploaded_for_note_id 认——与对话链路同一口径
    -- （companion-agent-runtime.ts 里"把那篇的第 N 张图给我看"就是这么找的）。
    -- 「第 N 张」也跟着那边的 created_at DESC, id 数，两个面不能各报一套序号。
    numbered AS (
      SELECT a.object_key, a.width, a.height, a.mime_type, a.byte_size,
             t.note_id, t.title AS note_title,
             t.current_version_id, place.version_id, place.ordinal,
             row_number() OVER (PARTITION BY t.note_id ORDER BY a.created_at DESC, a.id) AS position
      FROM note_image_assets a
      JOIN touched t ON t.note_id = a.uploaded_for_note_id
      -- 这张图在正文里插在哪：她看不见图里画的是什么（读图要外发字节，政策关着时读不到），
      -- 但"紧挨着它上面那段在说什么"是库里现成的信息，也是她给图写一句话的唯一依据。
      -- 优先认**当前版**正文里的位置；重复导入过的笔记（实测有一篇同名的 …-222）
      -- 图块还挂在上一版上，那就退回那一版——总比给她一张没有任何上下文的图强。
      LEFT JOIN LATERAL (
        SELECT b.version_id, b.ordinal
        FROM note_blocks b
        WHERE b.workspace_id = a.workspace_id AND b.image_asset_id = a.id
        ORDER BY (b.version_id = t.current_version_id) DESC, b.ordinal
        LIMIT 1
      ) place ON true
      WHERE a.workspace_id = ${scope.workspaceId} AND a.status = 'ready' AND a.deleted_at IS NULL
    )
    SELECT object_key, width, height, note_title, note_id::text, position::text, mime_type, byte_size,
           (SELECT left(b2.content, 48) FROM note_blocks b2
             WHERE b2.workspace_id = ${scope.workspaceId}
               AND b2.version_id = numbered.version_id
               AND b2.ordinal < numbered.ordinal
               AND b2.type IN ('paragraph', 'quote')
               AND length(trim(b2.content)) > 8
             ORDER BY b2.ordinal DESC LIMIT 1) AS nearby
    FROM numbered
    ORDER BY note_title, position
    LIMIT 12
  `);
  for (const row of pickImagesPerNote(Array.isArray(imageRows) ? imageRows : [])) {
    const ref = `图${(imageRef += 1)}`;
    const nearby = slice(row.nearby, 48);
    embeds.push({
      ref,
      kind: "image",
      url: sourceImageUrlFromObjectKey(row.object_key),
      noteId: row.note_id,
      // 28 字：够放下一整句标题（实测那种「IndexTTS 2.5 让声音跨越语言 - 哔哩哔哩」
      // 27 字），又不至于把她的图注（40 字）挤出 label 的 80 字上限之外。
      noteTitle: slice(row.note_title, 28),
      nth: Number(row.position ?? 1),
      nearby: nearby.length > 0 ? nearby : null,
      shape: imageShape(Number(row.width), Number(row.height)),
      objectKey: row.object_key,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      // 读图在 composeDiary 里做一次（一天最多一张，见 pickImageToRead）。
      description: null,
    });
  }

  const quoteRows = await tx.execute<{ content: string; note_title: string; note_id: string }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title, current_version_id FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    )
    -- 只收**一段就能引完**的段落：上限 180 与引用块的长度预算同源，超了整条不要。
    -- 旧写法是「取最长的、切 200 字」，于是 09-23 引了那篇笔记 251 字的推广导语，
    -- 还被硬切在「…宁愿推」；同一篇里 113 字的技术段落才是能引的那段。
    -- 同一段原文在库里可能存了好几份（重复导入），先按内容去重。
    SELECT DISTINCT ON (trim(b.content)) b.content AS content, t.title AS note_title, t.note_id::text AS note_id
    FROM note_blocks b
    JOIN touched t ON t.current_version_id = b.version_id
    WHERE b.workspace_id = ${scope.workspaceId}
      AND b.type IN ('quote', 'paragraph')
      AND length(trim(b.content)) BETWEEN 20 AND 180
    -- 按长度给候选池（长的更可能有内容），脏东西由 isQuotableQuote 在 TS 侧挑掉：
    -- 过滤规则要能写单测，也要能一眼读懂，不塞进 SQL 的正则里。
    ORDER BY trim(b.content), length(trim(b.content)) DESC, b.ordinal
    LIMIT 30
  `);
  for (const row of pickQuoteCandidates(Array.isArray(quoteRows) ? quoteRows : [])) {
    const text = slice(row.content, 180);
    if (!text) continue;
    const ref = `引${(quoteRef += 1)}`;
    const label = `《${slice(row.note_title, 24)}》里写着`.slice(0, 80);
    embeds.push({ ref, kind: "quote", label, text, noteId: row.note_id });
  }

  // 前几天的开头只认**有块的那些行**。
  // `blocks='[]'` 盖住两类：0250 之前那版拼统计句的行（把它当"你自己前几天的开头"
  // 喂回去，等于把刚请出去的数字从侧门再领进来），以及更早只存纯文本的行。
  // 后者是误伤——少一条可参照的开头而已，规则 12 的目的（别沿用同一句式）
  // 有一条就够用了，而新写的日子会自己把这份清单填起来。
  // 不用 `summary NOT LIKE '%的学习小结：%'` 那种写法去精确只排前者：
  // 那等于把已删除模板的字面量永久留在代码里。
  //
  // 意象取**近 6 篇**而不是同样 3 篇：跨篇复现要在够多的篇数上才看得出来，
  // 而这里判的是"她最近老在写什么"，那是几天的习惯，不是一篇的回声。
  const historyRows = await tx.execute<{ opening: string; summary: string }>(sql`
    SELECT left(summary, 24) AS opening, summary
    FROM companion_daily_summaries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND date < ${scope.date} AND status = 'generated' AND summary <> ''
      AND blocks <> '[]'::jsonb
    ORDER BY date DESC
    LIMIT 6
  `);
  const history = Array.isArray(historyRows) ? historyRows : [];

  const rowsIn = (rows: unknown) => (Array.isArray(rows) ? rows.length : 0);
  events =
    rowsIn(noteRows) + rowsIn(sourceRows) + rowsIn(runRows) + rowsIn(reminderRows)
    + rowsIn(thoughtRows) + rowsIn(memoryRows) + rowsIn(messageRows);

  const subject = pickDiarySubject(pieces);
  return {
    pieces,
    subject,
    embeds,
    previousOpenings: history.slice(0, 3).map((r) => r.opening),
    previousMotifs: recurringMotifs(history.map((r) => String(r.summary ?? ""))),
    quietDay: events === 0,
  };
}

const DIARY_TASK_TOTAL_BUDGET_MS = 100_000;
const DIARY_TASK_MODEL_CALLS = 4;
const DIARY_SELECTION_TASK_ID = "companion_diary_selection";
const DIARY_SELECTION_TASK_VERSION = 1;
const DIARY_DRAFT_TASK_ID = "companion_diary_draft";
const DIARY_DRAFT_TASK_VERSION = 1;

const diarySelectionCheckpointOutputSchema = z.object({
  selection: companionDiarySelectionSchema,
  callsSpent: z.number().int().min(1).max(2),
}).strict();

type DiarySelectionCheckpointOutput = z.infer<typeof diarySelectionCheckpointOutputSchema>;

const diaryDraftCheckpointOutputSchema = z.object({
  blocks: z.array(companionDailyBlockV1Schema).max(24),
  digest: z.string(),
}).strict();

class DiarySnapshotChangedError extends Error {
  constructor() {
    super("日记素材或启用期间已变化，旧选择不再适用");
    this.name = "DiarySnapshotChangedError";
  }
}

function diarySelectionInputHash(input: {
  scope: DayScope;
  persona: DiaryPersona;
  provider: { id: string; modelId: string; promptVersion: string };
  govCtx: AIGovernanceContext;
  candidates: DiaryCandidate[];
}): string {
  const messages = buildDiarySelectionMessages(input.scope.date, input.candidates);
  return createHash("sha256").update(JSON.stringify({
    task: DIARY_SELECTION_TASK_ID,
    taskVersion: DIARY_SELECTION_TASK_VERSION,
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    date: input.scope.date,
    timezone: input.scope.timezone,
    diaryEnabledSince: input.scope.diaryEnabledSince.toISOString(),
    persona: input.persona,
    providerId: input.provider.id,
    modelId: input.provider.modelId,
    providerPromptVersion: input.provider.promptVersion,
    policy: input.govCtx.policy,
    messages,
  })).digest("hex");
}

function diaryDraftInputHash(input: {
  scope: DayScope;
  sourceSnapshotHash: string;
  persona: DiaryPersona;
  provider: { id: string; modelId: string; promptVersion: string };
  govCtx: AIGovernanceContext;
  selectionReason: string;
  material: DiaryMaterial;
}): string {
  return createHash("sha256").update(JSON.stringify({
    task: DIARY_DRAFT_TASK_ID,
    taskVersion: DIARY_DRAFT_TASK_VERSION,
    sourceSnapshotHash: input.sourceSnapshotHash,
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    date: input.scope.date,
    timezone: input.scope.timezone,
    diaryEnabledSince: input.scope.diaryEnabledSince.toISOString(),
    persona: input.persona,
    providerId: input.provider.id,
    modelId: input.provider.modelId,
    providerPromptVersion: input.provider.promptVersion,
    policy: input.govCtx.policy,
    selectionReason: input.selectionReason,
    material: input.material,
  })).digest("hex");
}

async function readCurrentDiarySelectionSnapshot(
  tx: WorkerTransaction,
  scope: DayScope,
  provider: { id: string; modelId: string; promptVersion: string },
  govCtx: AIGovernanceContext,
): Promise<{ hash: string; candidates: DiaryCandidate[] } | null> {
  if (!(await diaryPermissionSnapshotIsCurrent(tx, scope.userId, provider, govCtx))) return null;
  const currentStart = await currentDiaryMaterialStart(tx, scope.userId);
  if (!currentStart || currentStart.valueOf() !== scope.diaryEnabledSince.valueOf()) return null;
  const currentScope = { ...scope, diaryEnabledSince: currentStart };
  const persona = await collectPersona(tx, currentScope);
  const material = await collectMaterial(tx, currentScope);
  const candidates = buildDiaryCandidates(material);
  return {
    hash: diarySelectionInputHash({ scope: currentScope, persona, provider, govCtx, candidates }),
    candidates,
  };
}

async function diaryPermissionSnapshotIsCurrent(
  tx: WorkerTransaction,
  userId: string,
  provider: { id: string },
  govCtx: AIGovernanceContext,
): Promise<boolean> {
  const rows = await tx.execute<{
    consent_version: string | null;
    consent_at: Date | string | null;
    data_policy: unknown;
  }>(sql`
    SELECT consent_version, consent_at, data_policy
    FROM user_ai_settings
    WHERE user_id = ${userId}
  `);
  const settings = (Array.isArray(rows) ? rows : [])[0];
  const currentPolicy = normalizeWorkspaceAIPolicy(settings?.data_policy);
  const samePolicy = JSON.stringify(currentPolicy) === JSON.stringify(govCtx.policy);
  const requiresConsent = [
    govCtx.providerName,
    govCtx.textProviderName,
    govCtx.visionProviderName,
    govCtx.embeddingProviderName,
  ].some((name) => name !== null && name.toLowerCase() !== "mock");
  const consentPresent = settings?.consent_version !== null && settings?.consent_version !== undefined
    && settings?.consent_at !== null && settings?.consent_at !== undefined;
  if (!samePolicy || !govCtx.consentOk) return false;
  if (requiresConsent && (!consentPresent || currentPolicy.sendToExternal !== true)) return false;
  // Also reject changes if only a non-companion capability is external; the consent
  // contract is account-wide, even when this particular request uses a mock model.
  if (requiresConsent && provider.id.toLowerCase() === "mock" && !consentPresent) return false;
  return true;
}

async function selectDiaryMoment(input: {
  job: JobPayload;
  userId: string;
  scope: DayScope;
  persona: DiaryPersona;
  govCtx: AIGovernanceContext;
  provider: ReturnType<typeof createProvider>;
  candidates: DiaryCandidate[];
  deadlineAt: number;
}): Promise<{
  selection: CompanionDiarySelection;
  candidate: DiaryCandidate | null;
  snapshotHash: string;
  callsSpent: number;
} | null> {
  const { job, userId, scope, persona, govCtx, provider, candidates } = input;
  const snapshotHash = diarySelectionInputHash({ scope, persona, provider, govCtx, candidates });
  let sourceChanged = false;
  let callsSpent = 0;
  let retryReason: string | null = null;

  const definition: AiTaskDefinition<{
    candidates: DiaryCandidate[];
  }, DiarySelectionCheckpointOutput> = {
    id: DIARY_SELECTION_TASK_ID,
    version: DIARY_SELECTION_TASK_VERSION,
    mode: "structured",
    resourceClass: "maintenance",
    budget: {
      maxModelCalls: Math.min(2, DIARY_TASK_MODEL_CALLS),
      stepTimeoutMs: Math.max(1, Math.min(resolveProviderCallTimeout("companion_daily_summary"), input.deadlineAt - Date.now())),
      taskDeadlineMs: Math.max(1, input.deadlineAt - Date.now()),
      maxAutoRetries: 1,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: provider.modelId, promptVersion: "diary-selection-v1", resourceClass: "maintenance" },
    prepare: async () => {
      const snapshot = await withJobTransaction(job, (tx) =>
        readCurrentDiarySelectionSnapshot(tx, scope, provider, govCtx));
      if (!snapshot || snapshot.hash !== snapshotHash) {
        sourceChanged = true;
        throw new DiarySnapshotChangedError();
      }
      return { candidates };
    },
    execute: async (prepared, env) => {
      callsSpent += 1;
      const messages = buildDiarySelectionMessages(scope.date, prepared.candidates, retryReason);
      try {
        const result = await provider.chatCompletion(
          messages,
          { temperature: 0.2, maxTokens: 600, responseFormat: "json_object" },
          env.signal,
        );
        const parsed = companionDiarySelectionSchema.safeParse(parseMemoryExtractJson(result.content));
        if (!parsed.success || !validateDiarySelection(parsed.data, prepared.candidates)) {
          retryReason = "输出不符合合同：候选之外的 id、来源 id 不匹配或 JSON 结构错误。请按给出的片段重新输出。";
          return { ok: false, class: "output_shape", message: retryReason };
        }
        return {
          ok: true,
          output: { selection: parsed.data, callsSpent },
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
        };
      } catch (err) {
        if (err instanceof AIConsentRequiredError || err instanceof AIDataPolicyDeniedError) throw err;
        throw err;
      }
    },
    commit: async (_ctx, _attempt, output) => {
      const current = await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, job);
        return readCurrentDiarySelectionSnapshot(tx, scope, provider, govCtx);
      });
      if (!current || current.hash !== snapshotHash) {
        sourceChanged = true;
        throw new DiarySnapshotChangedError();
      }
      return committedDiaryTask(output);
    },
  };

  const checkpoint = createDiaryCheckpointPort<DiarySelectionCheckpointOutput>({
    job,
    userId,
    personaVersion: {
      profileRevision: persona.revision,
      examplesRevision: persona.revision,
      defaultExpressionVersion: persona.defaultExpressionVersion ?? String(PET_PERSONA_PRESET_VERSION),
    },
    parseOutput(value) {
      const parsed = diarySelectionCheckpointOutputSchema.safeParse(value);
      return parsed.success && validateDiarySelection(parsed.data.selection, candidates) ? parsed.data : null;
    },
  });

  let receipt: AiTaskReceipt<DiarySelectionCheckpointOutput>;
  try {
    receipt = await runAiTask(definition, {
      ctx: diaryTaskContext(job, userId, definition.id, snapshotHash),
      attempt: diaryTaskAttempt(job, userId, definition),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: () => isJobLeaseActive(job),
      checkpoint,
    });
  } catch (err) {
    if (sourceChanged || err instanceof DiarySnapshotChangedError) return null;
    throw err;
  }
  if (sourceChanged) return null;
  if (receipt.outcome !== "committed" && receipt.outcome !== "resumed_and_committed") {
    if (receipt.failure?.class === "output_shape") {
      throw new DailyDiaryOutputError(`日记选材两次都不符合合同：${receipt.failure.message}`);
    }
    if (receipt.failure?.class === "cancelled" || job.signal?.aborted) return null;
    throw new Error(receipt.failure?.message ?? "日记选材步骤没有完成");
  }
  const output = receipt.output;
  if (!output || !validateDiarySelection(output.selection, candidates)) {
    throw new DailyDiaryOutputError("日记选材检查点不符合当前候选快照");
  }
  const candidate = output.selection.selected_id
    ? candidates.find((item) => item.id === output.selection.selected_id) ?? null
    : null;
  return { selection: output.selection, candidate, snapshotHash, callsSpent: output.callsSpent };
}

// ─── 编排 ────────────────────────────────────────────────────────────────

// ─── 生成 ────────────────────────────────────────────────────────────────

export function classifyDiaryFailure(err: unknown): DiaryFailureReason {
  if (err instanceof AIConsentRequiredError) return "consent_required";
  if (err instanceof AIDataPolicyDeniedError) return "consent_required";
  if (err instanceof AIProviderNotConfiguredError) return "consent_required";
  if (err instanceof DailyDiaryOutputError) return "diary_output_invalid";
  return "model_unavailable";
}

async function composeDiary(
  input: {
    job: JobPayload;
    userId: string;
    date: string;
    scope: DayScope;
    facts: DailyFacts;
    persona: DiaryPersona;
    material: DiaryMaterial;
    govCtx: AIGovernanceContext;
    provider: ReturnType<typeof createProvider>;
    snapshotHash: string;
    selectionReason: string;
    /** 0353：随正文一起落库的选中候选 id（选 null 时为 null）。 */
    selectedId: string | null;
    /** 0363：这一篇真正用到的真实事件 id，供撤权遮蔽匹配。 */
    sourceEventIds: string[];
    callsAvailable: number;
    deadlineAt: number;
  },
): Promise<DiaryDraft | null> {
  const { job, userId, date, scope, facts, persona, govCtx, provider } = input;
  const focusedMaterial = focusDiaryMaterial(input.material);
  const imageRead = await describeDiaryImage({
    job,
    userId,
    govCtx,
    material: focusedMaterial,
    deadlineAt: input.deadlineAt,
    callsAvailable: input.callsAvailable,
  });
  const diaryMaterial = imageRead.material;
  const draftSnapshotHash = diaryDraftInputHash({
    scope,
    sourceSnapshotHash: input.snapshotHash,
    persona,
    provider,
    govCtx,
    selectionReason: input.selectionReason,
    material: diaryMaterial,
  });
  const remainingCalls = input.callsAvailable - imageRead.callsUsed;
  const remainingMs = input.deadlineAt - Date.now();
  if (remainingCalls <= 0 || remainingMs <= 0) throw new Error("日记任务的剩余模型预算不足以成稿");

  let rejection: string | null = null;
  let snapshotChanged = false;
  const definition: AiTaskDefinition<{ material: DiaryMaterial }, DiaryDraft> = {
    id: DIARY_DRAFT_TASK_ID,
    version: DIARY_DRAFT_TASK_VERSION,
    mode: "structured",
    resourceClass: "maintenance",
    budget: {
      maxModelCalls: Math.min(2, remainingCalls),
      stepTimeoutMs: Math.max(1, Math.min(resolveProviderCallTimeout("companion_daily_summary"), remainingMs)),
      taskDeadlineMs: remainingMs,
      maxAutoRetries: Math.min(1, remainingCalls - 1),
    },
    completion: { kind: "structured_parsed" },
    usageContext: {
      modelId: provider.modelId,
      promptVersion: COMPANION_DIARY_DRAFT_PROMPT_VERSION,
      resourceClass: "maintenance",
    },
    prepare: async () => {
      const current = await withJobTransaction(job, (tx) =>
        readCurrentDiarySelectionSnapshot(tx, scope, provider, govCtx));
      if (!current || current.hash !== input.snapshotHash) {
        snapshotChanged = true;
        throw new DiarySnapshotChangedError();
      }
      return { material: diaryMaterial };
    },
    execute: async (prepared, env) => {
      if (rejection) logger.info({ jobId: job.id, retryIndex: env.retryIndex }, "companion diary draft rejected");
      try {
        const result = await provider.chatCompletion(
          buildDiaryPrompt({ date, persona, material: prepared.material, rejection }),
          { temperature: 0.6, maxTokens: DIARY_MAX_TOKENS, responseFormat: "json_object" },
          env.signal,
        );
        const parsed = diaryBlockDraftSchema.safeParse(parseMemoryExtractJson(result.content));
        if (!parsed.success) {
          rejection = "要的是 {\"blocks\":[…]} 这一个 JSON 对象，别的都不要输出。";
          return { ok: false, class: "output_shape", message: "日记 JSON 结构无效" };
        }
        const { blocks, droppedRefs, strippedRefs } = resolveDiaryBlocks(parsed.data, prepared.material.embeds);
        const digest = groundedDiaryDigest(prepared.material);
        // `droppedRefs` 现在有三类来源：不存在的编号、同一个编号重复用、以及每篇一图一引
// 的额度用满（§5.4）。文案按"丢掉了"写，不要只说"不认识的编号"——那样这条日志
// 在额度生效时会报一件没发生的事。
if (droppedRefs.length > 0) logger.warn({ jobId: job.id, date, droppedRefs }, "companion diary dropped embed refs");
        if (strippedRefs.length > 0) logger.warn({ jobId: job.id, date, strippedRefs }, "companion diary wrote embed refs into prose");
        const prose = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ");
        const retryable = (message: string) => {
          rejection = message;
          return { ok: false as const, class: "output_shape" as const, message };
        };
        if (prose.length < (prepared.material.quietDay ? 6 : 24)) {
          return retryable("正文太短，不像一篇日记。写一件今天真实发生过的事，再写你自己。");
        }
        // 地板比那句 24 字的旧判据宽，只在第一轮退：她写两遍还是这个长度就收下，
        // 宁可短一段，也不让这一天没有日记（口径与下面的上限、问句收尾一致）。
        if (env.retryIndex === 0) {
          const short = diaryLengthShortfall(
            blocks,
            persona.activeness,
            prepared.material.quietDay,
          );
          if (short) return retryable(short);
          const motif = repeatedMotifIn(blocks, prepared.material.previousMotifs);
          if (motif) {
            return retryable(
              `「${motif}」你前几天已经写过好几篇了。今天换个写法，`
              + "或者从今天的素材里换个角度写——别又落在同一个词上。",
            );
          }
        }
        const counted = countingToneIn(prose);
        if (counted) return retryable(`你在报数（${counted}）。重写，把数字全去掉。`);
        const firstAttempt = env.retryIndex === 0;
        const echo = exampleEchoIn(prose, persona.examples);
        if (echo && firstAttempt) return retryable(`你把人格例子里的原话搬进来了（「${echo}」）。同一个意思，用你自己的话说。`);
        const putdown = selfPutdownIn(prose);
        if (putdown && firstAttempt) return retryable(`你在道歉或自贬（「${putdown}」）。那件事照写，别配上这句。`);
        const captionEcho = captionEchoIn(parsed.data.blocks, prepared.material.embeds);
        if (captionEcho && firstAttempt) return retryable(`图注抄了别人转述给你的那句（「${captionEcho}」）。用你自己的话说一遍图里是什么。`);
        const firstParagraph = blocks.find((block) => block.type === "text");
        const repeated = firstParagraph?.type === "text"
          ? repeatedOpeningIn(firstParagraph.text, prepared.material.previousOpenings)
          : null;
        if (repeated && firstAttempt) return retryable(`今天的开头「${repeated}…」和你前几天写过的一样，换一个开头，也别只换几个字。`);
        if (endsInQuestion(blocks) && firstAttempt) {
          return retryable("你最后落在一个问句上。日记没有人回，把那句改成你当时怎么想的，或者直接停在那件事上。");
        }
        const thirdPerson = thirdPersonForUserIn(prose);
        if (thirdPerson && firstAttempt) return retryable(`你把他写成了「${thirdPerson}」。这篇是对着他本人写的，全程用「你」。`);
        const tooLong = diaryLengthOverflow(blocks, persona.activeness);
        if (tooLong && firstAttempt) return retryable(tooLong);
        const output: DiaryDraft = {
          blocks: z.array(companionDailyBlockV1Schema).max(24).parse(fitDiaryToParagraphBudget(blocks, persona.activeness)),
          digest,
        };
        return {
          ok: true,
          output,
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
        };
      } catch (err) {
        throw err;
      }
    },
    commit: async (_ctx, _attempt, output) => {
      const current = await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, job);
        return readCurrentDiarySelectionSnapshot(tx, scope, provider, govCtx);
      });
      if (!current || current.hash !== input.snapshotHash) {
        snapshotChanged = true;
        throw new DiarySnapshotChangedError();
      }
      return committedDiaryTask(output);
    },
  };

  let receipt: AiTaskReceipt<DiaryDraft>;
  try {
    receipt = await runAiTask(definition, {
      ctx: diaryTaskContext(job, userId, definition.id, draftSnapshotHash),
      attempt: diaryTaskAttempt(job, userId, definition),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: () => isJobLeaseActive(job),
      checkpoint: createDiaryCheckpointPort<DiaryDraft>({
        job,
        userId,
        personaVersion: {
          profileRevision: persona.revision,
          examplesRevision: persona.revision,
          defaultExpressionVersion: persona.defaultExpressionVersion ?? String(PET_PERSONA_PRESET_VERSION),
        },
        parseOutput(value) {
          const parsed = diaryDraftCheckpointOutputSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      }),
    });
  } catch (err) {
    if (snapshotChanged || err instanceof DiarySnapshotChangedError) return null;
    throw err;
  }
  if (snapshotChanged) return null;
  if (receipt.outcome !== "committed" && receipt.outcome !== "resumed_and_committed") {
    if (receipt.failure?.class === "output_shape") {
      throw new DailyDiaryOutputError(`桌宠日记正文两次都不合规矩：${rejection ?? receipt.failure.message}`);
    }
    if (receipt.failure?.class === "cancelled" || job.signal?.aborted) return null;
    throw new Error(receipt.failure?.message ?? "日记成稿步骤没有完成");
  }
  if (!receipt.output || job.signal?.aborted) return null;
  const persisted = await persistDiary(job, scope, facts, receipt.output, null, {
    expectedHash: input.snapshotHash,
    govCtx,
    provider,
    selectionReason: input.selectionReason,
    selectedId: input.selectedId,
    sourceEventIds: input.sourceEventIds,
    personaProfileRevision: persona.revision,
    personaExamplesRevision: persona.revision,
    defaultExpressionVersion: persona.defaultExpressionVersion ?? String(PET_PERSONA_PRESET_VERSION),
  });
  if (!persisted) return null;
  return receipt.output;
}

export async function runCompanionDailySummary(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名与读取走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名时编译器会在所有调用点报错。
  const date = readJobPayloadString(job.payload, "date");
  const timezone = readJobPayloadString(job.payload, "timezone");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!date || !timezone || !userId) {
    throw new Error("companion_daily_summary payload 缺 date/timezone/userId");
  }
  await assertJobLease(job);
  const baseScope = { workspaceId: job.workspaceId, userId, date, timezone };

  // 素材与人格先拿：失败行也要写真实 facts，否则一个失败日会静默打断
  // companion-thought 的连续学习天数计算（旧实现写的是 '{}'::jsonb）。
  const prepared = await withJobTransaction(job, async (tx) => {
    const diaryEnabledSince = await currentDiaryMaterialStart(tx, userId);
    if (!diaryEnabledSince) return null;
    const scope: DayScope = { ...baseScope, diaryEnabledSince };
    return {
      scope,
      facts: await collectFacts(tx, scope),
      persona: await collectPersona(tx, scope),
      material: await collectMaterial(tx, scope),
    };
  });
  // A job queued before pause can be claimed afterward. Treat it as an inert,
  // successful no-op; re-enabling creates a new material window and new jobs.
  if (!prepared) return;
  const { scope, facts, persona, material } = prepared;
  const candidates = buildDiaryCandidates(material);
  // Activity rows are only a scheduler hint. If none survive source, presentation,
  // and substance checks, leave the day blank without making a model call.
  if (!hasDiaryWorthyMaterial({ quietDay: material.quietDay, candidateCount: candidates.length })) return;

  let persistenceGuard: DiaryPersistenceGuard | undefined;
  const deadlineAt = Date.now() + DIARY_TASK_TOTAL_BUDGET_MS;
  try {
    const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
    if (!govCtx.consentOk) throw new AIConsentRequiredError();
    const textRes = resolveProviderForTask(govCtx, "companion_agent");
    const provider = createGovernedProvider(
      createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
      govCtx,
      job.workspaceId,
      { userId, operation: "companion_daily_diary", jobId: job.id, dataCategories: ["note_content"] },
    );
    const snapshotHash = diarySelectionInputHash({ scope, persona, provider, govCtx, candidates });
    persistenceGuard = {
      expectedHash: snapshotHash,
      govCtx,
      provider,
      // 选材还没跑：失败行若要落库，这几列如实为空，不拿"上一次"的顶上。
      // sourceEventIds 同理——没有素材就没有来源。
      selectedId: null,
      selectionReason: null,
      sourceEventIds: [],
      personaProfileRevision: persona.revision,
      personaExamplesRevision: persona.revision,
      defaultExpressionVersion: persona.defaultExpressionVersion ?? String(PET_PERSONA_PRESET_VERSION),
    };
    const selection = await selectDiaryMoment({
      job, userId, scope, persona, govCtx, provider, candidates, deadlineAt,
    });
    // A changed source or diary permission makes the attempt inert. A model's
    // explicit null is a successful selection result and also leaves the day blank.
    if (!selection) return;
    if (!selection.candidate) {
      logger.info({ jobId: job.id, date, selected: false }, "companion diary left blank by selection");
      return;
    }
    const provenance = diarySelectionProvenance(selection.selection);
    if (persistenceGuard) {
      persistenceGuard.selectionReason = provenance.selectionReason;
      // 0353：正文与选中 ID 必须成对落库，否则 A56 的"一致"事后无从核对。
      persistenceGuard.selectedId = provenance.selectedId;
    }
    const draft = await composeDiary({
      job,
      userId,
      date,
      scope,
      facts,
      persona,
      material: selection.candidate.material,
      govCtx,
      provider,
      snapshotHash: selection.snapshotHash,
      selectionReason: provenance.selectionReason,
      selectedId: provenance.selectedId,
      // 真正成稿用到的事件就是**选中候选自己声明的**那些——
      // 不是整个候选池，也不是模型在理由里随口提到的（§5.3「来源不足以支撑
      // 因果时只写已知部分」）。
      sourceEventIds: selection.candidate.sourceIds,
      callsAvailable: DIARY_TASK_MODEL_CALLS - selection.callsSpent,
      deadlineAt,
    });
    if (!draft) return;
  } catch (err) {
    if (err instanceof DiarySnapshotChangedError || job.signal?.aborted) return;
    const reason = classifyDiaryFailure(err);
    // 顺序是刻意的：**先记下真因，再试着写失败行**。
    // 那次写也可能失败（租约被抢、DB 抖动），让它抛出去就会把原始错误顶掉——
    // 日志里只剩一个"写失败行失败"，而真正的原因（没同意？模型空返回？）永远看不到。
    // 旧实现特意写了这条保护（"写入失败不应影响 job 重试流程"），改成 await 时被我弄丢过一次。
    logger.warn({ jobId: job.id, date, reason, err }, "companion diary generation failed");
    try {
      companionDiaryTotal.labels(reason).inc();
    } catch {
      // metrics 记录失败不阻断错误传播
    }
    try {
      const persisted = await persistDiary(job, scope, facts, null, reason, persistenceGuard);
      if (!persisted) return;
    } catch (persistErr) {
      logger.error({ jobId: job.id, date, err: persistErr }, "companion diary failure row not written");
    }
    throw err;
  }
  logger.info({ jobId: job.id, date, persona: persona.name }, "companion diary generated");
  try {
    companionDiaryTotal.labels("generated").inc();
  } catch {
    // metrics 记录失败不阻断
  }
}

/**
 * 落库时要一起带上的**选材溯源**。
 *
 * 只有一个来源：她**那一次**选择的结果。理由的文字与选中的 id 必须成对，
 * 所以这里不接受两个可以各自填的参数——那样迟早会配上"上一段的理由"。
 */
export interface DiaryPersistenceGuard {
  /** 成稿用的候选快照；提交前重算，不一致就不写（素材变了就别把旧稿按新的理由发布）。 */
  expectedHash: string;
  govCtx: AIGovernanceContext;
  provider: ReturnType<typeof createProvider>;
  /** 0353：她选中的候选 id。选择允许 null，这时如实记 null，不拿别的值顶上。 */
  selectedId: string | null;
  /**
   * 这一篇真正用到的真实事件 id（0363）。
   *
   * 撤权遮蔽（§11.1 第 6 行）靠它匹配「这篇用了这份材料」。没有它，撤权时
   * 只能要么把所有日记都遮掉、要么一篇都不遮——两种都错。
   *
   * 注意**不要**把候选的 id 存进来：那是选材目录里的条目，不是事件本身。
   * 存的是候选自己声明的 sourceIds（消息 id / 笔记 id / 来源 id）。
   */
  sourceEventIds: string[];
  selectionReason: string | null;
  personaProfileRevision: number;
  personaExamplesRevision: number;
  defaultExpressionVersion: string;
}

/**
 * 把「她选了什么」折成落库用的两列。
 *
 * 为什么单独成函数（而不是在两处各写一句）：A56 的「正文与选中 ID 一致」要能
 * 事后核对，就要求 id 与理由**必然**来自同一次选择。0353 之前只落了理由的文字，
 * 于是成稿那一行没有任何字段能把正文接回选材——这道验收只能靠"再问她一次"。
 *
 * `null` 的两种来源都如实落 null：`selected_id: null` 是她**明确没选**（§5.7.5 允许，
 * 那天随后会留白），而"还没走到选择"由 guard 的初值承担。写一个别的值才是编造。
 * 调用方拿到的两个字段同源，没有配错的余地。
 */
export function diarySelectionProvenance(
  selection: Pick<CompanionDiarySelection, "selected_id" | "reason_summary">,
): { selectedId: string | null; selectionReason: string } {
  return {
    selectedId: selection.selected_id,
    selectionReason: sanitizePersonaField(selection.reason_summary, 240),
  };
}

/**
 * 发布（或记失败）的 upsert。
 *
 * 抽成纯函数只为能被测：`§5.5/§13 A20` 的「已发布成稿不因后台重跑静默替换」
 * 以前只是这条 SQL 末尾那一句 `WHERE status <> 'generated'`——它一旦被改写，
 * 没有任何测试会红。返回的语句可以被 `PgDialect.sqlToQuery` 摊开逐句核对。
 */
export function diarySummaryUpsertSql(input: {
  scope: DayScope;
  facts: DailyFacts;
  draft: DiaryDraft | null;
  failureReason: DiaryFailureReason | null;
  guard: DiaryPersistenceGuard | undefined;
}) {
  // `blocks` 是展示面（0252）；`summary` 是它的纯文本投影，给"前几天开头"这类
  // 只要一句话的读法用，也保住 0252 之前那些只有文字的历史行。
  const paragraphs = input.draft
    ? input.draft.blocks.filter((block) => block.type === "text").map((block) => block.text)
    : [];
  // `source_event_ids` 是 text[]：必须给字面量，不能给 JS 数组。postgres.js 把数组
  // 序列化成行构造器 `($1,$2)`，空数组直接是 `()`——两条分支（选材前失败 / 成稿）
  // 都会在这里炸，日记一篇都落不了库（09-30 起连续 6 天，详见 pg-text-array.ts）。
  const sourceEventIdsLiteral = toTextArrayLiteral(input.guard?.sourceEventIds ?? []);
  return sql`
    INSERT INTO companion_daily_summaries
      (workspace_id, user_id, date, timezone, facts, blocks, summary, selection_reason, selected_id,
       source_event_ids, persona_profile_revision, persona_examples_revision, default_expression_version,
       status, failure_reason, revision, generated_at, created_at, updated_at)
    VALUES
      (${input.scope.workspaceId}, ${input.scope.userId}, ${input.scope.date}, ${input.scope.timezone},
       ${JSON.stringify(input.facts)}::jsonb,
       ${JSON.stringify(input.draft ? input.draft.blocks : [])}::jsonb,
       ${paragraphs.join("\n\n")},
       ${input.guard?.selectionReason ?? null},
       ${input.guard?.selectedId ?? null},
       ${sourceEventIdsLiteral}::text[],
       ${input.guard?.personaProfileRevision ?? null},
       ${input.guard?.personaExamplesRevision ?? null},
       ${input.guard?.defaultExpressionVersion ?? null},
       ${input.draft ? "generated" : "failed"},
       ${input.failureReason},
       1, now(), now(), now())
    ON CONFLICT (workspace_id, user_id, date)
    DO UPDATE SET timezone = EXCLUDED.timezone, facts = EXCLUDED.facts,
                  blocks = EXCLUDED.blocks, summary = EXCLUDED.summary, status = EXCLUDED.status,
                  selection_reason = EXCLUDED.selection_reason,
                  selected_id = EXCLUDED.selected_id,
                  source_event_ids = EXCLUDED.source_event_ids,
                  persona_profile_revision = EXCLUDED.persona_profile_revision,
                  persona_examples_revision = EXCLUDED.persona_examples_revision,
                  default_expression_version = EXCLUDED.default_expression_version,
                  -- 先失败后成功的日子必须把原因清掉，否则界面上"没能写下来"和正文同时存在。
                  failure_reason = EXCLUDED.failure_reason,
                  revision = companion_daily_summaries.revision + 1,
                  generated_at = now(), updated_at = now()
    -- 已经写成的日子不被一次**失败的重跑**抹掉。09-24 实跑踩到：重跑那天第一次
    -- 不合规矩，失败行把 revision 1 的正文清成了空块，屏幕上从"有日记"变成
    -- "她没能写下来"——那天的日记其实早就写好了。失败仍然记在 job 的 last_error 与日志里。
    -- 0353 新加的 selected_id 在**这条守卫之内**：一次后台重跑同样不许把已发布
    -- 成稿连同它的选中 id 一起换成新的那一份，否则"正文与选中 ID 一致"会被重跑
    -- 自己改写成"与重跑那次的 ID 一致"。
    WHERE companion_daily_summaries.status <> 'generated'
  `;
}

async function persistDiary(
  job: JobPayload,
  scope: DayScope,
  facts: DailyFacts,
  draft: DiaryDraft | null,
  failureReason: DiaryFailureReason | null,
  guard?: DiaryPersistenceGuard,
): Promise<boolean> {
  // §15.4.4：失败也落一行，页面据此显示"这一天她没能写下来"＋成因。
  // 写入失败不该盖掉真正的失败原因，所以调用方在 catch 里不再处理这里的异常。
  return await withJobTransaction(job, async (tx) => {
    // LLM 调用发生在事务之外，中间可能已经跨过租约：提交前重新校验并续租，
    // 否则被 reap 之后另一个 worker 会重领同一 job、重复写也重复计费（同 summarizer 的 TOCTOU 围栏）。
    await lockJobLease(tx, job);
    if (!(await diaryMaterialStartIsCurrent(tx, scope.userId, scope.diaryEnabledSince))) return false;
    if (guard) {
      const current = await readCurrentDiarySelectionSnapshot(tx, scope, guard.provider, guard.govCtx);
      if (!current || current.hash !== guard.expectedHash) return false;
    }
    await tx.execute(diarySummaryUpsertSql({ scope, facts, draft, failureReason, guard }));
    if (!draft) return true;
    // §9.4：写入端即限制 ≤200 字，确保读取注入时不需截断、不丢失信息。
    // 存 digest（事实备忘）而不是 diary 正文：候选一旦被确认就每轮注入，
    // 让主观创作进记忆等于给她下一轮的引用提供一个"出处"。
    const memoryContent = `${scope.date} 桌宠日记：${draft.digest}`.slice(0, 200);
    if (countingToneIn(draft.digest) || draft.digest.length === 0) return true;
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${scope.workspaceId}, ${scope.userId}, 'learning_context', ${memoryContent},
         ${`daily-summary:${scope.date}`}, false, false, true, 0.5, 0.7, 'workspace', 'summary', 'pending', now(), now())
      ON CONFLICT (workspace_id, user_id, kind, source_event_id)
        WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
      DO NOTHING
    `);
    return true;
  });
}
