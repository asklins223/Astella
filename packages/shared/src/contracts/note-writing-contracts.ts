import { z } from "zod";
export const noteWritingActionSchema = z.object({
  action: z.enum(["folder", "open", "read", "save", "assets", "image", "export", "clipboard"]),
  src: z.string().max(4096).optional(),
  path: z.string().max(4096).optional(), revision: z.number().optional(), title: z.string().max(300).optional(),
  markdown: z.string().max(4_000_000).optional(), html: z.string().max(8_000_000).optional(),
  format: z.enum(["md", "html", "pdf", "docx"]).optional(),
  images: z.array(z.object({ src: z.string().max(4_000_000), mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), base64: z.string().max(16_000_000) })).max(100).optional(),
});
export type NoteWritingAction = z.infer<typeof noteWritingActionSchema>;
export const noteWritingResultSchema = z.object({
  canceled: z.boolean().optional(), path: z.string().optional(), markdown: z.string().optional(), revision: z.number().optional(),
  entries: z.array(z.object({ path: z.string(), name: z.string() })).optional(),
  mime: z.string().optional(), base64: z.string().optional(), warnings: z.array(z.string()).optional(),
});
export type NoteWritingResult = z.infer<typeof noteWritingResultSchema>;
