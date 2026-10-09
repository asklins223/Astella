/** 「此刻谁开着这一篇」的契约（共享空间的在场）。 */

import { z } from "zod";

const uuidSchema = z.string().uuid();

export const notePresenceModesV1 = ["reading", "editing"] as const;
export type NotePresenceModeV1 = (typeof notePresenceModesV1)[number];

/**
 * 一个在场的人。
 *
 * `displayName` 是**服务端从 `users` 解析**的那一份，不是对端在 awareness 里自报的字符串：
 * 一个改过的客户端不该能在别人屏上落一句「某某在读」。没有显示名时落回邮箱 @ 前那一段，
 * 两个都没有就是空串——界面画一枚「?」印章，而不是编一个名字。
 */
export const notePresenceViewerV1Schema = z.strictObject({
  userId: uuidSchema,
  displayName: z.string(),
  mode: z.enum(notePresenceModesV1),
  /** 他自己报的当前块（`null` = 不在正文里）。「也在写这一段」那句话用的是它。 */
  block: z.number().int().min(0).nullable(),
});
export type NotePresenceViewerV1 = z.infer<typeof notePresenceViewerV1Schema>;

/**
 * 一篇笔记此刻的在场。**只列出真的有人在开的篇**：
 * 没人在看的那一篇在这一份里根本不出现，界面因此不会为它画任何东西。
 */
export const notePresenceItemV1Schema = z.strictObject({
  noteId: uuidSchema,
  viewers: z.array(notePresenceViewerV1Schema),
});
export type NotePresenceItemV1 = z.infer<typeof notePresenceItemV1Schema>;

export const notePresenceListV1Schema = z.strictObject({
  items: z.array(notePresenceItemV1Schema),
});
export type NotePresenceListV1 = z.infer<typeof notePresenceListV1Schema>;
