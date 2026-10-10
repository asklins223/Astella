/**
 * 伴星身份（账号人格）的**共享事务端口**（方案 50 §9.3 / §13）。
 *
 * ## 为什么这一份要住在 agent-host
 *
 * 她改自己人格的写入，原来只有前台工具那一条路径（worker 的 `companion-persona-self-edit`）。
 * 后台反思接进来之后就有了**第二个写入者**：如果反思再抄一遍
 * `SELECT … FOR UPDATE → 判断 → UPDATE → 插版本行`，那么「用户草稿优先」「排队不推当前版本」
 * 「版本号排在队尾」这几条规矩就变成两处各自维护——早晚漂成两种行为，而漂的那一次是
 * 悄悄发生的（用户看到的是人格页上一句没提过的自我描述生效了）。
 *
 * 所以写入收在这里：API（新回合采用）与 worker（前台工具、后台反思）都调同一个函数，
 * 双方只带各自的**围栏**进来（提案身份、来源快照、期望的 pending 引用）。
 *
 * ## 提案身份：这一版是谁提的
 *
 * `author='assistant_tool'` 只说正文归她，答不出「出自哪一次提议」。少了这一层，
 * 上一轮**没被采用**的一条排队，会被下一轮（或另一个空间的反思）当成自己的底稿继续往上改
 * ——两条互不相干的建议合成一版，而用户只提过一次要求。
 *
 * 现在版本行上记 `(proposal_kind, proposal_id)`：同一次前台 run 的连续修改可以延续
 * （改了语气再改标签，两项都要留下）；**不同提案**不盲合，新提议回到当前生效的那一版重评，
 * 旧的那版仍在历史里可查可恢复（§9.3 那张表里的两种情况）。
 *
 * 老数据没有这两个键，读作「来源不明的历史提议」：不猜它出自谁，也不拿它当延续的底稿判断依据。
 */

import { sql } from "drizzle-orm";
import {
  PERSONA_FIELD_CAPACITY,
  personaFromDefaultPreset,
  withAssistantEditedField,
  type PersonaAssistantEditableField,
} from "@astella/shared/pet-persona-merge";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import {
  type CompanionPersonaProfileContent,
  type CompanionPersonaProposalKind,
  type CompanionPersonaProfileVersionAuthor,
} from "@astella/shared/db-schema/companion-memory";
import type { AgentSqlExecutor } from "./store.ts";
import { queryRows } from "./store.ts";

/** 一次提议出自谁：前台的某次运行，或后台的某次反思。 */
export type CompanionPersonaProposalV1 = {
  readonly kind: CompanionPersonaProposalKind;
  /** 前台是 runId，后台是 reflectionId。同 id 视为同一次提议，可以延续。 */
  readonly proposalId: string;
};

/** 排队中那一版对外暴露的形状（指针 + 不可变正文 + 提案身份）。 */
export type CompanionPersonaPendingProposalV1 = {
  readonly revision: number;
  readonly author: CompanionPersonaProfileVersionAuthor;
  readonly profile: CompanionPersonaProfileContent | null;
  readonly proposalKind: CompanionPersonaProposalKind | null;
  readonly proposalId: string | null;
  readonly sourceWorkspaceId: string | null;
};

export type CompanionPersonaCommitFailureV1 =
  /** 她手上的人格版本已经不是当前版本（用户改过、或另一笔写入推走了）。 */
  | "revision_moved"
  /** 排队的是**用户自己**的草稿：那是一次进行中的决定，不是她的改稿底稿。 */
  | "user_draft_pending"
  /** 调用方声明的 pending 引用与库里的那一版不是同一版：它读到的东西已经不在了。 */
  | "pending_reference_moved"
  /** 账号档案行读不到（不该发生，交给调用方按"请重试"处理）。 */
  | "profile_row_missing";

export type CompanionPersonaCommitOutcomeV1 =
  | {
      readonly kind: "changed";
      readonly revision: number;
      readonly profile: CompanionPersonaProfileContent;
      /**
       * 被这一版**顶掉**的旧排队版本号（不同提案的未采用提议）。
       * 那一版仍在不可变历史里，用户仍能在人格页看到并恢复；丢的只是"还在排队"。
       */
      readonly supersededPendingRevision?: number;
    }
  | { readonly kind: "unchanged"; readonly profile: CompanionPersonaProfileContent }
  | { readonly kind: "conflict"; readonly reason: CompanionPersonaCommitFailureV1 };

