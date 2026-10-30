/**
 * 输入框传图：最多选择12张 → 客户端压缩 → 对象存储 → 待发送附件。
 *
 * 渲染层不持有会话令牌：字节交给 main 以 multipart 送 `/uploads/companion-images`
 * （与笔记图片同一条上传管线，同一份合同，只是不挂笔记）。图片真正与她相遇是在
 * 下一轮 turn 的 blocks 里——服务端在创建 turn 时按 url 解析成图片资产，
 * 配置的视觉主模型直接接收原图，传输较多时由宿主自动分批。
 *
 * 气泡、手记、伴星中心三处展示走的是消息里那个 image 块（与既有的
 * `CompanionRecordImage` 同一渲染器），这里只负责"把图送上去"这一段。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import {
  NOTE_IMAGE_UPLOAD_MIME_TYPES,
  noteImageUploadFailureMessage,
} from "@astella/shared/note-image-upload-contracts";
import { COMPANION_TURN_MAX_IMAGES_V1 } from "@astella/shared/companion-conversation-contracts";
import { prepareCompanionUploadImage } from "./companion-image-compression.ts";
import { createRequestMeta, gatewayErrorMessage, RendererGatewayError, requireWorkspaceEpoch, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { readFileAsBase64 } from "../../../app/source/read-file-base64.ts";
import { useSourceImage } from "../../surfaces/source/source-image.ts";

export interface CompanionComposerImage {
  /** 上传回执给的站内地址；随 turn 上抛的就是它。 */
  readonly url: string;
  /** 图注：用文件名，让"她看的是哪张"在气泡里说得清。 */
  readonly label: string;
}

export interface CompanionImageAttachment {
  readonly images: readonly CompanionComposerImage[];
  readonly uploading: boolean;
  readonly error: string | null;
  /** 选中文件 → 本地上限校验 → 上传。成功后才算"待发送附件"。 */
  pick(files: File | readonly File[]): Promise<void>;
  remove(url: string): void;
  /** 发送成功后清掉；用户在失败后可以原样重试。 */
  clear(): void;
}

function localUploadFailure(file: File): string | null {
  if (!(NOTE_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    return noteImageUploadFailureMessage({ httpStatus: 415 });
  }
  return null;
}

function uploadFailure(error: unknown): string {
  const status = (error as { httpStatus?: number })?.httpStatus;
  const mapped = noteImageUploadFailureMessage({ httpStatus: status });
  return mapped === "图片上传失败，请重试" && error instanceof RendererGatewayError
    ? gatewayErrorMessage(error) : mapped;
}

export function useCompanionImageAttachment(): CompanionImageAttachment {
  const [images, setImages] = useState<CompanionComposerImage[]>([]);
  const imagesRef = useRef<CompanionComposerImage[]>([]);
  const generation = useRef(0);
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async (selected: File | readonly File[]) => {
    if (busy.current) return;
    const files = selected instanceof File ? [selected] : [...selected];
    const available = COMPANION_TURN_MAX_IMAGES_V1 - imagesRef.current.length;
    if (available <= 0) { setError(`一次最多添加 ${COMPANION_TURN_MAX_IMAGES_V1} 张图片。`); return; }
    const ownGeneration = generation.current;
    busy.current = true;
    setUploading(true);
    setError(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      const failures: string[] = [];
      for (const original of files.slice(0, available)) {
        if (generation.current !== ownGeneration) return;
        const localFailure = localUploadFailure(original);
        if (localFailure) { failures.push(localFailure); continue; }
        try {
          const file = await prepareCompanionUploadImage(original);
          const result = unwrapGatewayResult(await window.astella.companion.uploadImage({
            meta: createRequestMeta(epoch),
            request: { version: 1, fileName: file.name.slice(0, 255) || "image",
              mimeType: file.type as (typeof NOTE_IMAGE_UPLOAD_MIME_TYPES)[number],
              bytesBase64: await readFileAsBase64(file) },
          }));
          if (generation.current !== ownGeneration) return;
          imagesRef.current = [...imagesRef.current, { url: result.url, label: formatComposerImageLabel(original.name) }];
          setImages(imagesRef.current);
        } catch (error) { failures.push(uploadFailure(error)); }
      }
      if (files.length > available) failures.push(`一次最多添加 ${COMPANION_TURN_MAX_IMAGES_V1} 张图片。`);
      setError(failures.length ? failures.join("；") : null);
    } catch (uploadError) {
      setError(uploadFailure(uploadError));
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    imagesRef.current = [];
    setImages([]);
    setError(null);
  }, []);
  const remove = useCallback((url: string) => {
    imagesRef.current = imagesRef.current.filter(image => image.url !== url);
    setImages(imagesRef.current);
  }, []);

  // 引用稳定只在状态真的变化时才换：调用方把这份附件放进 `useCallback` 的依赖里
  // （HUD 的 `sendText` 就是），每次渲染都新一个对象会让那条 memo 形同虚设。
  return useMemo(() => ({ images, uploading, error, pick, clear, remove }), [images, uploading, error, pick, clear, remove]);
}

/** 附件区的图名：文件名去掉扩展名，限 24 字，空名回落。 */
export function formatComposerImageLabel(fileName: string): string {
  const bare = fileName.replace(/\.[a-z0-9]+$/i, "").trim();
  const chars = Array.from(bare || "图片");
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : chars.join("");
}

/** 待发送附件的预览条（缩略图 + 图名 + 移除）。 */
export function CompanionComposerImageChip({
  image,
  onRemove,
}: {
  readonly image: CompanionComposerImage;
  readonly onRemove: () => void;
}) {
  const { state } = useSourceImage(image.url);
  return (
    <div className="companion-compose-image" data-ready={state.status === "ready" || undefined}>
      {state.status === "ready"
        ? <img src={state.src} alt={image.label} />
        : <span className="companion-compose-image__placeholder" aria-hidden="true"><ImagePlus size={15} /></span>}
      <span className="companion-compose-image__name">{image.label}</span>
      <button type="button" onClick={onRemove} aria-label="移除这张图" title="移除这张图"><X size={14} /></button>
    </div>
  );
}

/** ＋号旁的上传进度指示（上传中/刚失败的那句话）。 */
export function CompanionComposerImageStatus({
  uploading,
  error,
}: {
  readonly uploading: boolean;
  readonly error: string | null;
}) {
  if (!uploading && !error) return null;
  return (
    <p className="companion-compose-image__status" role="status" data-error={error ? "true" : undefined}>
      {uploading ? <><Loader2 className="companion-hud__spin" size={12} />图片上传中…</> : error}
    </p>
  );
}
