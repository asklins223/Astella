/**
 * 制卡夹具空间的清理（`card-generation-v2-e2e-subset` 与 `card-generation-v3-simplified-postgres` 共用）。
 *
 * 为什么要单独一份、还要**回读计数并交回报告**：这里的删除次序错了不会让任何用例变红——它只把
 * 行留在库里，下一次跑的时候被"整空间数 0 条"那一类断言当成别人的残留。旧写法是每句
 * `.catch(() => undefined)`，于是两件事同时被咽掉：
 *  1. `DELETE FROM workspaces` 每次都失败——`users.personal_workspace_id` 对 workspaces 是
 *     **ON DELETE RESTRICT**，而 `workspaces.owner_id` 又指向 users（NO ACTION），两边都不肯先走；
 *     表现就是每跑一轮库里多一个空间（2026-09-26 量到 4 个残留空间、9 张激活出来的卡）。
 *  2. 依据那几张表带只追加守卫（`prevent_immutable_v2_row_mutation`），删父行级联到它们时会被拒；
 *     守卫自己留了那道 `app.allow_history_mutation` 的口子，**清理就该走那道口子**，
 *     而不是把失败咽掉当作"清过了"。
 *
 * 还有一条是这一刀现场学到的：让 `after()` 在连接池还开着的时候抛错，整个文件会挂在超时上
 * （实测 240 秒，看起来像"用例慢"）。所以这里只交回报告，调用方在 `finally` 里先关池再喊。
 */
import type { Sql } from "postgres";

/** 要删干净的表，按子→父排（外键方向：先删引用方，再删被引用方）。 */
const FIXTURE_TABLES = [
  "learning_card_publication_revisions_v2",
  "learning_card_revisions_v2",
  "learning_cards_v2",
  "learning_objective_evidence_bindings_v2",
  "learning_objective_origins_v2",
  "learning_objective_revisions_v2",
  "learning_objectives_v2",
  "learning_target_snapshots_v2",
  "learning_task_presentation_history",
  "learning_task_private_solutions",
  "learning_task_safety_reports",
  "learning_task_disclosure_profiles",
  "learning_task_variants",
  "learning_tasks",
  "learning_exposures_v2",
  "learning_run_private_contracts",
  "learning_run_events",
  "learning_run_idempotency",
  "learning_runs",
  "card_exposure_ledger_v2",
  "card_domain_events_v2",
  "initial_validation_reminders_v2",
  "card_activation_receipts_v2",
  "review_schedules",
  "card_candidate_feedback_v2",
  "card_generation_run_progress_v2",
  "card_generation_events_v2",
  "card_candidate_quality_reports_v2",
  "candidate_evidence_binding_plans_v2",
  "card_generation_candidates_v2",
  "card_generation_run_outbox_v2",
  "card_generation_plans_v2",
  "card_generation_runs_v2",
  "card_generation_semantic_specs_v2",
  "card_generation_input_snapshots_v2",
  "evidence_quote_copies_v2",
  "evidence_eligibility_states_v2",
  "evidence_snapshots_v2",
  // 封存真正落的表叫 `sources` / `source_segments`。旧台子里那句
  // `DELETE FROM source_snapshots_v2` 删的是一张**不存在的表**——它被
  // `.catch(() => undefined)` 咽了整整一批运行，这也是这次把它并进来的原因之一。
  "source_segments",
  "sources",
  "note_blocks",
  "note_versions",
  "notes",
  "workspace_members",
] as const;

export interface CardGenerationFixtureWipeReport {
  /** 一条都没了就是空数组；否则逐条说清是哪张表、报什么。 */
  readonly problems: string[];
  /** 报告用的读数：清理之后这些表在这些空间里还剩多少行（正常应为空）。 */
  readonly retained: string[];
}

/**
 * 删掉这一批夹具空间留下的一切，交回报告（**不抛**，见文件头最后一段）。
 */
export async function wipeCardGenerationFixtures(
  admin: Sql,
  workspaceIds: readonly string[],
  userIds: readonly string[],
): Promise<CardGenerationFixtureWipeReport> {
  const problems: string[] = [];
  const inList = workspaceIds.map((id) => `'${id}'`).join(",");
  try {
    await admin.begin(async (tx) => {
      // 守卫自己留的那道口子：这一发是**夹具拆租户**，不是改历史。
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      for (const table of FIXTURE_TABLES) {
        await tx.unsafe(`DELETE FROM public.${table} WHERE workspace_id IN (${inList})`);
      }
      // 解开那一圈环：先把用户身上的 `personal_workspace_id` 置空，再删空间，最后删用户。
      for (const userId of userIds) {
        await tx.unsafe(`UPDATE public.users SET personal_workspace_id = NULL WHERE id = '${userId}'`);
      }
      for (const workspaceId of workspaceIds) {
        await tx.unsafe(`DELETE FROM public.workspaces WHERE id = '${workspaceId}'`);
      }
      for (const userId of userIds) {
        await tx.unsafe(`DELETE FROM public.users WHERE id = '${userId}'`);
      }
    });
  } catch (error) {
    problems.push(`清理事务失败：${(error as Error).message.split("\n")[0]}`);
  }

  const retained: string[] = [];
  for (const table of FIXTURE_TABLES) {
    const rows = await admin.unsafe(
      `SELECT count(*)::int AS n FROM public.${table} WHERE workspace_id IN (${inList})`,
    ) as unknown as Array<{ n: number }>;
    const left = Number(rows[0]?.n ?? 0);
    if (left > 0) retained.push(`${table}=${left}`);
  }
  for (const workspaceId of workspaceIds) {
    const rows = await admin.unsafe(
      `SELECT count(*)::int AS n FROM public.workspaces WHERE id = '${workspaceId}'`,
    ) as unknown as Array<{ n: number }>;
    if (Number(rows[0]?.n ?? 0) > 0) retained.push(`workspaces(${workspaceId.slice(0, 8)})=1`);
  }
  if (retained.length > 0) problems.push(`删完还在的：${retained.join("，")}`);
  return { problems, retained };
}

/** 把报告变成一条会失败的报错：调用方**关完池之后**再调它。 */
export function assertFixtureWipeClean(report: CardGenerationFixtureWipeReport): void {
  if (report.problems.length === 0) return;
  throw new Error(`制卡夹具清理没干净 —— ${report.problems.join("；")}`);
}
