import { z } from "zod";

export const importMarkdownSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().max(200).optional().default(""),
        content: z.string().min(1).max(500_000),
      }),
    )
    .min(1)
    .max(100),
  // F-033: 幂等键，相同 importId 的重复请求不会创建重复笔记
  // 客户端在重试时应传入相同的 importId
  importId: z.string().max(100).optional(),
});
