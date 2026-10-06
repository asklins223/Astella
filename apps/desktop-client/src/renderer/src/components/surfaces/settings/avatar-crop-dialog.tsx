/**
 * 上传头像前的取景框：照片在正方形窗口里拖动、滚轮（双指）缩放、左右转 90°，
 * 圆孔里看到的就是设置页与顶栏将来的样子；确认后按 CROP_OUTPUT_SIZE 导出，
 * 仍走原来的上传链路（`settings-surface.tsx` 的 uploadAvatar）。
 *
 * 「使用这张」点下去之后框**不立刻收**：上传期间留在原地显示「正在上传…」，
 * 成功才关、失败就地显示原因并保留裁剪结果——网慢时那几秒不能像没反应。
 * 上传中允许取消（上传在后头照走），那时失败由页面提示条兜底；卸载后迟到的
 * 结果一律扔掉（mountedRef），不再写回。
 *
 * 为什么不引 cropper 库：需要的只是一小组「cover 夹取 + 绕图心旋转」的几何
 * （见 ./avatar-crop-geometry.ts），而要贴的是书房自己的纸面语言；现有依赖里也没有裁剪件。
 *
 * 解码用 createImageBitmap（Electron 即 Chromium，EXIF 方向按 from-image 落地），
 * 超过 CROP_MAX_WORKING_EDGE 的原图先降一次采样——预览与导出共用这一张工作图。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useRoomStore } from "../../../app/room-store.ts";
import {
  CROP_MAX_WORKING_EDGE,
  CROP_MAX_ZOOM,
  CROP_OUTPUT_SIZE,
  CROP_VIEWPORT_FALLBACK,
  clampCropOffset,
  cropOutputPixelRatio,
  cropZoom,
  drawCropScene,
  initialCropTransform,
  rotateCrop,
  zoomCropTo,
  type CropSource,
  type CropTransform,
} from "./avatar-crop-geometry.ts";

type Phase = "decoding" | "ready" | "uploading" | "error";

interface WorkingImage {
  readonly image: CanvasImageSource;
  readonly source: CropSource;
}

async function loadWorkingImage(file: File): Promise<WorkingImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (!bitmap.width || !bitmap.height) throw new Error("empty image");
  const maxEdge = Math.max(bitmap.width, bitmap.height);
  if (maxEdge <= CROP_MAX_WORKING_EDGE) {
    return { image: bitmap, source: { width: bitmap.width, height: bitmap.height } };
  }
  const ratio = CROP_MAX_WORKING_EDGE / maxEdge;
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { image: bitmap, source: { width: bitmap.width, height: bitmap.height } };
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { image: canvas, source: { width, height } };
}

function replaceExtension(fileName: string, extension: string): string {
  const base = fileName.replace(/\.[^./\\]*$/, "").trim() || "avatar";
  return `${base}.${extension}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
}

/** 取景框里的场景按输出尺寸重画并编码；webp 编不出来时退 jpeg。 */
async function encodeCropFile(
  image: CanvasImageSource,
  source: CropSource,
  transform: CropTransform,
  fileName: string,
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = CROP_OUTPUT_SIZE;
  canvas.height = CROP_OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  drawCropScene(ctx, image, source, transform, cropOutputPixelRatio(transform.viewport));
  const blob = await canvasToBlob(canvas, "image/webp") ?? await canvasToBlob(canvas, "image/jpeg");
  if (!blob) throw new Error("encode failed");
  const webp = blob.type === "image/webp";
  return new File([blob], replaceExtension(fileName, webp ? "webp" : "jpg"), { type: webp ? "image/webp" : "image/jpeg" });
}

const ROTATION_DURATION = 220;