/** 她能改的项与字符容量；越界的值在落库前就被收住，不靠调用方各自记得切。 */
function clampAssistantEdit(field: PersonaAssistantEditableField, value: unknown): unknown {
  if (field === "selfDescription") {
    const text = typeof value === "string" ? value.trim().slice(0, PERSONA_FIELD_CAPACITY.selfDescription) : "";
    if (text.length === 0) throw new Error("selfDescription edit requires non-empty text");
    return text;
  }
  if (field === "speakingStyle") {
    return typeof value === "string" ? value.slice(0, PERSONA_FIELD_CAPACITY.speakingStyle) : value;
  }
  if (field === "personalityTags") {
    if (!Array.isArray(value)) return value;
    return value.map((tag) => String(tag).slice(0, PERSONA_FIELD_CAPACITY.personalityTags));
  }
  if (field === "boundaries.catchphrase") {
    return typeof value === "string" ? value.slice(0, PERSONA_FIELD_CAPACITY.catchphrase) : value;
  }
  return value;
}

/** 库里的 profile 列什么形状都可能：null、数组、任意对象。不认识的当"没有档案"。 */
function readProfile(value: unknown): CompanionPersonaProfileContent | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as CompanionPersonaProfileContent
    : null;
}

/**
 * 锁住账号档案行。第一次写入也要能锁住，所以先 `INSERT … ON CONFLICT DO NOTHING`：
 * 两个人同时在"还没有档案"的账号上起手时，没有这一句就会各起一份、后一个撞唯一键。
 */
