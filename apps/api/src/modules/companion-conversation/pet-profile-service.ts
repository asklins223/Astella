/**
 * Account-scoped companion persona — 当前 / 待生效 two revisions — and
 * workspace-scoped relationship state.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  companionPersonaProfileVersions,
  companionPersonaProfiles,
  petProfiles,
  type CompanionPersonaProfileContent,
  type CompanionPersonaProfileVersionAction,
  type CompanionPersonaProfileVersionAuthor,
} from "@astella/shared/db-schema/companion-memory";
import { users } from "@astella/shared/db-schema/identity";
import { getPresetById } from "@astella/shared/pet-persona-presets";
export {
  DEFAULT_PERSONA_PRESET_ID,
  getDefaultPersonaPreset,
  PET_PERSONA_PRESETS,
  getPresetById,
  PET_PERSONA_PRESET_VERSION,
  resolveCompanionPersonaProfile,
  type PetProfileActiveness,
  type PetPersonaPreset,
  type PetPersonaPresetBoundaries,
} from "@astella/shared/pet-persona-presets";
import type {
  PetPersonaPresetBoundaries,
} from "@astella/shared/pet-persona-presets";

export type PetProfileBoundaries = PetPersonaPresetBoundaries;

export interface PetProfileInput extends CompanionPersonaProfileContent {
  /** Current account revision, including the default state (0 before first change). */
  revision: number;
}

/** Revision CAS failed; route maps this to 409. */
export class PetProfileCasConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("pet profile revision conflict");
    this.name = "PetProfileCasConflictError";
    this.currentRevision = currentRevision;
  }
}

