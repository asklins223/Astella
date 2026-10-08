import type { RefObject } from "react";
import { $prose } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { NodeView } from "@milkdown/kit/prose/view";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { loadSourceImageBlobUrl } from "../source/source-image";
import type { NoteImageUploadView } from "./note-image-uploads";

type Uploads = ReadonlyMap<string, NoteImageUploadView>;
export const noteImageUploadsKey = new PluginKey<Uploads>("NOTE_IMAGE_UPLOAD_STATES");

/** A leaf view: rendered filenames and status labels never enter the Markdown document. */
export function createNoteImageNodeView(
  initialNode: Node,
  onZoom: (src: string, alt: string) => void,
): NodeView & { readonly refreshUpload: (uploads: Uploads) => void } {
  const dom = document.createElement("span");
  dom.className = "note-image-node";
  dom.contentEditable = "false";
  const image = document.createElement("img");
  image.className = "note-image-node__image";
  image.draggable = false;
  const placeholder = document.createElement("span");
  placeholder.className = "note-image-node__placeholder";
  placeholder.setAttribute("role", "status");
  const name = document.createElement("span");
  name.className = "note-image-node__name";
  const badge = document.createElement("span");
  badge.className = "note-image-node__badge";
  placeholder.append(name, badge);
  dom.append(image, placeholder);

  let node = initialNode;
  let shown: string | null = null;
  let disposed = false;
  let uploads: Uploads = new Map();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const pending = (state: string, label: string, fileName: string) => {
    dom.dataset.state = state;
    dom.setAttribute("aria-busy", String(state === "uploading" || state === "loading"));
    image.hidden = true;
    image.classList.remove("note-image-zoomable");
    placeholder.hidden = false;
    name.textContent = fileName;
    badge.textContent = label;
  };
  const refreshUpload = (nextUploads: Uploads) => {
    uploads = nextUploads;
    const src = String(node.attrs.src ?? "");
    if (!src.startsWith("uploading:")) return;
    const upload = uploads.get(src.slice("uploading:".length));
    if (!upload) {
      pending("unavailable", "上传已中断，请重新插入", "图片");
      return;
    }
    pending(upload?.status === "failed" ? "failed" : "uploading",
      upload?.status === "failed" ? "上传未成功，可重试" : upload?.status === "queued" ? "图片排队中…" : "图片上传中…",
      upload?.name || "图片");
  };
  const ready = () => {
    dom.dataset.state = "ready";
    dom.setAttribute("aria-busy", "false");
    image.hidden = false;
    image.classList.toggle("note-image-zoomable", /^(https?:|blob:)/i.test(image.src));
    placeholder.hidden = true;
  };
  image.addEventListener("load", () => { if (!disposed && image.getAttribute("src")) ready(); });
  dom.addEventListener("click", () => {
    if (dom.dataset.state === "ready" && image.classList.contains("note-image-zoomable")) onZoom(image.src, image.alt);
  });
  image.addEventListener("error", () => {
    if (!disposed) pending("unavailable", "图片暂时无法显示", image.alt || "图片");
  });

  const show = (src: string, alt: string, attempt = 0) => {
    image.alt = alt;
    if (src === shown && attempt === 0) { refreshUpload(uploads); return; }
    shown = src;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    image.removeAttribute("src");
    if (src.startsWith("uploading:")) { refreshUpload(uploads); return; }
    pending("loading", "正在载入图片…", alt || "图片");
    const objectKey = sourceImageObjectKeyFromUrl(src);
    if (!objectKey) {
      if (src) image.src = src;
      else pending("unavailable", "图片暂时无法显示", alt || "图片");
      return;
    }
    void loadSourceImageBlobUrl(objectKey).then(blobUrl => {
      if (disposed || shown !== src) return;
      if (blobUrl) { image.src = blobUrl; return; }
      if (attempt >= 2) { pending("unavailable", "图片暂时无法显示", alt || "图片"); return; }
      retryTimer = setTimeout(() => {
        if (!disposed && shown === src) show(src, alt, attempt + 1);
      }, 1200 * (attempt + 1));
    });
  };
  show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? ""));

  return {
    dom,
    refreshUpload,
    update(next) {
      if (next.type.name !== "image") return false;
      node = next;
      show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? ""));
      return true;
    },
    ignoreMutation: () => true,
    destroy() { disposed = true; if (retryTimer) clearTimeout(retryTimer); },
  };
}

/** Local upload status changes update leaf views without writing shared content or history. */
export function noteImageViewPlugin(onZoom: RefObject<((src: string, alt: string) => void) | undefined>) {
  return $prose(() => {
    const views = new Set<ReturnType<typeof createNoteImageNodeView>>();
    return new Plugin<Uploads>({
      key: noteImageUploadsKey,
      state: {
        init: () => new Map(),
        apply(tr, previous) {
          const next = tr.getMeta(noteImageUploadsKey) as readonly NoteImageUploadView[] | undefined;
          return next ? new Map(next.map(upload => [upload.id, upload])) : previous;
        },
      },
      props: {
        nodeViews: {
          image(node, view) {
            const leaf = createNoteImageNodeView(node, (src, alt) => onZoom.current?.(src, alt));
            leaf.refreshUpload(noteImageUploadsKey.getState(view.state) ?? new Map());
            views.add(leaf);
            return { ...leaf, destroy() { views.delete(leaf); leaf.destroy?.(); } };
          },
        },
      },
      view: () => ({ update(view, previous) {
        const next = noteImageUploadsKey.getState(view.state);
        if (next && next !== noteImageUploadsKey.getState(previous)) views.forEach(leaf => leaf.refreshUpload(next));
      } }),
    });
  });
}