async function lockPersonaProfileRow(
  tx: AgentSqlExecutor,
  userId: string,
): Promise<{ revision: number; profile: unknown; pending_revision: number | null } | null> {
  await tx.execute(sql`
    INSERT INTO companion_persona_profiles (user_id, revision, profile)
    VALUES (${userId}, 0, NULL)
    ON CONFLICT (user_id) DO NOTHING
  `);
  const rows = await queryRows<{ revision: number; profile: unknown; pending_revision: number | null }>(tx, sql`
    SELECT revision, profile, pending_revision FROM companion_persona_profiles
    WHERE user_id = ${userId}
    LIMIT 1
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * 读排队中的那一版（指针 join 不可变版本行）。
 *
 * 必须在档案行已被锁住之后调用，否则读到的指针与随后的写入不是同一份。
 */
export async function readPendingPersonaProposal(
  tx: AgentSqlExecutor,
  userId: string,
): Promise<CompanionPersonaPendingProposalV1 | null> {
  const rows = await queryRows<{
    revision: number;
    profile: unknown;
    author: CompanionPersonaProfileVersionAuthor;
    proposal_kind: CompanionPersonaProposalKind | null;
    proposal_id: string | null;
    source_workspace_id: string | null;
  }>(tx, sql`
    SELECT v.revision, v.profile, v.author, v.proposal_kind, v.proposal_id, v.source_workspace_id
    FROM companion_persona_profiles p
    JOIN companion_persona_profile_versions v
      ON v.user_id = p.user_id AND v.revision = p.pending_revision
    WHERE p.user_id = ${userId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    revision: Number(row.revision),
    author: row.author,
    profile: readProfile(row.profile),
    proposalKind: row.proposal_kind ?? null,
    proposalId: row.proposal_id ?? null,
    sourceWorkspaceId: row.source_workspace_id ?? null,
  };
}

/** 同一次提议的判定：两边都有身份且不同，才算「不相干的另一笔」。 */
function isSameProposal(
  pending: CompanionPersonaPendingProposalV1,
  proposal: CompanionPersonaProposalV1 | undefined,
): boolean {
  if (!proposal) return true;
  if (!pending.proposalKind || !pending.proposalId) return true;
  return pending.proposalKind === proposal.kind && pending.proposalId === proposal.proposalId;
}

export interface CompanionPersonaCommitInputV1 {
  readonly edits: readonly { readonly field: PersonaAssistantEditableField; readonly value: unknown }[];
  readonly reason: string;
  /** true = 只排队，不动当前生效版本；false = 立刻生效（用户明确要求的设置走这条）。 */
  readonly stage: boolean;
  /** 调用方读到的当前版本；不匹配就不写（模型拿的是本轮开始时固定的那一版）。 */
  readonly expectedRevision?: number;
  /** 调用方读到的那一版排队；库里已经换了别的版本时不写。 */
  readonly expectedPendingRevision?: number | null;
  /** 这次写入出自哪一次提议；不给就按"延续当前排队"处理（沿用改造前的语义）。 */
  readonly proposal?: CompanionPersonaProposalV1;
  /** 反思等后台来源要能把自己关联到这一版；由调用方在同一事务里写。 */
  readonly onVersionWritten?: (revision: number, profile: CompanionPersonaProfileContent) => Promise<void>;
}

/**
 * 提交一次她自己提出的人格修订（唯一写入口）。
 *
 * 顺序规矩有两条是库里强制的，写反了当场撞约束（见 0355）：
 *  1. **先**插不可变版本行，**再**把 `pending_revision` 指过去（复合外键）；
 *  2. 任何把**当前**版本往前推的写入，**先**清指针再推 revision（CHECK 即时校验）。
 *
 * 版本号走「当前与排队里更大的 +1」，直接写死会在排队版本更新时撞 CHECK。
 */
export async function commitPersonaProposalV1(
  tx: AgentSqlExecutor,
  userId: string,
  input: CompanionPersonaCommitInputV1,
  options: { readonly sourceWorkspaceId?: string | null } = {},
): Promise<CompanionPersonaCommitOutcomeV1> {
  if (input.edits.length === 0) throw new Error("commitPersonaProposalV1 requires at least one edit");
  const row = await lockPersonaProfileRow(tx, userId);
  if (!row) return { kind: "conflict", reason: "profile_row_missing" };
  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
    return { kind: "conflict", reason: "revision_moved" };
  }

  const staged = input.stage && row.pending_revision !== null
    ? await readPendingPersonaProposal(tx, userId)
    : null;
  let supersededPendingRevision: number | undefined;
  if (input.stage && row.pending_revision !== null && !staged) {
    // 指针指向的版本行读不出来：不猜它当初是什么内容，也不往一个读不到的排队上叠改动。
    return { kind: "conflict", reason: "pending_reference_moved" };
  }
  if (input.expectedPendingRevision !== undefined
    && input.expectedPendingRevision !== (staged?.revision ?? row.pending_revision ?? null)) {
    return { kind: "conflict", reason: "pending_reference_moved" };
  }
  if (staged && staged.author !== "assistant_tool") {
    return { kind: "conflict", reason: "user_draft_pending" };
  }

  const effective = readProfile(row.profile);
  let base = effective;
  if (staged && isSameProposal(staged, input.proposal)) {
    // 同一次提议的连续修改：在排队那一版上接着改，两项都留下。
    base = staged.profile ?? effective;
  } else if (staged) {
    // 不相干的一笔还没被采用：不并到它上面，回到**当前生效**的版本重评，
    // 并把那一版顶掉（它仍在历史里）。
    supersededPendingRevision = staged.revision;
  }
  // 账号还没有档案：拿系统默认人格当底稿，她改的是"当前生效的那份人格"。
  const starting = base ?? personaFromDefaultPreset(getDefaultPersonaPreset());
  const next = input.edits.reduce<CompanionPersonaProfileContent>(
    (profile, edit) => withAssistantEditedField(profile, edit.field, clampAssistantEdit(edit.field, edit.value)),
    starting,
  );

  // 比的是**内容**，不是整个对象：`fieldOrigin` 正是这一行改出来的，拿它参与比较
  // 会让"改成一样的值"也算改——版本被推高而屏上没变，更要命的是那一项从此被标成
  // "她改的"，以后每次换人格都要多问一句。
  const { fieldOrigin: _ignored, ...nextContent } = next;
  const { fieldOrigin: _alsoIgnored, ...baseContent } = starting;
  if (JSON.stringify(nextContent) === JSON.stringify(baseContent)) {
    return { kind: "unchanged", profile: starting };
  }

  const nextRevision = Math.max(row.revision, row.pending_revision ?? 0) + 1;
  const proposalKind = input.proposal?.kind ?? null;
  const proposalId = input.proposal?.proposalId ?? null;

  if (input.stage) {
    await tx.execute(sql`
      INSERT INTO companion_persona_profile_versions
        (user_id, revision, examples_revision, author, action, reason, profile,
         module_scope, source_workspace_id, proposal_kind, proposal_id)
      VALUES (${userId}, ${nextRevision}, ${nextRevision}, 'assistant_tool', 'update',
              ${input.reason}, ${JSON.stringify(next)}::jsonb,
              ARRAY['companion']::text[],
              ${options.sourceWorkspaceId ?? null}::uuid,
              ${proposalKind}, ${proposalId})
    `);
    await tx.execute(sql`
      UPDATE companion_persona_profiles SET pending_revision = ${nextRevision}
      WHERE user_id = ${userId} AND revision = ${row.revision}
    `);
    await input.onVersionWritten?.(nextRevision, next);
    return {
      kind: "changed",
      revision: nextRevision,
      profile: next,
      ...(supersededPendingRevision === undefined ? {} : { supersededPendingRevision }),
    };
  }

  // 立刻生效：一条 upsert 同时把当前版本推上去并清掉排队指针（0355 的 CHECK
  // 要求这两件事不能让 revision 先走），然后留一行历史。
  const saved = await queryRows<{ revision: number; profile: unknown }>(tx, sql`
    INSERT INTO companion_persona_profiles (user_id, revision, profile, updated_at)
    VALUES (${userId}, ${nextRevision}, ${JSON.stringify(next)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE
      SET profile = EXCLUDED.profile,
          revision = EXCLUDED.revision,
          pending_revision = NULL,
          updated_at = now()
      WHERE companion_persona_profiles.revision = ${row.revision}
    RETURNING revision, profile
  `);
  const updated = saved[0];
  if (!updated) return { kind: "conflict", reason: "revision_moved" };
  const profile = readProfile(updated.profile) ?? next;
  await tx.execute(sql`
    INSERT INTO companion_persona_profile_versions
      (user_id, revision, examples_revision, author, action, reason, profile,
       module_scope, source_workspace_id, proposal_kind, proposal_id)
    VALUES (${userId}, ${updated.revision}, ${updated.revision},
            'assistant_tool', 'update', ${input.reason},
            ${JSON.stringify(profile)}::jsonb,
            ARRAY['companion']::text[],
            ${options.sourceWorkspaceId ?? null}::uuid,
            ${proposalKind}, ${proposalId})
  `);
  await input.onVersionWritten?.(Number(updated.revision), profile);
  return { kind: "changed", revision: Number(updated.revision), profile };
}

