import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { noteMarkdownSyntax } from "@astella/shared/note-markdown";
import type { NoteWritingAction } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
export async function writingAction(request: NoteWritingAction) {
  if (!window.astella?.noteWriting) throw new Error("此功能需要桌面应用");
  return unwrapGatewayResult(await window.astella.noteWriting.perform({ meta: createRequestMeta(), request }));
}
export async function writingImage(src: string, path?: string): Promise<{ src: string; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; base64: string }> {
  const objectKey = sourceImageObjectKeyFromUrl(src);
  if (objectKey && window.astella) {
    const image = unwrapGatewayResult(await window.astella.source.getImage({ meta: createRequestMeta(), request: { version: 1, objectKey } }));
    return { src, mime: image.mimeType as "image/png", base64: image.imageBase64 };
  }
  const inline = src.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s);
  if (inline) return { src, mime: inline[1] as "image/png", base64: inline[2]! };
  if (src.startsWith("blob:")) { const response = await fetch(src), blob = await response.blob(); const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = reject; reader.readAsDataURL(blob); }); return { src, mime: blob.type as "image/png", base64 }; }
  const image = await writingAction({ action: "image", src, path });
  if (!image.mime || !image.base64) throw new Error("图片读取失败"); return { src, mime: image.mime as "image/png", base64: image.base64 };
}
export function writingImageSources(markdown: string): string[] {
  const sources = new Set<string>(); const walk = (node: { type: string; url?: string; children?: unknown[] }) => { if (node.type === "image" && node.url) sources.add(node.url); node.children?.forEach(child => walk(child as never)); }; walk(noteMarkdownSyntax(markdown)); return [...sources];
}
export async function collectWritingImages(markdown: string, path?: string) {
  const images = []; for (const src of writingImageSources(markdown)) images.push(await writingImage(src, path)); return images;
}
const localFiles = new WeakMap<HTMLElement, string>();
export function setWritingFile(editor: HTMLElement, path: string) { localFiles.set(editor, path); editor.dispatchEvent(new Event("note-local-file-change")); }
export function getWritingFile(editor: HTMLElement) { return localFiles.get(editor); }