export interface PetProfile extends CompanionPersonaProfileContent {
  id: string;
  userId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PetProfileRelationship {
  familiarity: number;
  interactionCount: number;
  lastActiveAt: string | null;
}

export interface PetProfileState {
  profile: PetProfile | null;
  profileRevision: number;
  /**
   * 「待生效」的那一版：已经按 append-only 版本行落库，但**还不是**当前版本。
   *
   * 为什么要单独一个字段而不是把它塞进 `profile`：一次调用绑定的永远是**当前**
   * 那一版（40 §4.8.4「一次调用使用固定版本」）。把两版混在一个字段里，
   * 读的人就必须自己判断哪个在生效——而判断错一次就是长会话中途换人。
   */
  pending: PetProfilePendingRevision | null;
  relationship: PetProfileRelationship;
}

/**
 * 「待生效」那一版对外的形状（A50「待生效版本可见」/ 40b §5.3.1）。
 *
 * 正文仍然住在不可变的版本行里，这里只是把「谁排的队、依据是什么、什么时候开始
 * 生效」一并带出来——设置页要显示的就是「当前 / 待生效 + 生效条件」这三样。
 */
export interface PetProfilePendingRevision {
  revision: number;
  /** null 表示那一版的内容是「回到当前发布的默认表达」，不是「没有内容」。 */
  profile: CompanionPersonaProfileContent | null;
  author: CompanionPersonaProfileVersionAuthor;
  action: CompanionPersonaProfileVersionAction;
  reason: string | null;
  moduleScope: string[];
  stagedAt: string;
  /** 合同原话的「生效条件」：模型自改下一会话，用户直接纠正下一轮未开始的调用。 */
  effectiveWhen: string;
}

export interface PetProfileVersion {
  id: string;
  revision: number;
  examplesRevision: number;
  author: CompanionPersonaProfileVersionAuthor;
  action: CompanionPersonaProfileVersionAction;
  reason: string | null;
  moduleScope: string[];
  profile: CompanionPersonaProfileContent | null;
  createdAt: string;
}

export interface PetProfileScope {
  workspaceId: string;
  userId: string;
}

/**
 * 行 → 对外形状。
 *
 * 只要求这几列，而不是 `typeof companionPersonaProfiles.$inferSelect`：
 * 「待生效被提升成当前」那条路径是 raw SQL 读回来的行，形状相同但不是 drizzle 的
 * select 结果，用一个结构类型收住比到处写 cast 好。
 */
function toContract(
  row: { id: string; userId: string; revision: number; createdAt: Date; updatedAt: Date },
  profile: CompanionPersonaProfileContent,
): PetProfile {
  return {
    id: row.id,
    userId: row.userId,
    ...profile,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function lockAccount(executor: ApiTransaction, userId: string): Promise<void> {
  // Serialize first-write races too: there may not be a persona row to lock yet.
  await executor.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

async function readAccountRow(
  executor: ApiTransaction,
  userId: string,
  forUpdate = false,
): Promise<typeof companionPersonaProfiles.$inferSelect | null> {
  const query = executor.select().from(companionPersonaProfiles)
    .where(eq(companionPersonaProfiles.userId, userId)).limit(1);
  const rows = forUpdate ? await query.for("update").execute() : await query;
  return rows[0] ?? null;
}

/**
 * 「待生效」指针 join 出来的那一行（profiles.pending_revision → versions）。
 *
 * 写成 `type` 而不是 `interface`：drizzle 的 `execute<T>` 要求 `T extends
 * Record<string, unknown>`，而 interface 拿不到隐式索引签名。
 */
type PendingPersonaVersionRow = {
  revision: number;
  profile: CompanionPersonaProfileContent | null;
  author: CompanionPersonaProfileVersionAuthor;
  action: CompanionPersonaProfileVersionAction;
  reason: string | null;
  module_scope: string[];
  /** raw execute 不走 drizzle 的列映射，时间戳是 ISO 字符串而不是 Date。 */
  created_at: string | Date;
};

/**
 * 读「待生效」那一版：指针 + 那条不可变版本行。
 *
 * ## 为什么这两条读写走 raw SQL
 *
 * `pending_revision` 是 0355 才加在 `companion_persona_profiles` 上的列，而 drizzle
 * 的表定义在 `packages/shared/src/db-schema/companion-memory.ts`——不在本次改动范围里。
 * 那一行补上 `pendingRevision: integer("pending_revision")` 之后，下面这几条语句可以
 * 换回 query builder，语义不变。在那之前，用三条写死的语句换「drizzle 少一列就静默
 * 读写不到」的形状是划算的：少一列时 SELECT 全列会直接把带 pending 的代码炸掉，
 * 而 `select({pendingRevision: true})` 少一列只是**安静地取不到**。
 *
 * ## 读取顺序
 *
 * 必须在 `readAccountRow(..., true)` 之后调用：那一条已经把 profiles 行锁住了，
 * 这里读到的指针与随后的写入看到的是同一份。
 */
async function readPendingRevisionRow(
  executor: ApiTransaction,
  userId: string,
): Promise<PendingPersonaVersionRow | null> {
  const rows = await executor.execute<PendingPersonaVersionRow>(sql`
    SELECT v.revision, v.profile, v.author, v.action, v.reason,
           v.module_scope, v.created_at
    FROM public.companion_persona_profiles p
    JOIN public.companion_persona_profile_versions v
      ON v.user_id = p.user_id
     AND v.revision = p.pending_revision
    WHERE p.user_id = ${userId}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * 下一个版本号：单调、不复用。
 *
 * ## 为什么要把它写成纯函数
 *
 * 版本号空间里可能**已经躺着一个比当前新的号**——那就是「待生效」那一版。
 * 之前所有写入都是 `current + 1`，那时候这是对的（当前永远是最大号）；
 * 有了待生效之后它会在**下一次用户直接写入**时撞上那一版，于是
 * `INSERT INTO versions (user_id, revision)` 撞唯一键，一次「用户纠正」当场失败。
 *
 * 所以规矩只有一条：**取「当前」与「待生效」里更大的那个 +1**。
 * 没有待生效时它就退化成 `current + 1`（既有行为与既有断言都不变），
 * 有待生效时它保证新号一定排在队尾。
 */
export function nextPersonaRevisionNumber(
  currentRevision: number,
  stagedRevision: number | null,
): number {
  return Math.max(currentRevision, stagedRevision ?? 0) + 1;
}

/**
 * 生效条件（40 §4.8.4 原话）——设置页要显示的那一句。
 *
 * 单独抽出来是因为**它是一条产品规则，不是一个文案**：模型自改与用户直接纠正
 * 的生效时点不同，规则只应该有一处定义，让界面自己复述一遍就一定会漂。
 */
export function personaRevisionEffectiveWhen(
  author: CompanionPersonaProfileVersionAuthor,
): string {
  switch (author) {
    case "assistant_tool":
      return "下一轮新发起的对话生效，当前已开始的调用保持原版本";
    case "restore":
      return "恢复后立即生效";
    case "migration":
      return "历史导入版本";
    default:
      return "下一轮未开始的调用生效";
  }
}

/** raw execute 回来的时间戳既可能是 Date 也可能是 ISO 字符串，两种都要能报出去。 */
function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPendingRevisionContract(row: PendingPersonaVersionRow): PetProfilePendingRevision {
  return {
    revision: Number(row.revision),
    profile: row.profile ?? null,
    author: row.author,
    action: row.action,
    reason: row.reason ?? null,
    moduleScope: row.module_scope ?? ["companion"],
    stagedAt: toIsoTimestamp(row.created_at),
    effectiveWhen: personaRevisionEffectiveWhen(row.author),
  };
}

export async function getPetProfileState(
  executor: ApiTransaction,
  scope: PetProfileScope,
): Promise<PetProfileState> {
  const accountRow = await readAccountRow(executor, scope.userId);
  // 「当前」与「待生效」一起读出来（A50）：设置页要能同时显示两者，
  // 而读的人不必自己去 join 版本表猜哪一版还没生效。
  const pendingRow = await readPendingRevisionRow(executor, scope.userId);
  const relationshipRows = await executor.select().from(petProfiles).where(and(
    eq(petProfiles.workspaceId, scope.workspaceId),
    eq(petProfiles.userId, scope.userId),
  )).limit(1);
  const relationship = relationshipRows[0];
  return {
    profile: accountRow?.profile ? toContract(accountRow, accountRow.profile) : null,
    profileRevision: accountRow?.revision ?? 0,
    pending: pendingRow ? toPendingRevisionContract(pendingRow) : null,
    relationship: {
      familiarity: relationship?.familiarity ?? 0,
      interactionCount: relationship?.interactionCount ?? 0,
      lastActiveAt: relationship?.lastActiveAt?.toISOString() ?? null,
    },
  };
}

export async function getPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  options?: { forUpdate?: boolean },
): Promise<PetProfile | null> {
  const row = await readAccountRow(executor, scope.userId, options?.forUpdate);
  return row?.profile ? toContract(row, row.profile) : null;
}

/**
 * 作废「待生效」那一版。
 *
 * ## 规则
 *
 * **谁把当前版本往前推，谁就作废它。**
 *
 * 依据是 40 §4.8.4：用户直接纠正「可从下一轮未开始的调用生效，无需为缓存等到
 * 长会话结束」。也就是说，一次用户直接写入**不能**被一个还没生效的模型修订挡住——
 * 挡住了就是让用户先去看一眼「待生效」再回来改，那正是合同要免掉的一步。
 * 被作废的那一版**不会消失**：它仍然是 versions 里的一行，作者、依据、范围都在，
 * 用户可以在历史里看到并恢复它；丢的只是「排队中」这个状态。
 *
 * ## 顺序是硬要求
 *
 * 必须**先**清指针、**再**把 revision 往前推。0355 的 CHECK
 * （`pending_revision > revision`）是即时校验、逐句检查：先把 revision 推到新号、
 * 再清指针，那一句自己就撞约束。这条顺序放在 `writeCurrentProfile` 里而不是
 * 每个调用方，是因为「往前推当前版本」只有一个入口——从入口处保证，忘了清的后果
 * 不会随着调用方增加而出现。
 */
async function clearPendingPointer(executor: ApiTransaction, userId: string): Promise<void> {
  await executor.execute(sql`
    UPDATE public.companion_persona_profiles
       SET pending_revision = NULL
     WHERE user_id = ${userId}
       AND pending_revision IS NOT NULL
  `);
}

/** 排下一个版本号：当前与待生效里更大的那个 +1（见 nextPersonaRevisionNumber）。 */
async function planNextRevision(
  executor: ApiTransaction,
  userId: string,
  currentRevision: number,
): Promise<number> {
  const staged = await readPendingRevisionRow(executor, userId);
  return nextPersonaRevisionNumber(currentRevision, staged?.revision ?? null);
}

async function writeCurrentProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  revision: number,
  profile: CompanionPersonaProfileContent | null,
  now: Date,
): Promise<typeof companionPersonaProfiles.$inferSelect> {
  const existing = await readAccountRow(executor, scope.userId, true);
  if (existing) {
    // 先作废待生效指针（顺序要求见 clearPendingPointer），再把 revision 推上去。
    await clearPendingPointer(executor, scope.userId);
    const updated = await executor.update(companionPersonaProfiles)
      .set({ revision, profile, updatedAt: now })
      .where(and(
        eq(companionPersonaProfiles.userId, scope.userId),
        eq(companionPersonaProfiles.revision, existing.revision),
      )).returning();
    if (!updated[0]) throw new PetProfileCasConflictError(existing.revision);
    return updated[0];
  }
  const inserted = await executor.insert(companionPersonaProfiles).values({
    userId: scope.userId,
    revision,
    profile,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!inserted[0]) throw new Error("companion persona profile insert did not return a row");
  return inserted[0];
}

async function appendVersion(
  executor: ApiTransaction,
  scope: PetProfileScope,
  values: {
    revision: number;
    author: CompanionPersonaProfileVersionAuthor;
    action: CompanionPersonaProfileVersionAction;
    reason: string;
    profile: CompanionPersonaProfileContent | null;
    now: Date;
  },
): Promise<void> {
  await executor.insert(companionPersonaProfileVersions).values({
    userId: scope.userId,
    revision: values.revision,
    examplesRevision: values.revision,
    author: values.author,
    action: values.action,
    reason: values.reason,
    moduleScope: ["companion"],
    profile: values.profile,
    createdAt: values.now,
  });
}

export async function upsertPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: PetProfileInput,
  now: Date = new Date(),
  metadata: { author?: CompanionPersonaProfileVersionAuthor; reason?: string } = {},
): Promise<PetProfile> {
  await lockAccount(executor, scope.userId);
  const existing = await readAccountRow(executor, scope.userId, true);
  const currentRevision = existing?.revision ?? 0;
  if (input.revision !== currentRevision) throw new PetProfileCasConflictError(currentRevision);
  const revision = await planNextRevision(executor, scope.userId, currentRevision);
  const { revision: _expectedRevision, ...profile } = input;
  const row = await writeCurrentProfile(executor, scope, revision, profile, now);
  await appendVersion(executor, scope, {
    revision,
    author: metadata.author ?? "user",
    action: "update",
    reason: metadata.reason ?? "Updated companion persona.",
    profile,
    now,
  });
  return toContract(row, profile);
}

/**
 * 「恢复默认」要重置的是**哪几项**（40b §5.2 末段 / A51）。
 *
 * 合同原话：「只恢复声明的表达项，不误清名字、开关或空间记忆。」
 * 声明的表达项只有两项——**账号表达覆盖（speakingStyle）与 examples**。
 * 其余各项的性质不同：
 *
 * | 字段 | 性质 | 恢复默认时 |
 * | --- | --- | --- |
 * | `speakingStyle` / `examples` | 账号表达覆盖 | **重置**为当前发布的预设值 |
 * | `name` | 用户指定的名字 | 保留 |
 * | `activeness` / `boundaries` | 用户自己设的开关 | 保留 |
 * | `presetId` / `personalityTags` | 选了哪套人格 | 保留 |
 *
 * 之前这里是 `profile = null` ——**整份置空**，于是「恢复默认表达」顺带把用户改过的
 * 名字、活跃度和行为边界一起抹回预设。那是 A51 明令不许发生的那件事：
 * 用户点「恢复默认表达」，结果自己的名字被换掉了。
 *
 * 导成纯函数是为了能单独测：上面这张表每一格都该有断言，而不是靠一次真库跑过就算。
 */
export function expressionResetProfile(
  current: CompanionPersonaProfileContent,
): CompanionPersonaProfileContent {
  const preset = getPresetById(current.presetId);
  const fieldOrigin = { ...current.fieldOrigin };
  // 被重置回预设值的两项，来源也跟着回退到 preset：从此归预设管，下次换人格
  // 就可以直接被覆盖。若留着「她改的」，用户会看到一个已经清干净的语气
  // 还被标记成"她写的"，下一次换人格时无端多问一句。
  delete fieldOrigin.speakingStyle;
  delete fieldOrigin.examples;
  return {
    presetId: current.presetId,
    name: current.name,
    personalityTags: current.personalityTags,
    speakingStyle: preset?.speakingStyle ?? current.speakingStyle,
    examples: preset?.examples ?? current.examples,
    activeness: current.activeness,
    boundaries: current.boundaries,
    fieldOrigin,
  };
}

export async function resetPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  expectedRevision: number,
  now: Date = new Date(),
): Promise<number> {
  await lockAccount(executor, scope.userId);
  const existing = await readAccountRow(executor, scope.userId, true);
  const currentRevision = existing?.revision ?? 0;
  if (expectedRevision !== currentRevision) throw new PetProfileCasConflictError(currentRevision);
  const revision = await planNextRevision(executor, scope.userId, currentRevision);
  // 本来就没有任何覆盖时，置空就是「回到当前发布的默认」，没有可撤销的东西。
  // 有覆盖时只重置表达那两项（见 expressionResetProfile 的那张表）。
  const current = existing?.profile ?? null;
  const next = current ? expressionResetProfile(current) : null;
  await writeCurrentProfile(executor, scope, revision, next, now);
  await appendVersion(executor, scope, {
    revision,
    author: "user",
    action: "reset",
    reason: "Restored the current published default persona.",
    profile: next,
    now,
  });
  return revision;
}

export async function listPetProfileVersions(
  executor: ApiTransaction,
  scope: PetProfileScope,
): Promise<PetProfileVersion[]> {
  const rows = await executor.select().from(companionPersonaProfileVersions)
    .where(eq(companionPersonaProfileVersions.userId, scope.userId))
    .orderBy(desc(companionPersonaProfileVersions.revision)).limit(100);
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    examplesRevision: row.examplesRevision,
    author: row.author,
    action: row.action,
    reason: row.reason,
    moduleScope: row.moduleScope,
    profile: row.profile,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function restorePetProfileVersion(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: { revision: number; expectedRevision: number },
  now: Date = new Date(),
): Promise<PetProfile | null | undefined> {
  await lockAccount(executor, scope.userId);
  const current = await readAccountRow(executor, scope.userId, true);
  const currentRevision = current?.revision ?? 0;
  if (input.expectedRevision !== currentRevision) throw new PetProfileCasConflictError(currentRevision);
  const versions = await executor.select().from(companionPersonaProfileVersions).where(and(
    eq(companionPersonaProfileVersions.userId, scope.userId),
    eq(companionPersonaProfileVersions.revision, input.revision),
  )).limit(1);
  const source = versions[0];
  if (!source) return undefined;
  const revision = await planNextRevision(executor, scope.userId, currentRevision);
  const profile = source.profile;
  const row = await writeCurrentProfile(executor, scope, revision, profile, now);
  await appendVersion(executor, scope, {
    revision,
    author: "restore",
    action: "restore",
    reason: `Restored persona revision ${source.revision}.`,
    profile,
    now,
  });
  return profile ? toContract(row, profile) : null;
}

export interface PetProfileStagedRevision {
  /** 新排上队的那一版版本号。 */
  pendingRevision: number;
  /** 当前版本**没有动**——排队不等于生效（A50 / 40 §4.8.4）。 */
  profileRevision: number;
}

export interface PetProfileActivation {
  revision: number;
  profile: PetProfile | null;
}

/** 排上队的那一版可能本身没有正文（= 回到当前发布的默认表达），这是合法状态。 */
function toProfileContract(
  row: { id: string; userId: string; revision: number; createdAt: Date; updatedAt: Date },
  profile: CompanionPersonaProfileContent,
): PetProfile {
  return toContract(row, profile);
}

/**
 * 排队一版人格修订：**写下内容，但不动当前版本**（A50 / 40 §4.8.4）。
 *
 * ## 排队与生效是两步
 *
 * 合同原话：「模型自改在下一次会话建立时生效」。这句话要求「写下来」与「开始被用」
 * 分开——否则模型改一次人格，长会话里已经说过的话与正在生成的那句就会分属两个版本，
 * 而「一次调用使用固定版本」当场破掉。所以这一步：
 *
 *   * 把新内容按 append-only 规矩追加成一条版本行（作者、范围、依据都在那一行上）；
 *   * 把 `pending_revision` 指过去；
 *   * **当前版本（revision + profile）一个字都不动**。
 *
 * 读路径于是可以同时答出两件事：现在用的是哪一版（`profile`），以及排队的是哪一版
 * （`getPetProfileState().pending`）。A50 的「待生效版本可见」就是后者。
 *
 * ## 已经排过队时再排一次
 *
 * 不报错，新的一版直接顶掉排队中的那一版。理由与「用户直接纠正会作废排队」同源：
 * 一个还没生效的东西不该成为下一次修订的障碍。被顶掉的那一版仍在历史里可查可恢复。
 *
 * ## CAS
 *
 * 仍然按**当前** revision 做乐观锁（调用方手里的那个号），冲突抛
 * `PetProfileCasConflictError`，路由映射为 409。
 */
export async function stagePetProfileRevision(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: PetProfileInput,
  now: Date = new Date(),
  metadata: { author?: CompanionPersonaProfileVersionAuthor; reason?: string } = {},
): Promise<PetProfileStagedRevision> {
  await lockAccount(executor, scope.userId);
  const existing = await readAccountRow(executor, scope.userId, true);
  const currentRevision = existing?.revision ?? 0;
  if (input.revision !== currentRevision) throw new PetProfileCasConflictError(currentRevision);
  const revision = await planNextRevision(executor, scope.userId, currentRevision);
  const { revision: _expectedRevision, ...profile } = input;
  // 先落版本行：0355 的复合外键要求指针指向一条**已存在**的版本行，顺序反了直接撞约束。
  await appendVersion(executor, scope, {
    revision,
    author: metadata.author ?? "user",
    action: "update",
    reason: metadata.reason ?? "Staged a companion persona revision.",
    profile,
    now,
  });
  await setPendingPointer(executor, scope, currentRevision, revision, now);
  return { pendingRevision: revision, profileRevision: currentRevision };
}

async function setPendingPointer(
  executor: ApiTransaction,
  scope: PetProfileScope,
  expectedCurrentRevision: number,
  pendingRevision: number,
  now: Date,
): Promise<void> {
  // 排队不动当前档案，所以也不动 updated_at——那一列说的是「当前档案何时变过」，
  // 被一次排队改掉会让「上次改是什么时候」答错。
  const updated = await executor.execute(sql`
    UPDATE public.companion_persona_profiles
       SET pending_revision = ${pendingRevision}
     WHERE user_id = ${scope.userId}
       AND revision = ${expectedCurrentRevision}
    RETURNING id
  `);
  if (updated.length > 0) return;
  // 这个人还没有档案行（第一次就排队）：建一行「当前=没有任何覆盖、待生效=第 1 版」。
  // 当前仍然是 0/无覆盖——排队不改变"她现在是谁"，只改变"她下一会话是谁"。
  const inserted = await executor.execute(sql`
    INSERT INTO public.companion_persona_profiles (
      user_id, revision, profile, pending_revision, created_at, updated_at
    )
    VALUES (
      ${scope.userId}, 0, NULL, ${pendingRevision},
      ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
    RETURNING id
  `);
  if (inserted.length === 0) throw new PetProfileCasConflictError(expectedCurrentRevision);
}

/**
 * 让排队中的那一版生效：把它提升为当前版本，指针清空。
 *
 * ## 一条语句完成，不读正文进内存再写回
 *
 * `profile` 直接从那条不可变版本行里取（`UPDATE … FROM versions`），
 * 于是「指针指的那一版」与「真正被提升的那一版」在结构上不可能是两份东西：
 * 想提升错的一版，得先改版本表，而版本表是 append-only 的。
 *
 * ## 没有排队时返回 null
 *
 * 这是「请求已过期」而不是错误：调用方多半拿着一个还没排队的界面点了生效。
 * 路由把它映射成 409（与 CAS 冲突同一类：客户端手上的状态已不是服务端的状态）。
 */
export async function activatePetProfilePendingRevision(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: { expectedRevision: number },
  now: Date = new Date(),
): Promise<PetProfileActivation | null> {
  await lockAccount(executor, scope.userId);
  const existing = await readAccountRow(executor, scope.userId, true);
  if (!existing) return null;
  const currentRevision = existing.revision;
  if (input.expectedRevision !== currentRevision) throw new PetProfileCasConflictError(currentRevision);
  const promoted = await executor.execute<{
    id: string;
    user_id: string;
    revision: number;
    profile: CompanionPersonaProfileContent | null;
    created_at: string | Date;
    updated_at: string | Date;
  }>(sql`
    UPDATE public.companion_persona_profiles p
       SET revision = v.revision,
           profile = v.profile,
           pending_revision = NULL,
           updated_at = ${now.toISOString()}::timestamptz
      FROM public.companion_persona_profile_versions v
     WHERE p.user_id = ${scope.userId}
       AND v.user_id = p.user_id
       AND v.revision = p.pending_revision
       AND p.revision = ${input.expectedRevision}
    RETURNING p.id, p.user_id, p.revision, p.profile, p.created_at, p.updated_at
  `);
  const row = promoted[0];
  // 指针为空 = 没有排队；CAS 已经被别人推走 = 这一句自然不命中。两种都交给调用方
  // 按"你手上的状态已过期"处理（路由 409），不静默成功。
  if (!row) return null;
  const profile = row.profile ?? null;
  return {
    revision: Number(row.revision),
    profile: profile
      ? toProfileContract(
        {
          id: String(row.id),
          userId: String(row.user_id),
          revision: Number(row.revision),
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        },
        profile,
      )
      : null,
  };
}

/** Reading pages or resuming a run does not consume a pending expression.
 * Only a new accepted user turn adopts assistant revisions; user-staged drafts
 * keep their explicit activation step. Already pinned runs retain their version.
 */
export async function activateAssistantPersonaForNewTurn(
  executor: ApiTransaction,
  scope: PetProfileScope,
): Promise<number | null> {
  const rows = await executor.execute<{ revision: number }>(sql`
    UPDATE public.companion_persona_profiles p
       SET revision = v.revision,
           profile = v.profile,
           pending_revision = NULL,
           updated_at = now()
      FROM public.companion_persona_profile_versions v
     WHERE p.user_id = ${scope.userId}
       AND v.user_id = p.user_id
       AND v.revision = p.pending_revision
       AND v.author = 'assistant_tool'
    RETURNING p.revision
  `);
  return rows[0] ? Number(rows[0].revision) : null;
}
