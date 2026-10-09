/** 「共享给空间」/「取消共享」那一个显式动作的契约（批次 4.5）。 */

import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });

export const noteShareScopeValuesV1 = ["private", "shared"] as const;
export type NoteShareScopeV1 = (typeof noteShareScopeValuesV1)[number];

export const noteShareScopeRequestV1Schema = z.strictObject({
  shareScope: z.enum(noteShareScopeValuesV1),
});
export type NoteShareScopeRequestV1 = z.infer<typeof noteShareScopeRequestV1Schema>;

export const noteShareScopeReceiptV1Schema = z.strictObject({
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
  /** 设成同一个值时是 false：幂等，不写行也不推更新时间。 */
  changed: z.boolean(),
  updatedAt: isoTimestampSchema,
});
export type NoteShareScopeReceiptV1 = z.infer<typeof noteShareScopeReceiptV1Schema>;

/**
 * 伴星那一侧的入参（2026-10-09）。
 *
 * 只有两个字段，都是刻意的：
 *  - 没有 workspaceId —— 作用域由服务端从这轮会话取，否则她就得到了一条跨空间的写通道；
 *  - 没有"共享给谁" —— 这一列的语义就是「空间里的人能不能读到」，收件人不是她能挑的。
 *
 * 档位沿用 `noteShareScopeValuesV1`，不另抄一份枚举：抄一份就会出现"她填一个领域合同
 * 不接受的值"，而失败只在真的写下去时才显形。
 */
export const companionShareNoteV1Schema = z.strictObject({
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
});
export type CompanionShareNoteV1 = z.infer<typeof companionShareNoteV1Schema>;
