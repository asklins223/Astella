/**
 * 她自己改人格的那条通路（40 §4.8.4「模型自改表达层」）。
 *
 * ## 为什么单独一个文件
 *
 * 四个自改工具（语气、性格标签、表达分量、边界）此前各自抄了一遍
 * `SELECT … FOR UPDATE → 判断 → UPDATE → 插版本行`，于是两件事被复制成了四份：
 *
 *  1. **没有账号档案时一律返回 `missing`。** 账号从来没选过人格时，她手里只有
 *     系统默认人格（不在档案表里），于是她第一次想调一下语气就被拒——而用户看到的
 *     是"她明明有人格却改不了"。这里改成**以系统默认人格为底稿起一份档案**。
 *  2. **改动不记字段来源。** 换人格时要靠 `fieldOrigin` 判断哪几项是她写的，
 *     漏记一次就等于她调过的东西会被一键冲掉，而且再没有线索能查出来。
 *
 * 两条都收在这里，四处调用点不再重复判断。
 *
 * ## 版本号
 *
 * 走 `nextPersonaRevisionNumber` 那条规矩（当前与待生效里更大的 +1）。起手那一份
 * 拿到的是第 1 版，档案行此前不存在时也要照常留版本行——否则用户在人格版本记录里
 * 看不到"她改的第一次是哪一版"。
 */

import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";
import {
  getDefaultPersonaPreset,
} from "@ailearn/shared/pet-persona-presets";
import {
  personaFromDefaultPreset,
  withAssistantEditedField,
  type SwitchableField,
} from "@ailearn/shared/pet-persona-merge";
import type { CompanionPersonaProfileContent } from "@ailearn/shared/db-schema/companion-memory";

/** 库里那一行可能什么形状都有：null、数组、任意对象。不认识的当"没档案"。 */
function readProfile(value: unknown): CompanionPersonaProfileContent | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as CompanionPersonaProfileContent
    : null;
}

export type PersonaSelfEditResult =
  /** 真的改了什么，版本号已经是新的。 */
  | { readonly kind: "changed"; readonly revision: number; readonly profile: CompanionPersonaProfileContent }
  /** 新值与现值相同：不给"已改"的回执，也不占一个版本号。 */
  | { readonly kind: "unchanged"; readonly profile: CompanionPersonaProfileContent }
  /** 并发把版本推走了；调用方按"请重试"处理。 */
  | { readonly kind: "conflict" };

/**
 * 改一项或多项表达层的设定，来源记 `assistant`。
 *
 * `field` 不含 `name` —— 用户起的名字她改不了（§4.8.4），类型上就不给这条路。
 * 一次改多项（改边界）只推一个版本号：分两次推会让用户在人格里看到两次改动，
 * 而他只提了一次要求。
 */
export async function applyAssistantPersonaEdits(
  tx: WorkerTransaction,
  userId: string,
  edits: readonly { field: SwitchableField; value: unknown }[],
  reason: string,
): Promise<PersonaSelfEditResult> {
  if (edits.length === 0) throw new Error("applyAssistantPersonaEdits requires at least one edit");
  const current = await tx.execute<{ revision: number; profile: unknown; pending_revision: number | null }>(sql`
    SELECT revision, profile, pending_revision FROM companion_persona_profiles
    WHERE user_id = ${userId}
    LIMIT 1
    FOR UPDATE
  `);
  const row = (Array.isArray(current) ? current : [])[0];
  const existing = readProfile(row?.profile);
  // 档案还没有：拿系统默认人格当底稿。她改的是"当前生效的那份人格"，
  // 不是凭空造一个——所以起手之后整份档案与默认人格一致，只有这一项归她。
  const base = existing ?? personaFromDefaultPreset(getDefaultPersonaPreset());
  const next = edits.reduce(
    (profile, edit) => withAssistantEditedField(profile, edit.field, edit.value),
    base as CompanionPersonaProfileContent,
  );
  // 比的是**内容**，不是整个对象：`fieldOrigin` 是这一行改出来的，拿它参与比较
  // 会让"改成一样的值"也算改 —— 版本被推高，而屏上什么都没变，更要命的是
  // 那一项从此被标成"她改的"，以后每次换人格都要问它一遍。
  const { fieldOrigin: _ignored, ...nextContent } = next;
  const { fieldOrigin: _alsoIgnored, ...baseContent } = base;
  if (JSON.stringify(nextContent) === JSON.stringify(baseContent)) return { kind: "unchanged", profile: base };

  // 版本号走同一条规矩：当前与待生效里更大的 +1。直接写死 1 会在"排队的版本
  // 比当前的还大"时撞 0355 的 CHECK（pending_revision > revision）。
  const nextRevision = Math.max(row?.revision ?? 0, row?.pending_revision ?? 0) + 1;
  const saved = await tx.execute<{ revision: number; profile: unknown }>(sql`
    INSERT INTO companion_persona_profiles (user_id, revision, profile, updated_at)
    VALUES (${userId}, ${nextRevision}, ${JSON.stringify(next)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE
      SET profile = EXCLUDED.profile,
          revision = EXCLUDED.revision,
          updated_at = now()
      WHERE companion_persona_profiles.revision = ${row?.revision ?? 0}
    RETURNING revision, profile
  `);
  const updated = (Array.isArray(saved) ? saved : [])[0];
  if (!updated) return { kind: "conflict" };
  const profile = readProfile(updated.profile) ?? next;
  await tx.execute(sql`
    INSERT INTO companion_persona_profile_versions
      (user_id, revision, examples_revision, author, action, reason, profile)
    VALUES (${userId}, ${updated.revision}, ${updated.revision},
            'assistant_tool', 'update', ${reason},
            ${JSON.stringify(profile)}::jsonb)
  `);
  return { kind: "changed", revision: updated.revision, profile };
}

/** 单项版的薄封装——四个工具里有三个只改一项。 */
export function applyAssistantPersonaEdit(
  tx: WorkerTransaction,
  userId: string,
  field: SwitchableField,
  value: unknown,
  reason: string,
): Promise<PersonaSelfEditResult> {
  return applyAssistantPersonaEdits(tx, userId, [{ field, value }], reason);
}