/**
 * 来源引用：一次提议凭什么这么说（方案 50 §8.3 的有类型派生来源）。
 *
 * `revision` 存的是**那一版来源的身份证据**：记忆用 revision 号，消息用内容哈希
 * （`companion_messages` 没有软删列，改写就是新内容）。没有它就只能判断"还在不在"，
 * 判不出"还是不是当初那一条"。
 */
export type CompanionPersonaSourceRefV1 = {
  readonly kind: "user_message" | "assistant_message" | "memory" | "tool_receipt"
    | "persona_revision" | "method";
  readonly id: string;
  readonly revision?: string | null;
};

/**
 * 逐条核对提议的依据此刻还成不成立。
 *
 * 这里只回答**存在性与版本**（原文有没有被删、记忆有没有被删、版本对不对得上），
 * 不回答"内容还支不支持那句结论"——那是新一次反思读到时才做的判断。
 */
export async function personaSourcesCurrent(
  tx: AgentSqlExecutor,
  userId: string,
  sources: readonly CompanionPersonaSourceRefV1[],
): Promise<{ readonly current: boolean; readonly dead: CompanionPersonaSourceRefV1[] }> {
  const dead: CompanionPersonaSourceRefV1[] = [];
  for (const source of sources) {
    const exists = await queryRows<{ found: number }>(tx, sourceProbeSql(source, userId));
    if (Number(exists[0]?.found ?? 0) === 0) dead.push(source);
  }
  return { current: dead.length === 0, dead };
}

