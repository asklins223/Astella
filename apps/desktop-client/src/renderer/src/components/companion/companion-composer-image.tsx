/**
 * 输入框传图（2026-10-06）：选一张图 → 上传 → 待发送的附件。
 *
 * 渲染层不持有会话令牌：字节交给 main 以 multipart 送 `/uploads/companion-images`
 * （与笔记图片同一条上传管线，同一份合同，只是不挂笔记）。图片真正与她相遇是在
 * 下一轮 turn 的 blocks 里——服务端在创建 turn 时按 url 解析成图片资产，
 * 她再用 `companion_read_image` 读（谁读由图 2026-10-06 的识图路由决定）。
 *
 * 气泡、手记、伴星中心三处展示走的是消息里那个 image 块（与既有的
 * `CompanionRecordImage` 同一渲染器），这里只负责"把图送上去"这一段。
 */
import { useCallback, useMemo, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  NOTE_IMAGE_UPLOAD_MIME_TYPES,
  noteImageUploadFailureMessage,
} from "@ailearn/shared/note-image-upload-contracts";
import { createRequestMeta, gatewayErrorMessage, RendererGatewayError, requireWorkspaceEpoch, unwrapGatewayResult } from "../../app/desktop-client";
import { readFileAsBase64 } from "../../app/read-file-base64.ts";
import { useSourceImage } from "../surfaces/source/source-image.ts";

export interface CompanionComposerImage {
  /** 上传回执给的站内地址；随 turn 上抛的就是它。 */
  readonly url: string;
  /** 图注：用文件名，让"她看的是哪张"在气泡里说得清。 */
  readonly label: string;
}

export interface CompanionImageAttachment {
  readonly image: CompanionComposerImage | null;
  readonly uploading: boolean;
  readonly error: string | null;
  /** 选中文件 → 本地上限校验 → 上传。成功后才算"待发送附件"。 */
  pick(file: File): Promise<void>;
  /** 发送成功后清掉；用户在失败后可以原样重试。 */
  clear(): void;
}

function localUploadFailure(file: File): string | null {
  if (!(NOTE_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    return noteImageUploadFailureMessage({ httpStatus: 415 });
  }
  if (file.size > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
    return noteImageUploadFailureMessage({ httpStatus: 413 });
  }
  return null;
}

export function useCompanionImageAttachment(): CompanionImageAttachment {
  const [image, setImage] = useState<CompanionComposerImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async (file: File) => {
    const localFailure = localUploadFailure(file);
    if (localFailure) {
      setError(localFailure);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      const result = unwrapGatewayResult(await window.ailearn.companion.uploadImage({
        meta: createRequestMeta(epoch),
        request: {
          version: 1,
          fileName: file.name.slice(0, 255) || "image",
          mimeType: file.type as (typeof NOTE_IMAGE_UPLOAD_MIME_TYPES)[number],
          bytesBase64: await readFileAsBase64(file),
        },
      }));
      setImage({ url: result.url, label: formatComposerImageLabel(file.name) });
    } catch (uploadError) {
      // 状态码优先：413/415/429 各自给得出路。没有状态码的网关失败（未登录、
      // 服务不可用）由 `gatewayErrorMessage` 按 code 说；其余（连网关都没碰到）
      // 留在合同那句可重试的说明上，不冒充"服务返回的结果"。
      const status = (uploadError as { httpStatus?: number }).httpStatus;
      const mapped = noteImageUploadFailureMessage({ httpStatus: status });
      setError(mapped === "图片上传失败，请重试" && uploadError instanceof RendererGatewayError
        ? gatewayErrorMessage(uploadError)
        : mapped);
    } finally {
      setUploading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setImage(null);
    setError(null);
  }, []);

  // 引用稳定只在状态真的变化时才换：调用方把这份附件放进 `useCallback` 的依赖里
  // （HUD 的 `sendText` 就是），每次渲染都新一个对象会让那条 memo 形同虚设。
  return useMemo(() => ({ image, uploading, error, pick, clear }), [image, uploading, error, pick, clear]);
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