export function AvatarCropDialog(props: {
  readonly file: File;
  readonly onCancel: () => void;
  /** 上传由父层做：兑现（resolve）才关框，拒绝（reject）的原因就地显示。 */
  readonly onConfirm: (cropped: File) => Promise<void>;
}): ReactElement {
  const motionMode = useRoomStore((state) => (state.reducedMotion ? "off" : state.motionMode));
  const [phase, setPhase] = useState<Phase>("decoding");
  const [errorText, setErrorText] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(CROP_VIEWPORT_FALLBACK);
  const [zoom, setZoom] = useState(1);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<WorkingImage | null>(null);
  const transformRef = useRef<CropTransform | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const rotationRafRef = useRef(0);
  const mountedRef = useRef(true);

  /** 预览只画取景框这一块；导出请同一个函数按输出尺寸再画一遍，所见即所得只有一处公式。 */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const working = imageRef.current;
    const transform = transformRef.current;
    if (!canvas || !working || !transform) return;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const side = Math.max(1, Math.round(transform.viewport * devicePixelRatio));
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side;
      canvas.height = side;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    drawCropScene(ctx, working.image, working.source, transform, devicePixelRatio);
  }, []);

  // 取景框宽度跟着窗口走：几何里用的就是量到的这个数，量不到（jsdom、首帧前）用兜底值。
  useLayoutEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      setViewport(rect && rect.width > 0 ? Math.round(rect.width) : CROP_VIEWPORT_FALLBACK);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer && stageRef.current) observer.observe(stageRef.current);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setPhase("decoding");
    void (async () => {
      try {
        const working = await loadWorkingImage(props.file);
        if (!active) return;
        imageRef.current = working;
        setPhase("ready");
      } catch {
        if (!active) return;
        setErrorText("这张图片没能读出来，可能已损坏或不是图片格式。换一张再来。");
        setPhase("error");
      }
    })();
    return () => { active = false; };
  }, [props.file]);

  // 取景框尺寸变化（或工作图刚就绪）：同一个构图等比换算过去，再夹一次。
  useEffect(() => {
    const working = imageRef.current;
    if (!working) return;
    const current = transformRef.current;
    if (!current) {
      transformRef.current = initialCropTransform(working.source, viewport);
    } else if (current.viewport !== viewport) {
      const ratio = viewport / current.viewport;
      transformRef.current = clampCropOffset(working.source, {
        ...current,
        viewport,
        scale: current.scale * ratio,
        offsetX: current.offsetX * ratio,
        offsetY: current.offsetY * ratio,
      });
    }
    paint();
  }, [viewport, phase, paint]);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    cancelAnimationFrame(rotationRafRef.current);
  }, []);

  // 滚轮与双指都要压住页面滚动，React 的合成事件是 passive 的，只能自己挂。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase !== "ready") return undefined;
    const onWheel = (event: WheelEvent) => {
      const working = imageRef.current;
      const current = transformRef.current;
      if (!working || !current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const focusX = event.clientX - rect.left - current.viewport / 2;
      const focusY = event.clientY - rect.top - current.viewport / 2;
      const next = zoomCropTo(
        working.source,
        current,
        cropZoom(working.source, current) * Math.exp(-event.deltaY * 0.0018),
        focusX,
        focusY,
      );
      transformRef.current = next;
      setZoom(cropZoom(working.source, next));
      paint();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [phase, paint]);

  const turn = (delta: number) => {
    const working = imageRef.current;
    const current = transformRef.current;
    if (!working || !current || phase !== "ready" || rotationRafRef.current) return;
    const from = current.rotation;
    if (motionMode === "off") {
      transformRef.current = rotateCrop(working.source, current, from + delta);
      paint();
      return;
    }
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / ROTATION_DURATION);
      const eased = 1 - (1 - progress) ** 3;
      transformRef.current = rotateCrop(working.source, transformRef.current ?? current, from + delta * eased);
      paint();
      rotationRafRef.current = progress < 1 ? requestAnimationFrame(step) : 0;
    };
    rotationRafRef.current = requestAnimationFrame(step);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = transformRef.current;
    if (phase !== "ready" || !current || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: current.offsetX,
      baseY: current.offsetY,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const working = imageRef.current;
    const current = transformRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !working || !current) return;
    transformRef.current = clampCropOffset(working.source, {
      ...current,
      offsetX: drag.baseX + (event.clientX - drag.startX),
      offsetY: drag.baseY + (event.clientY - drag.startY),
    });
    paint();
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const working = imageRef.current;
    const current = transformRef.current;
    if (!working || !current) return;
    const step = event.shiftKey ? 24 : 8;
    const delta = event.key === "ArrowLeft" ? [-step, 0]
      : event.key === "ArrowRight" ? [step, 0]
      : event.key === "ArrowUp" ? [0, -step]
      : event.key === "ArrowDown" ? [0, step]
      : null;
    if (!delta) return;
    event.preventDefault();
    transformRef.current = clampCropOffset(working.source, {
      ...current,
      offsetX: current.offsetX + delta[0],
      offsetY: current.offsetY + delta[1],
    });
    paint();
  };

  const handleZoomInput = (event: ChangeEvent<HTMLInputElement>) => {
    const working = imageRef.current;
    const current = transformRef.current;
    if (!working || !current) return;
    const next = zoomCropTo(working.source, current, Number(event.currentTarget.value));
    transformRef.current = next;
    setZoom(cropZoom(working.source, next));
    paint();
  };

  /**
   * 退回到可再试的样子。焦点要收回来：提交按钮变禁用那一刻它就把焦点丢给了
   * body，不还回去的话下一次 Tab 会从对话框背后开始找。
   */
  const returnToReady = (message: string) => {
    if (!mountedRef.current) return;
    setUploadError(message);
    setPhase("ready");
    requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
  };

  const confirm = async () => {
    const working = imageRef.current;
    const current = transformRef.current;
    if (!working || !current || phase !== "ready") return;
    setUploadError(null);
    setPhase("uploading");
    let cropped: File;
    try {
      cropped = await encodeCropFile(working.image, working.source, current, props.file.name);
    } catch {
      returnToReady("这次没能生成裁剪结果，请再试一次。");
      return;
    }
    try {
      await props.onConfirm(cropped);
    } catch (error) {
      // 父层成功后已经收框（组件卸载）：迟到的结果扔掉，不写回。
      returnToReady(error instanceof Error && error.message ? error.message : "上传没有完成，请再试一次。");
    }
  };

  return createPortal(
    <div
      className="avatar-crop-backdrop hud-surface"
      data-motion={motionMode}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <section
        className="avatar-crop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
        aria-describedby="avatar-crop-note"
      >
        <h2 id="avatar-crop-title" ref={titleRef} tabIndex={-1}>调整头像</h2>
        <p className="avatar-crop__note" id="avatar-crop-note">
          {phase === "error" ? errorText : "拖动照片选择留下的部分；滚轮、双指或下面的滑块可以缩放。"}
        </p>
        {phase === "error" ? null : (
          <>
            <div className="avatar-crop__stage" ref={stageRef}>
              <canvas
                ref={canvasRef}
                className="avatar-crop__canvas"
                tabIndex={0}
                aria-label="头像取景框，方向键可以移动照片"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                onKeyDown={handleCanvasKeyDown}
              />
              <div className="avatar-crop__mask" aria-hidden="true" />
              {phase === "decoding" ? <p className="avatar-crop__preparing">正在准备照片…</p> : null}
              {phase === "uploading" ? (
                <div className="avatar-crop__busy" role="status">
                  <LoaderCircle className="avatar-crop__spin" size={24} aria-hidden="true" />
                  <span>正在上传…</span>
                </div>
              ) : null}
            </div>
            <div className="avatar-crop__controls">
              <div className="actions">
                <button type="button" className="button" disabled={phase !== "ready"} onClick={() => turn(-90)}>
                  <RotateCcw size={14} aria-hidden="true" />左转
                </button>
                <button type="button" className="button" disabled={phase !== "ready"} onClick={() => turn(90)}>
                  <RotateCw size={14} aria-hidden="true" />右转
                </button>
              </div>
              <div className="avatar-crop__zoom">
                <ZoomOut size={14} aria-hidden="true" />
                <input
                  type="range"
                  min={1}
                  max={CROP_MAX_ZOOM}
                  step={0.01}
                  value={zoom}
                  disabled={phase !== "ready"}
                  aria-label="缩放照片"
                  onChange={handleZoomInput}
                />
                <ZoomIn size={14} aria-hidden="true" />
              </div>
            </div>
            {props.file.type === "image/gif" ? <p className="avatar-crop__gif">动图只会取这一帧。</p> : null}
          </>
        )}
        {uploadError ? <p className="avatar-crop__error" role="alert">{uploadError}</p> : null}
        <div className="avatar-crop__actions actions">
          {phase === "error" ? (
            <button type="button" className="button" onClick={props.onCancel}>关闭</button>
          ) : (
            <>
              <button ref={primaryRef} type="button" className="button primary" disabled={phase !== "ready"} onClick={() => void confirm()}>
                {phase === "uploading" ? "正在上传…" : uploadError ? "再试一次" : "使用这张"}
              </button>
              <button type="button" className="button" onClick={props.onCancel}>取消</button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