function sourceProbeSql(source: CompanionPersonaSourceRefV1, userId: string) {
  const revision = source.revision ?? null;
  switch (source.kind) {
    // 消息被删除就是行不在了（硬删），改写会换 content_sha256。
    case "user_message":
    case "assistant_message":
      return sql`SELECT count(*)::int AS found FROM companion_messages m
        WHERE m.id = ${source.id}::uuid AND m.user_id = ${userId}
          AND (${revision}::text IS NULL OR m.content_sha256 = ${revision}::text)`;
    case "memory":
      return sql`SELECT count(*)::int AS found FROM assistant_memory_items a
        WHERE a.id = ${source.id}::uuid AND a.user_id = ${userId} AND a.deleted_at IS NULL
          AND (${revision}::text IS NULL OR a.revision::text = ${revision}::text)`;
    case "tool_receipt":
      return sql`SELECT count(*)::int AS found FROM companion_agent_tool_calls c
        WHERE c.id = ${source.id}::uuid AND c.user_id = ${userId}`;
    case "persona_revision":
      return sql`SELECT count(*)::int AS found FROM companion_persona_profile_versions v
        WHERE v.user_id = ${userId} AND v.revision::text = ${source.id}
          AND (${revision}::text IS NULL OR v.revision::text = ${revision}::text)`;
    case "method":
      // 方法条目没有软删列：停用走 `method_state`，所以"还在不在"按行与版本核。
      return sql`SELECT count(*)::int AS found FROM companion_procedural_playbooks p
        WHERE p.id = ${source.id}::uuid AND p.user_id = ${userId}
          AND (${revision}::text IS NULL OR p.version::text = ${revision}::text)`;
  }
}

/**
 * 提议还剩几条**站得住的依据**（§9.4 的「同一内容尚有独立有效依据时重新评估」）。
 *
 * 判据是"至少一条还在"，不是"全部都在"：一条结论引用了五句话，用户删掉了其中一句
 * 不该让整条结论失去依据——那样等于把"删除一条消息"变成"撤回她的一次成长"。
 * 反过来，**所有**依据都被删除或换版时，这一版就真的没有根据了，不能再被采用。
 */
export async function personaProposalHasLiveBasis(
  tx: AgentSqlExecutor,
  userId: string,
  sources: readonly CompanionPersonaSourceRefV1[],
): Promise<boolean> {
  if (sources.length === 0) return true;
  const dead = await personaSourcesCurrent(tx, userId, sources);
  return dead.dead.length < sources.length;
}

/**
 * 下一条被接受的新用户消息采用排队那一版（40 §4.8.4 / 方案 50 §9.4）。
 *
 * 采用前**必须**再核对一次来源：一条建议的依据可能在排队期间被删掉、被纠正，
 * 或者它引用的那一版记忆已经不是当初的那一版。核对不过就不提交旧建议，
 * 并把指针清掉——已经失去依据的自动改变不该留在人格里。
 *
 * 只采用**她**排的那一版：用户自己暂存的草稿仍然要用户明确点"生效"。
 * 读取页面、重试、恢复、幂等重放都不走这里（调用方只在"新回合被接受"的那条事务里调）。
 */
export async function adoptPendingPersonaForNewTurn(
  tx: AgentSqlExecutor,
  userId: string,
  resolveSources?: (pending: CompanionPersonaPendingProposalV1) => Promise<readonly CompanionPersonaSourceRefV1[]>,
): Promise<
  | { readonly kind: "adopted"; readonly revision: number }
  | { readonly kind: "source_invalid"; readonly pending: CompanionPersonaPendingProposalV1 }
  | null
