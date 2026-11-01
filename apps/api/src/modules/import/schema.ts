import { z } from "zod";
import { MAX_SOURCE_TEXT_BYTES } from "@astella/shared/object-transfer-contracts";

export const importMarkdownSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().max(200).optional().default(""),
        // 一份导入正文的上限 = 一份正文的上限（100 MB），不是这里另估一个 50 万字：
        // 长文被这一格截住的形状是"导入报成功、笔记少一截"，而那正是本批要消灭的错位。
        content: z.string().min(1).max(MAX_SOURCE_TEXT_BYTES),
      }),
    )
    .min(1)
    .max(100),
  // F-033: 幂等键，相同 importId 的重复请求不会创建重复笔记
  // 客户端在重试时应传入相同的 importId
  importId: z.string().max(100).optional(),
});