> {
  const row = await queryRows<{ revision: number; pending_revision: number | null }>(tx, sql`
    SELECT revision, pending_revision FROM companion_persona_profiles
    WHERE user_id = ${userId}
    LIMIT 1
    FOR UPDATE
  `);
  const profileRow = row[0];
  if (!profileRow || profileRow.pending_revision === null) return null;
  const pending = await readPendingPersonaProposal(tx, userId);
  if (!pending) return null;
  if (pending.author !== "assistant_tool") return null;

  const sources = resolveSources ? await resolveSources(pending) : [];
  if (sources.length > 0 && !await personaProposalHasLiveBasis(tx, userId, sources)) {
    // 失去依据：不采用，也不把这一版留在排队里（历史行不动，用户仍可查、可恢复）。
    await tx.execute(sql`
      UPDATE companion_persona_profiles SET pending_revision = NULL
      WHERE user_id = ${userId} AND pending_revision = ${pending.revision}
    `);
    return { kind: "source_invalid", pending };
  }

  const promoted = await queryRows<{ revision: number }>(tx, sql`
    UPDATE companion_persona_profiles p
       SET revision = v.revision,
           profile = v.profile,
           pending_revision = NULL,
           updated_at = now()
      FROM companion_persona_profile_versions v
     WHERE p.user_id = ${userId}
       AND v.user_id = p.user_id
       AND v.revision = p.pending_revision
       AND v.author = 'assistant_tool'
       AND p.revision = ${profileRow.revision}
    RETURNING p.revision
  `);
  const promotedRow = promoted[0];
  if (!promotedRow) return null;
  return { kind: "adopted", revision: Number(promotedRow.revision) };
}

/**
 * 撤回一条**只由已失效来源支持**的自动修订（方案 50 §9.4 末段）。
 *
 * 不能整版退回历史人格：用户后来改过的、与这次无关的有效变化都要留下。
 * 所以这里只把那一列自我描述去掉（回到没有自我描述的状态），其余字段原样，
 * 推一个新版本并记来源是这次撤回。
 */
export async function retractPersonaFieldFromDeadSource(
  tx: AgentSqlExecutor,
  userId: string,
  field: PersonaAssistantEditableField,
  reason: string,
): Promise<CompanionPersonaCommitOutcomeV1> {
  if (field.includes(".")) {
    // 边界那四项住在 `boundaries` 子对象里，"只撤这一项"要按嵌套形状走。
    // 首批撤回只有 `selfDescription` / `speakingStyle` 两项是真的（一条结论只由
    // 一个失效来源支撑时才会触发），这里不猜嵌套该怎么删。
    throw new Error(`retractPersonaFieldFromDeadSource does not support nested field: ${field}`);
  }
  const row = await lockPersonaProfileRow(tx, userId);
  if (!row) return { kind: "conflict", reason: "profile_row_missing" };
  const current = readProfile(row.profile);
  if (!current) return { kind: "unchanged", profile: current ?? personaFromDefaultPreset(getDefaultPersonaPreset()) };
  if ((current as Record<string, unknown>)[field] === undefined) return { kind: "unchanged", profile: current };
  const next: Record<string, unknown> = { ...current };
  delete next[field];
  const origin: Record<string, unknown> = { ...(current.fieldOrigin ?? {}) };
  delete origin[field];
  if (Object.keys(origin).length > 0) next.fieldOrigin = origin;
  else delete next.fieldOrigin;
  const revision = Math.max(row.revision, row.pending_revision ?? 0) + 1;
  const profile = next as CompanionPersonaProfileContent;
  // 先清排队（0355 顺序），再推当前版本。
  await tx.execute(sql`
    UPDATE companion_persona_profiles SET pending_revision = NULL
    WHERE user_id = ${userId} AND pending_revision IS NOT NULL
  `);
  await tx.execute(sql`
    UPDATE companion_persona_profiles
       SET revision = ${revision}, profile = ${JSON.stringify(profile)}::jsonb, updated_at = now()
     WHERE user_id = ${userId} AND revision = ${row.revision}
  `);
  await tx.execute(sql`
    INSERT INTO companion_persona_profile_versions
      (user_id, revision, examples_revision, author, action, reason, profile,
       module_scope, source_workspace_id)
    VALUES (${userId}, ${revision}, ${revision}, 'user', 'update', ${reason},
            ${JSON.stringify(profile)}::jsonb, ARRAY['companion']::text[], NULL)
  `);
  return { kind: "changed", revision, profile };
}
