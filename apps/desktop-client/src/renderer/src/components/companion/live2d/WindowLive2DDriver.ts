import {
  DEFAULT_WINDOW_LIVE2D_BODY_FORM,
  DEFAULT_WINDOW_LIVE2D_MODEL_ID,
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_BUST_HEIGHT_RATIO,
  WINDOW_LIVE2D_FIRST_PERFORMANCE_DELAY_MS,
  WINDOW_LIVE2D_PERFORMANCE_EXPRESSION_HOLD_MS,
  WINDOW_LIVE2D_PERFORMANCE_INTERVAL_MS,
  WINDOW_LIVE2D_PERFORMANCE_INTERVAL_SPAN_MS,
  WINDOW_LIVE2D_PERFORMANCE_MOTION_HOLD_MS,
  WindowLive2DPerformanceRotation,
  expressionForWindowLive2DEmotion,
  isApprovedWindowLive2DManifest,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  fatfishIdleHead,
  parameterValuesForWindowLive2D,
  windowLive2DModelDescriptor,
  type WindowLive2DModelDescriptor,
  type WindowLive2DBodyForm,
  type WindowLive2DModelId,
  type WindowLive2DFraming,
  type WindowLive2DMotionCue,
  type WindowLive2DParameterValue,
  type WindowLive2DPerformanceCue,
  type WindowLive2DPresentation,
} from "./window-live2d-contract";
import {
  EMPTY_WINDOW_LIVE2D_CATALOG,
  loadWindowLive2DCatalog,
  motionSpecKey,
  type WindowLive2DCatalog,
} from "./live2d-performance-catalog";
import {
  clampLive2DEmotionIntensity,
  Live2DEmotionController,
  type Live2DEmotionEvent,
} from "./live2d-emotion";
import {
  WINDOW_LIVE2D_DEFAULT_OVERLAY_HOLD_MS,
  momentCueForWindowLive2D,
  propParameterValuesForWindowLive2D,
  type WindowLive2DCharacterMoment,
  type WindowLive2DParameterWrite,
} from "./window-live2d-contract";
import { live2DHeadDrawableIndices, projectVisibleLive2DBounds, type Live2DDrawableBox, type Live2DPartHierarchy } from "../bubble/companion-visible-bounds";

type DriverStatus = "loading" | "ready" | "failed";

/** 情绪强到看得出表情/编排动作的门槛；低于它的情绪不拦待机表演。 */
const EMOTION_MOTION_MIN_INTENSITY = 0.35;

/** 表情同名道具（感叹号 / 问号）留给脸上那个表情，道具通道不抢。 */
interface ActiveProp {
  readonly name: string;
  /** performance clock 时间戳；`null` = 粘在身上的 costume，直到被换下或脱下。 */
  readonly untilMs: number | null;
}

interface PixiPoint {
  x: number;
  y: number;
  set: (x: number, y?: number) => void;
}

interface Live2DCoreModel {
  setParameterValueById?: (parameter: string, value: number, weight?: number) => void;
  getDrawableCount?: () => number;
  getDrawableId?: (index: number) => unknown;
  getDrawableOpacity?: (index: number) => number;
  getDrawableDynamicFlagIsVisible?: (index: number) => boolean;
  getModel?: () => Live2DPartHierarchy;
  /**
   * 读参数在模型里的真实索引与默认值（道具/整活参数演完要回到"没演"的状态）。
   * pixi-live2d 对模型里不存在的 id 会给一个越界影子索引，默认值读出来是
   * undefined，下面的归位层按非有限值跳过，所以写错名字不会污染 0 号参数。
   */
  getParameterIndex?: (parameter: string) => number;
  getParameterDefaultValue?: (index: number) => number;
  /**
   * 部件（Part）透明度：`hiddenParts` 用它在逐帧层把资产里本来就画错的部件
   * 关掉（作者原包的鼻子贴图只在部分体型里是透明的）。
   */
  getPartIndex?: (partId: string) => number;
  setPartOpacityByIndex?: (index: number, opacity: number) => void;
}

interface Live2DDrawableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Live2DInternalModel {
  coreModel?: Live2DCoreModel;
  originalWidth?: number;
  originalHeight?: number;
  /** Bounds in pixi-live2d canvas pixels (y-down, already converted from Cubism units). */
  getDrawableBounds?: (index: number, out?: Live2DDrawableBounds) => Live2DDrawableBounds;
  /**
   * pixi-live2d-display 的 InternalModel 是 EventEmitter（2026-09-19 口型/表情修复）。
   * `beforeModelUpdate` 在 motion + 眨眼 + 物理 + 姿态全部更新完之后、
   * `coreModel.update()` 应用到绘制节点之前发出——只有挂在这里写参数，
   * 我们的口型/表情值才能**每帧确定性地赢过** motion 曲线。
   */
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  /** Cubism WebGL 渲染器。公皮只在绘制前藏掉一块会涂黑领口的网格。 */
  renderer?: FatfishDrawRenderer;
  /** 表情管理器（model3.json 声明了 Expressions 时存在）；情绪过期时用它复位。 */
  motionManager?: {
    stopAllMotions?: () => void;
    expressionManager?: {
      resetExpression?: () => void;
    };
  };
}

/** The character's real content box, as fractions of the model canvas. */
interface Live2DContentBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface FatfishDrawRenderer {
  fatfishNeckHidden?: boolean;
  doDrawModel?: () => void;
  getModel?: () => { _model?: { drawables?: { opacities?: Float32Array } } };
}

interface Live2DModel {
  update?: (deltaMs: number) => void;
  anchor: PixiPoint;
  position: PixiPoint;
  scale: PixiPoint;
  /** Container alpha：模型切换过渡用整模型淡入淡出，不动 Cubism 参数。 */
  alpha: number;
  internalModel?: Live2DInternalModel;
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>;
  /** pixi-live2d-display 的表情接口（model3.json 声明了 Expressions 时可用）。 */
  expression?: (name?: string) => void | Promise<unknown>;
  destroy?: () => void;
}

interface PixiApplication {
  stage: {
    addChild: (child: Live2DModel) => void;
    removeChild?: (child: Live2DModel) => void;
  };
  renderer?: {
    render: (stage: PixiApplication["stage"]) => void;
    resize?: (width: number, height: number) => void;
  };
  ticker?: {
    add: (callback: () => void, context?: unknown, priority?: number) => void;
    remove: (callback: () => void) => void;
    deltaMS?: number;
    maxFPS?: number;
    start?: () => void;
    stop?: () => void;
  };
  destroy: (removeView?: boolean) => void;
}

interface PixiGlobal {
  VERSION?: string;
  Application: new (options: {
    view: HTMLCanvasElement;
    width: number;
    height: number;
    context: WebGLRenderingContext;
    autoStart: boolean;
    antialias: boolean;
    backgroundAlpha: number;
    resolution: number;
    autoDensity: boolean;
  }) => PixiApplication;
  live2d?: {
    Live2DModel?: {
      from: (
        modelUrl: string,
        options: { autoInteract: boolean; autoUpdate: boolean },
      ) => Promise<Live2DModel>;
    };
  };
}

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

const scriptPromises = new Map<string, Promise<void>>();

function resolveBundledAsset(path: string): string {
  const base = new URL(".", document.baseURI);
  const url = new URL(path.replace(/^\/+/, ""), base);

  // Only renderer-bundled, same-origin assets may be executed or loaded.
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error(`Refusing non-bundled Live2D asset: ${url.href}`);
  }

  return url.href;
}

function loadBundledScript(path: string): Promise<void> {
  const src = resolveBundledAsset(path);
  const pending = scriptPromises.get(src);
  if (pending) return pending;

  const promise = new Promise<void>((resolve, reject) => {
    const previous = Array.from(document.scripts).find(
      (script) => script.dataset.windowLive2dSrc === src,
    );

    if (previous?.dataset.loaded === "true") {
      resolve();
      return;
    }

    if (previous?.dataset.failed === "true") previous.remove();

    const script = previous?.dataset.failed === "true"
      ? document.createElement("script")
      : previous ?? document.createElement("script");
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      callback();
    };
    const handleLoad = () => settle(() => {
      script.dataset.loaded = "true";
      resolve();
    });
    const handleError = () => settle(() => {
      script.dataset.failed = "true";
      reject(new Error(`Live2D vendor script failed: ${src}`));
    });
    const timeout = window.setTimeout(() => settle(() => {
      script.dataset.failed = "true";
      reject(new Error(`Live2D vendor script timed out: ${src}`));
    }), 15_000);

    script.dataset.windowLive2dSrc = src;
    script.async = false;
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!script.isConnected) {
      script.src = src;
      document.head.appendChild(script);
    }
  });

  scriptPromises.set(src, promise);
  void promise.then(
    () => {
      if (scriptPromises.get(src) === promise) scriptPromises.delete(src);
    },
    () => {
      if (scriptPromises.get(src) === promise) scriptPromises.delete(src);
    },
  );
  return promise;
}

async function assertApprovedBundledModel(
  descriptor: WindowLive2DModelDescriptor,
): Promise<void> {
  const response = await withTimeout(
    fetch(resolveBundledAsset(descriptor.manifest), {
      cache: "no-store",
      credentials: "same-origin",
    }),
    10_000,
    "Live2D model manifest load timed out",
  );
  if (!response.ok || !isApprovedWindowLive2DManifest(await response.json(), descriptor.manifestExpectation)) {
    throw new Error("Live2D model license approval is unavailable");
  }
}

function getPixi(): PixiGlobal | undefined {
  return (window as unknown as { PIXI?: PixiGlobal }).PIXI;
}

function usableWebGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const context = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
    stencil: true,
  });
  if (!context) return null;

  const textureUnits = context.getParameter(context.MAX_TEXTURE_IMAGE_UNITS);
  return typeof textureUnits === "number" && textureUnits > 0 ? context : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export interface WindowLive2DDriverOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly onStatus?: (status: DriverStatus) => void;
  readonly onGraphicsFailure?: () => void;
}

/**
 * Live2D runtime scoped to one renderer DOM node. It cannot create or move a
 * native window, and it never talks to Electron main/preload APIs.
 */
/**
 * ArtMesh341 是挂在头上的倒过来正片叠底，遮罩只罩住脸。身体前倾时它滑到领口，
 * 领口在遮罩外面，整块乘成黑。绘制前把这块网格的不透明度清掉。
 * 遮罩仍走运行时原来的一次打包绘制。逐组重画 1024 缓冲在这台机器上把一帧绘制
 * 从 2.7 毫秒拉到 8.3 毫秒，而且清掉这块网格之后黑领口已经不在。
 */
function hideFatfishNeckMesh(model: Live2DModel): void {
  const renderer = model.internalModel?.renderer;
  if (!renderer?.doDrawModel || renderer.fatfishNeckHidden) return;
  renderer.fatfishNeckHidden = true;
  const loaded = model.internalModel?.coreModel;
  const drawableCount = loaded?.getDrawableCount?.() ?? 0;
  let neck = -1;
  for (let index = 0; index < drawableCount; index += 1) {
    if (String(loaded?.getDrawableId?.(index)) === "ArtMesh341") {
      neck = index;
      break;
    }
  }
  if (neck < 0) return;
  const drawModel = renderer.doDrawModel.bind(renderer);
  renderer.doDrawModel = () => {
    const opacities = renderer.getModel?.()?._model?.drawables?.opacities;
    if (opacities) opacities[neck] = 0;
    drawModel();
  };
}

export class WindowLive2DDriver {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly onStatus?: (status: DriverStatus) => void;
  private readonly onGraphicsFailure?: () => void;
  private app: PixiApplication | null = null;
  private model: Live2DModel | null = null;
  private modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID;
  private descriptor: WindowLive2DModelDescriptor = windowLive2DModelDescriptor(DEFAULT_WINDOW_LIVE2D_MODEL_ID);
  /** 当前形态的表演清单：会演哪些动作/表情，以及每个表情自己写了哪些参数。 */
  private catalog: WindowLive2DCatalog = EMPTY_WINDOW_LIVE2D_CATALOG;
  /** 当前进行中的切换的令牌：新的 setModel 让旧的加载/淡入直接丢弃。 */
  private switchToken: object | null = null;
  private lastEmotionExpression: string | null | undefined = undefined;
  /**
   * 待机随机表演与点击轮播共用的洗牌袋：两边演的是同一个序列，所以点几下就能
   * 把整套动作 + 表情轮完一遍，不会靠随机数碰运气（见 `WindowLive2DPerformanceRotation`）。
   */
  private performanceRotation = new WindowLive2DPerformanceRotation([]);
  /** 下一次待机随机表演的时间戳（performance clock，同 nowMs）。 */
  private nextPerformanceAtMs = 0;
  /** 随机表演出的表情的名字与收场时间；到点复位回中性脸。 */
  private performanceExpressionName: string | null = null;
  private performanceExpressionUntilMs: number | null = null;
  /** 随机动作的占用窗口；到点把姿势交还给呈现状态机。 */
  private performanceMotionUntilMs: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rendererWidth = 0;
  private rendererHeight = 0;

  // Model time advances on the same private ticker that draws it. A shared
  // ticker otherwise keeps running while hidden and draws at 144Hz on a
  // high-refresh display, competing with every page and HUD animation.
  private readonly advanceModel = (): void => {
    if (this.disposed || this.paused) return;
    const delta = this.app?.ticker?.deltaMS ?? 1000 / 60;
    // 公皮的手势原片大约 1 秒。整段模型时间放慢，收回段才能接上，而不是抽一下。
    this.model?.update?.(this.modelId === "fatfish" ? delta * 0.55 : delta);
  };
  private disposed = false;
  private paused = false;
  private invitePlaying = false;
  private emotionMotionPlaying = false;
  private lastEmotionMotionKey = "";
  private lastEmotionMotionAt = 0;
  private lastMotionKey = "";
  private presentation: WindowLive2DPresentation = "idle";
  /** 页面要的取景。鲸鱼娘上场时仍整身，公皮按这个值：首页全身，其余页半身。 */
  private requestedFraming: WindowLive2DFraming = "full";
  private framing: WindowLive2DFraming = "full";
  /**
   * 当前体型形态（2026-11-05）。`null` = 这个形态没有体型切换（whale）。
   * 应用时才落到 `Clothes2`，见 `applyBodyForm`。
   */
  private bodyForm: WindowLive2DBodyForm | null = null;
  /** 已解析出的隐藏部件索引；模型换掉就作废。 */
  private hiddenPartIndices: readonly number[] | null = null;
  private contentBox: Live2DContentBox | null = null;
  /** 脸的内容盒（归一化，y 向下）。上半身取景用它的水平中心。 */
  private faceBox: Live2DContentBox | null = null;
  /** Model-local shape from its first real frame; poses and temporary props never move UI. */
  private layoutDrawables: readonly Live2DDrawableBox[] | null = null;
  private layoutHeadDrawables: readonly Live2DDrawableBox[] | null = null;
  private voiceLevel = 0;
  private toolAttentionAtMs: number | null = null;
  /** 穿在身上的道具（眼镜）：换形态/换一副才下来。 */
  private costumeProp: ActiveProp | null = null;
  /** 冒一下的道具（问号 / 吐魂 / 爱心）：到点自己收。 */
  private overlayProp: ActiveProp | null = null;
  /**
   * 整活参数归位表：非待机动作动过、而待机动作不碰的参数 → 模型默认值。
   * 包括手机、蛋包饭、临时发型和作者脸部曲线。每帧在 motion 更新之前还原基线，
   * 再交给动作、表情、物理与实时口型，避免结束后留下道具或最后一帧姿势。
   */
  private gagParameterResets: ReadonlyArray<WindowLive2DParameterValue> = [];
  /** 本形态登记为道具的那几件穿戴物的参数写入；道具层只认这张表。 */
  private declaredPropWrites: Readonly<Record<string, ReadonlyArray<WindowLive2DParameterWrite>>> = {};
  /** 正在演的那条动作动了哪些整活参数：这期间让 motion 自己说话，归位层不抢。 */
  private playingGagParameters: ReadonlySet<string> = new Set();
  /**
   * 让位窗口的终点（performance clock 尺度），按资产里的真实时长算。
   *
   * 不拿 motion 的 promise 当依据：pixi-live2d 那条 promise 的兑现时机不反映
   * "演完了"（优先级、淡出、复用同组都会让它提前或延后），以它为准就会出现
   * "动作在演、参数被我们按默认值按住"的静默失灵——2026-09-21 实机核对时撞到。
   */
  private gagWindowUntilMs: number | null = null;
  private readonly emotionController = new Live2DEmotionController();

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed || !event.isTrusted) return;
    console.warn("[WindowLive2D] WebGL context lost; disabling the companion canvas");
    this.onStatus?.("failed");
    this.destroy();
    this.onGraphicsFailure?.();
  };

  /**
   * 每帧参数写入（2026-09-19 口型/表情修复）。
   *
   * 之前挂在 `app.ticker` 上——但 pixi-live2d 的模型更新跑在 `Ticker.shared`
   * （autoUpdate），两条独立 ticker 每帧互相赛跑；而模型自带的每条 motion
   * （包括常驻循环的 Idle）都带**全部 128 条参数曲线**（ParamA、嘴、眼、眉、
   * 腮红全在 motion 里）。motion 一旦后写，我们把语音振幅和情绪 FACS 写进去的
   * 值就被整批抹掉——用户看到的就是"口型和表情没有应用上"。
   *
   * 现在挂在 `beforeModelUpdate` 上：motion/物理更新完 → 我们写 → 核心更新渲染。
   * 顺序确定，不再有竞态。
   */
  private readonly handleMotionUpdate = (): void => {
    if (this.disposed || this.paused) return;
    const core = this.model?.internalModel?.coreModel;
    for (const { parameter, value } of this.gagParameterResets) {
      core?.setParameterValueById?.(parameter, value);
    }
    // 物理读的是 AngleX/Y/Z，并且会用它们覆盖 ParamAngle*。写在 motion 之前，
    // 这一帧的 save 才会把输入交到物理；脸上的 ParamAngle 在物理之后再写。
    if (this.modelId === "fatfish" && core?.setParameterValueById) {
      const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
      const head = fatfishIdleHead(nowMs);
      const set = core.setParameterValueById.bind(core);
      if (!this.playingGagParameters.has("AngleX")) set("AngleX", head.x);
      if (!this.playingGagParameters.has("AngleY")) set("AngleY", head.y);
      if (!this.playingGagParameters.has("AngleZ")) set("AngleZ", head.z);
    }
  };

  private readonly handleModelUpdate = (): void => {
    if (this.disposed || this.paused || !this.model) return;
    const coreModel = this.model.internalModel?.coreModel;
    const setParameter = coreModel?.setParameterValueById;
    if (!setParameter) return;

    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    try {
      const emotion = this.emotionController.update(nowMs);
      this.playEmotionMotion(emotion.emotion, emotion.intensity, nowMs);
      this.syncEmotionExpression(emotion);
      this.tickPerformance(nowMs, emotion);
      this.expireOverlayProp(nowMs);
      this.expireGagWindow(nowMs);
      const write = (values: Iterable<WindowLive2DParameterValue>): void => {
        for (const { parameter, value } of values) {
          setParameter.call(coreModel, parameter, value);
        }
      };
      // Baseline reset already ran before motion/expression/physics, like iOS.
      // Resetting here would erase a meal, hairstyle, or the author's smile.
      write(parameterValuesForWindowLive2D({
        presentation: this.presentation,
        nowMs,
        voiceLevel: this.voiceLevel,
        emotion,
        toolAttentionAtMs: this.toolAttentionAtMs ?? undefined,
        lipSyncParameter: this.descriptor.lipSyncParameter,
        modelId: this.modelId,
        expressionOwnedParameters: this.activeExpressionOwnedParameters(),
        motionOwnedParameters: this.playingGagParameters,
      }));
      write(this.propParameterValues());
      this.applyBodyForm();
    } catch (error) {
      console.warn("[WindowLive2D] parameter update failed; disabling the companion canvas", error);
      this.onStatus?.("failed");
      this.destroy();
    }
  };

  private readonly resizeToContainer = (): void => {
    if (!this.app || !this.model) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (width === this.rendererWidth && height === this.rendererHeight) return;
    this.rendererWidth = width;
    this.rendererHeight = height;
    // Resize the existing backing surface in place. Recreating the whole
    // Live2D tree on every browser zoom/viewport change produces a transparent
    // loading frame and makes an otherwise continuous move look like a flash.
    this.app.renderer?.resize?.(width, height);
    this.fitModel();
    this.renderCurrentFrame();
  };

  constructor(options: WindowLive2DDriverOptions) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.onStatus = options.onStatus;
    this.onGraphicsFailure = options.onGraphicsFailure;
  }

  /**
   * 首次启动：许可校验 → vendor 脚本 → Pixi 应用 → 挂载指定模型。
   * vendor 脚本与 Pixi 应用对所有模型共用；模型本身走 `attachModel`，
   * 之后切换形态用 `setModel`，不会重建这套运行时。
   */
  async init(modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID): Promise<void> {
    if (this.disposed) return;
    this.onStatus?.("loading");
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);

    try {
      const descriptor = windowLive2DModelDescriptor(modelId);
      await assertApprovedBundledModel(descriptor);
      if (this.disposed) return;
      for (const script of WINDOW_LIVE2D_ASSETS.vendorScripts) {
        await loadBundledScript(script);
        if (this.disposed) return;
      }

      const pixi = getPixi();
      if (!pixi?.live2d?.Live2DModel || !window.Live2DCubismCore) {
        throw new Error("Live2D runtime globals unavailable");
      }

      const context = usableWebGLContext(this.canvas);
      if (!context) throw new Error("No usable WebGL context for Live2D");

      const app = new pixi.Application({
        view: this.canvas,
        width: Math.max(1, this.container.clientWidth),
        height: Math.max(1, this.container.clientHeight),
        context,
        autoStart: true,
        antialias: true,
        backgroundAlpha: 0,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (this.disposed) {
        app.destroy(false);
        return;
      }
      this.app = app;
      this.rendererWidth = Math.max(1, this.container.clientWidth);
      this.rendererHeight = Math.max(1, this.container.clientHeight);
      if (app.ticker) app.ticker.maxFPS = 60;
      // Pixi's Application render listener has LOW priority (-25).
      app.ticker?.add(this.advanceModel, this, 50);

      const [model, catalog] = await Promise.all([
        this.loadModel(descriptor.model),
        loadWindowLive2DCatalog(descriptor, resolveBundledAsset),
      ]);
      if (this.disposed) {
        model.destroy?.();
        return;
      }
      if (!model.internalModel?.coreModel?.setParameterValueById) {
        model.destroy?.();
        throw new Error("Live2D core parameter API unavailable");
      }

      this.attachModel(model, modelId, descriptor, catalog);
      // Never report ready until the backing canvas contains a real model
      // frame. This keeps the reserved seat stable until the actor is visible.
      this.renderCurrentFrame();
      if (this.paused) {
        app.ticker?.stop?.();
      }

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(this.resizeToContainer);
        this.resizeObserver.observe(this.container);
      }
      window.addEventListener("resize", this.resizeToContainer);
      window.visualViewport?.addEventListener("resize", this.resizeToContainer);

      this.onStatus?.("ready");
      this.applyPresentation(this.presentation);
    } catch (error) {
      if (!this.disposed) {
        console.warn("[WindowLive2D] bootstrap failed; disabling the companion canvas", error);
        this.onStatus?.("failed");
      }
      this.destroy();
    }
  }

  /**
   * 运行时切换伴星形态。加载在后台进行（旧模型保持可见），新模型就绪后：
   * 旧模型整模型淡出 → 释放 → 新模型淡入。切换期间不把状态打回 loading，
   * 避免座位闪成空位。加载或许可失败时保留旧模型并只记日志——切过去不可用
   * 的形态比留在当前形态更糟；只有当前根本没有模型时才上报 failed。
   */
  async setModel(modelId: WindowLive2DModelId): Promise<void> {
    if (this.disposed || !this.app) return;
    if (modelId === this.modelId && this.model) {
      // 切走又切回来的旧实现会在这里直接 return，正在加载的另一个形态
      // 仍然完成并把它顶掉——用户看到的就是「换角色无效」。让迟到者作废。
      this.switchToken = {};
      return;
    }

    const token = this.switchToken = {};
    const descriptor = windowLive2DModelDescriptor(modelId);

    try {
      await assertApprovedBundledModel(descriptor);
      const [model, catalog] = await Promise.all([
        this.loadModel(descriptor.model),
        loadWindowLive2DCatalog(descriptor, resolveBundledAsset),
      ]);
      if (this.disposed) {
        model.destroy?.();
        return;
      }
      if (this.switchToken !== token) {
        // 已有更新的切换接管：这个晚到的候选模型直接丢弃。
        model.destroy?.();
        return;
      }
      if (!model.internalModel?.coreModel?.setParameterValueById) {
        model.destroy?.();
        throw new Error("Live2D core parameter API unavailable");
      }

      const previous = this.model;
      const wasPaused = this.paused;
      if (wasPaused) this.app.ticker?.start?.();

      if (previous) {
        await this.fadeModel(previous, descriptor.fadeOutMs, 1, 0);
        if (this.switchToken !== token) {
          model.destroy?.();
          previous.alpha = 1;
          this.renderCurrentFrame();
          return;
        }
        this.detachModel(previous);
        previous.destroy?.();
      }

      this.attachModel(model, modelId, descriptor, catalog);
      await this.fadeModel(model, descriptor.fadeInMs, 0, 1);
      if (this.switchToken !== token) return;
      this.applyPresentation(this.presentation);
      if (wasPaused && this.paused) {
        this.renderCurrentFrame();
        this.app?.ticker?.stop?.();
      }
    } catch (error) {
      if (!this.disposed) {
        console.warn("[WindowLive2D] model switch failed; keeping the current model", error);
        if (!this.model) this.onStatus?.("failed");
      }
      if (this.switchToken === token) this.switchToken = null;
    }
  }

  /** 从 model3.json 加载一个模型；超时与晚到释放复用 init 时代的兜底。 */
  private loadModel(modelUrl: string): Promise<Live2DModel> {
    const pixi = getPixi();
    const modelFactory = pixi?.live2d?.Live2DModel;
    if (!pixi || !modelFactory || !window.Live2DCubismCore) {
      throw new Error("Live2D runtime globals unavailable");
    }

    const modelPromise = modelFactory.from(resolveBundledAsset(modelUrl), {
      autoInteract: false,
      autoUpdate: false,
    });
    // A timeout cannot cancel pixi-live2d's internal fetch/decode. If the
    // late promise eventually resolves after disposal, release that model.
    void modelPromise.then((lateModel) => {
      if (this.disposed && lateModel !== this.model) {
        lateModel.destroy?.();
      }
    }, () => undefined);
    return withTimeout(
      modelPromise,
      25_000,
      "Live2D model load timed out",
    );
  }

  /** 把模型接进舞台与更新周期，换上它的表演清单，并重算取景。 */
  private attachModel(
    model: Live2DModel,
    modelId: WindowLive2DModelId,
    descriptor: WindowLive2DModelDescriptor,
    catalog: WindowLive2DCatalog,
  ): void {
    this.model = model;
    this.modelId = modelId;
    // 取景跟着已经画出来的这只走。半身请求先到时，不能把窗口套到还在淡出的鲸鱼娘上。
    this.framing = modelId === "whale" ? "full" : this.requestedFraming;
    this.descriptor = descriptor;
    // 新模型 = 新的部件索引；旧索引在新模型上指向别的部件。
    this.hiddenPartIndices = null;
    if (this.bodyForm === null && descriptor.bodyForms) this.bodyForm = DEFAULT_WINDOW_LIVE2D_BODY_FORM;
    this.layoutDrawables = null;
    this.layoutHeadDrawables = null;
    for (const edge of ["left", "right", "top", "bottom"]) this.container.style.removeProperty(`--companion-model-head-${edge}`);
    this.catalog = catalog;
    this.performanceRotation = new WindowLive2DPerformanceRotation(catalog.performanceCues);
    this.lastMotionKey = "";
    this.lastEmotionMotionKey = "";
    this.lastEmotionExpression = undefined;
    this.invitePlaying = false;
    this.emotionMotionPlaying = false;
    this.performanceExpressionName = null;
    this.performanceExpressionUntilMs = null;
    this.performanceMotionUntilMs = null;
    this.costumeProp = null;
    this.overlayProp = null;
    this.playingGagParameters = new Set();
    this.gagWindowUntilMs = null;
    this.gagParameterResets = this.buildGagParameterResets();
    this.declaredPropWrites = Object.fromEntries(
      Object.keys(descriptor.propRoles)
        .filter((name) => this.catalog.expressionWrites[name]?.length)
        .map((name) => [name, this.catalog.expressionWrites[name]]),
    );
    // 新模型上场先安静站几秒，不立刻插表演。
    const bootMs = typeof performance === "undefined" ? Date.now() : performance.now();
    this.nextPerformanceAtMs = bootMs + WINDOW_LIVE2D_FIRST_PERFORMANCE_DELAY_MS;
    model.anchor.set(0.5, 0.5);
    model.alpha = 1;
    this.app?.stage.addChild(model);
    // 归位先于 motion；自然输入、口型和道具仲裁在 motion 之后落位。
    model.internalModel?.on?.("beforeMotionUpdate", this.handleMotionUpdate);
    model.internalModel?.on?.("beforeModelUpdate", this.handleModelUpdate);
    if (modelId === "fatfish") hideFatfishNeckMesh(model);
    this.measureContentBox();
    this.fitModel();
    this.renderCurrentFrame();
  }

  private detachModel(model: Live2DModel): void {
    model.internalModel?.off?.("beforeMotionUpdate", this.handleMotionUpdate);
    model.internalModel?.off?.("beforeModelUpdate", this.handleModelUpdate);
    this.app?.stage.removeChild?.(model);
  }

  /** 整模型 alpha 过渡（ease-out cubic），逐帧显式渲染，不依赖 ticker 是否在跑。 */
  private fadeModel(model: Live2DModel, durationMs: number, from: number, to: number): Promise<void> {
    if (durationMs <= 0 || from === to) {
      model.alpha = to;
      this.renderCurrentFrame();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const startMs = typeof performance === "undefined" ? Date.now() : performance.now();
      const step = (): void => {
        if (this.disposed) {
          resolve();
          return;
        }
        const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
        const progress = Math.min(1, (nowMs - startMs) / durationMs);
        const eased = 1 - (1 - progress) ** 3;
        model.alpha = from + (to - from) * eased;
        this.renderCurrentFrame();
        if (progress >= 1) {
          resolve();
          return;
        }
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    });
  }

  /**
   * 待机随机表演（2026-09-20 用户反馈「别老是一个待机动作转圈」）：
   * 每隔一段从洗牌袋里抽下一条演，抽完整袋才重洗，所以一袋之内每个动作、
   * 每个表情都会演到一次。只在静息类呈现（idle/listen）下插戏，说话/思考/
   * 邀请期间不抢戏。动作放完由 motion manager 自己落回 Idle；表情是粘性的，
   * 到点显式复位（见 performanceExpressionUntilMs）。
   */
  private pendingRelease: { cue: WindowLive2DMotionCue; atMs: number } | null = null;

  private motionScale(): number {
    return this.modelId === "fatfish" ? 0.55 : 1;
  }

  private scaledMotionMs(cue: WindowLive2DMotionCue): number {
    const spec = this.catalog.motionSpecs[motionSpecKey(cue.group, cue.index)];
    return (spec?.durationMs ?? 0) / this.motionScale();
  }

  private tickPerformance(nowMs: number, emotion: { emotion: string | null; intensity: number }): void {
    if (this.pendingRelease && nowMs >= this.pendingRelease.atMs) {
      const cue = this.pendingRelease.cue;
      this.pendingRelease = null;
      void this.startGagMotion(cue, nowMs, this.scaledMotionMs(cue));
    }
    // 随机动作演完：把姿势交还给呈现状态机（这期间 setPresentation 只记不改）。
    if (this.performanceMotionUntilMs !== null && nowMs >= this.performanceMotionUntilMs) {
      this.performanceMotionUntilMs = null;
      this.lastMotionKey = "";
      if (!this.invitePlaying && !this.emotionMotionPlaying) this.applyPresentation(this.presentation);
    }
    // 到点先收掉随机表演的表情（情绪表情由 syncEmotionExpression 管，不碰）。
    if (this.performanceExpressionUntilMs !== null && nowMs >= this.performanceExpressionUntilMs) {
      this.performanceExpressionUntilMs = null;
      this.performanceExpressionName = null;
      if (typeof this.lastEmotionExpression === "string") {
        void Promise.resolve(this.model?.expression?.(this.lastEmotionExpression)).catch(
          (error: unknown) => console.warn("[WindowLive2D] restoring emotion failed", error),
        );
      } else {
        try {
          this.model?.internalModel?.motionManager?.expressionManager?.resetExpression?.();
        } catch {
          // 表情管理器缺失是正常情况。
        }
      }
    }

    if (this.invitePlaying || this.emotionMotionPlaying) {
      // 有戏在演：把下一次表演顺延，避免刚演完立刻又插一条。
      this.nextPerformanceAtMs = Math.max(
        this.nextPerformanceAtMs,
        nowMs + WINDOW_LIVE2D_PERFORMANCE_INTERVAL_MS,
      );
      return;
    }
    if (this.presentation !== "idle" && this.presentation !== "listen") return;
    if (nowMs < this.nextPerformanceAtMs) return;

    const cue = this.performanceRotation.next();
    if (!cue) return;
    // 随机表情和情绪表情是同一张脸：情绪还挂着的这一轮把表情塞回袋口，只让动作过。
    // 之前是整条表演被情绪门槛挡掉，结果一段有对话的陪伴里她几乎不演（实机 24s 零场）。
    if (cue.kind === "expression"
      && emotion.emotion
      && emotion.intensity >= EMOTION_MOTION_MIN_INTENSITY) {
      this.performanceRotation.restore(cue);
      this.nextPerformanceAtMs = nowMs + WINDOW_LIVE2D_PERFORMANCE_INTERVAL_MS;
      return;
    }
    this.playPerformanceCue(cue, nowMs);
    this.schedulePerformance(nowMs);
  }

  private schedulePerformance(nowMs: number): void {
    const occupiedUntil = Math.max(nowMs, this.performanceMotionUntilMs ?? 0,
      this.gagWindowUntilMs ?? 0, this.performanceExpressionUntilMs ?? 0, this.overlayProp?.untilMs ?? 0);
    this.nextPerformanceAtMs = occupiedUntil + WINDOW_LIVE2D_PERFORMANCE_INTERVAL_MS
      + Math.random() * WINDOW_LIVE2D_PERFORMANCE_INTERVAL_SPAN_MS;
  }

  private playPerformanceCue(
    entry: WindowLive2DPerformanceCue,
    nowMs: number,
  ): void {
    if (this.disposed || !this.model) return;
    if (entry.kind === "motion") {
      // 这段时间里呈现状态机不改姿势，否则刚演完的轮播条目会被 invite/celebrate 覆盖。
      this.playOneShotMotion(entry.cue, nowMs);
      return;
    }
    if (entry.kind === "prop") {
      // 点击轮播/待机表演也能抽到眼镜和贴纸：走道具通道而不是表情槽，
      // 否则一张脸换表情就会把上一件穿戴物一起摘掉（表情槽是互斥的）。
      // 随机抽到的 costume 也只挂一个停留时长——随机不该永久改形象。
      this.overlayProp = {
        name: entry.name,
        untilMs: nowMs + WINDOW_LIVE2D_PERFORMANCE_EXPRESSION_HOLD_MS,
      };
      return;
    }
    void Promise.resolve(this.model.expression?.(entry.name)).catch(
      (error: unknown) => console.warn("[WindowLive2D] performance expression failed", error),
    );
    this.performanceExpressionName = entry.name;
    this.performanceExpressionUntilMs = nowMs + WINDOW_LIVE2D_PERFORMANCE_EXPRESSION_HOLD_MS;
  }

  /** 此刻脸上生效的表情名（随机表演优先，其次情绪表情）；没有表情返回 null。 */
  private activeExpressionName(): string | null {
    if (this.performanceExpressionName !== null) return this.performanceExpressionName;
    return typeof this.lastEmotionExpression === "string" ? this.lastEmotionExpression : null;
  }

  /**
   * 当前表情自己写过的参数：这些参数在表情有效期间不再由眨眼 / FACS 层逐帧覆盖
   * （见 `parameterValuesForWindowLive2D` 的 `expressionOwnedParameters`）。
   */
  private activeExpressionOwnedParameters(): ReadonlySet<string> | undefined {
    const name = this.activeExpressionName();
    return name ? this.catalog.expressionParameters[name] : undefined;
  }

  /**
   * 道具层：把登记表里的装饰按「穿着写资产值 / 没穿写 0」逐帧落参数。
   *
   * 只遍历这个形态**登记过**的道具（`declaredPropWrites`），不遍历全部表情：
   * 否则大肥鱼哭时的泪痕会被这一层按 0 抹平，等于把表情系统
   * 又拆一遍。状态无关，所以不存在收不回去的贴纸。
   * 脸上那张表情自己写过的参数（感叹号、问号既是脸又是提醒贴纸）整条跳过，不抢。
   */
  private propParameterValues(): ReadonlyArray<WindowLive2DParameterValue> {
    return propParameterValuesForWindowLive2D({
      costume: this.propWrites(this.costumeProp),
      overlay: this.propWrites(this.overlayProp),
      declared: this.declaredPropWrites,
      reservedParameters: new Set([...this.activeExpressionOwnedParameters() ?? [], ...this.playingGagParameters]),
    });
  }

  private propWrites(prop: ActiveProp | null): ReadonlyArray<WindowLive2DParameterWrite> | null {
    if (!prop) return null;
    return this.catalog.expressionWrites[prop.name] ?? null;
  }

  /** overlay 到点收回；costume（`untilMs === null`）一直挂着，由时刻表负责脱下。 */
  private expireOverlayProp(nowMs: number): void {
    const untilMs = this.overlayProp?.untilMs;
    if (typeof untilMs === "number" && nowMs >= untilMs) this.overlayProp = null;
  }

  /** motion 的让位窗口到点：归位层重新接管这些参数，手机/喷水/泡泡糖就此收回。 */
  private expireGagWindow(nowMs: number): void {
    if (this.gagWindowUntilMs === null || nowMs < this.gagWindowUntilMs) return;
    this.gagWindowUntilMs = null;
    this.playingGagParameters = new Set();
  }

  /**
   * 基线归位表：非待机动作动过、而待机动作不碰的参数 → 模型默认值。
   *
   * 大肥鱼的动作各管各的道具参数（`pengshui`、`phone*`、`chuipaopao*`），idle 一条
   * 都不覆盖它们，所以 Cubism 里那份"最后一帧的值"会一直挂着——自拍演完手机还举着。
   */
  private buildGagParameterResets(): ReadonlyArray<WindowLive2DParameterValue> {
    const coreModel = this.model?.internalModel?.coreModel;
    const getIndex = coreModel?.getParameterIndex;
    const getDefaultValue = coreModel?.getParameterDefaultValue;
    if (!coreModel || !getIndex || !getDefaultValue) return [];

    const resets: WindowLive2DParameterValue[] = [];
    const seen = new Set<string>();
    for (const spec of Object.values(this.catalog.motionSpecs)) {
      for (const parameter of spec.parameters) {
        if (seen.has(parameter) || this.catalog.idleMotionParameters.has(parameter)) continue;
        seen.add(parameter);
        const value = getDefaultValue.call(coreModel, getIndex.call(coreModel, parameter));
        if (!Number.isFinite(value)) continue;
        resets.push({ parameter, value });
      }
    }
    return resets;
  }

  /**
   * 一次「语义时刻」：接到任务 / 工具成功 / 失败 / 等确认 / 主动提醒……
   *
   * 落成什么是这个形态自己的登记表说了算（`momentCue`），驱动器只负责排队与让位：
   * 正被点击轮播或情绪动作占用时不插队，动作长度按资产里的真实时长占用姿势，
   * 道具则不受动作窗口影响（眼镜不该因为一条 0.5s 的喷水就消失）。
   */
  pushMoment(moment: WindowLive2DCharacterMoment): void {
    if (this.disposed || !this.model) return;
    const cue = momentCueForWindowLive2D(moment, this.modelId);
    if (!cue) return;

    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    if (cue.costume !== undefined) {
      this.costumeProp = cue.costume === null ? null : { name: cue.costume, untilMs: null };
    }
    if (cue.overlay) {
      this.overlayProp = {
        name: cue.overlay,
        untilMs: nowMs + (cue.holdMs ?? WINDOW_LIVE2D_DEFAULT_OVERLAY_HOLD_MS),
      };
    }
    if (!cue.motion
      || this.invitePlaying
      || this.emotionMotionPlaying
      || (this.performanceMotionUntilMs !== null && nowMs < this.performanceMotionUntilMs)) {
      return;
    }
    this.playOneShotMotion(cue.motion, nowMs);
  }

  /** 演一条不循环的动作，并按它的真实时长占用姿势。 */
  private playOneShotMotion(cue: WindowLive2DMotionCue, nowMs: number): void {
    const forward = this.scaledMotionMs(cue);
    const release = cue.release;
    const back = release ? this.scaledMotionMs(release) : 0;
    const hold = release ? 500 : 0;
    this.performanceMotionUntilMs = nowMs
      + Math.max(WINDOW_LIVE2D_PERFORMANCE_MOTION_HOLD_MS, forward + hold + back);
    this.pendingRelease = release ? { cue: release, atMs: nowMs + forward + hold } : null;
    void this.startGagMotion(cue, nowMs, forward + hold + back).catch((error: unknown) => {
      console.warn("[WindowLive2D] performance motion failed", { cue, error });
    });
  }

  /**
   * 起一条 motion，并在它演的时候让开它自己的整活参数（见归位层）。
   * 返回模型的 motion promise，调用方按原语义继续做"演完落回呈现姿势"的收尾。
   */
  /**
   * 起一条 motion，并按资产时长让开它自己的整活参数。
   * 返回模型的 motion promise 只为兼容调用方的收尾，不用于判定"还在演"。
   */
  private startGagMotion(cue: WindowLive2DMotionCue, nowMs: number, occupiedMs?: number): Promise<unknown> {
    const spec = this.catalog.motionSpecs[motionSpecKey(cue.group, cue.index)];
    this.playingGagParameters = new Set([
      ...this.playingGagParameters,
      ...(spec?.parameters ?? []),
    ]);
    // 尾巴上多给半秒：淡出期间 motion 还在写值，提前归位会看到她"啪"地收回。
    const until = nowMs + (occupiedMs ?? (spec?.durationMs ?? 0) / this.motionScale()) + 500;
    this.gagWindowUntilMs = Math.max(this.gagWindowUntilMs ?? 0, until);
    return Promise.resolve(this.model?.motion?.(cue.group, cue.index, 2));
  }

  /**
   * 情绪 → 模型自带表情（映射为空时保持 FACS 参数路径）。
   * 表情是"粘性"的：pixi-live2d 会一直保留最后设置的表情，所以情绪过期时
   * 必须显式 resetExpression，否则一张脸挂到下一次情绪。
   */
  private syncEmotionExpression(emotion: { emotion: string | null; intensity: number }): void {
    const name = emotion.emotion && emotion.intensity >= EMOTION_MOTION_MIN_INTENSITY
      ? expressionForWindowLive2DEmotion(emotion.emotion, this.modelId)
      : null;
    if (name === this.lastEmotionExpression) return;
    this.lastEmotionExpression = name;
    if (!this.model) return;
    // A tap holds the face briefly; remember new delivery cues for its release.
    if (this.performanceExpressionName !== null) return;

    if (name) {
      void Promise.resolve(this.model.expression?.(name)).catch(
        (error: unknown) => console.warn("[WindowLive2D] emotion expression failed", error),
      );
    } else {
      try {
        this.model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
      } catch {
        // 表情管理器缺失（模型不声明 Expressions 或按需加载失败）是正常情况。
      }
    }
  }

  setPresentation(presentation: WindowLive2DPresentation): void {
    this.presentation = presentation;
    // 随机动作的占用窗口内只记录目标呈现，窗口结束再落位（见 performanceMotionUntilMs）。
    if (!this.disposed
      && !this.invitePlaying
      && !this.emotionMotionPlaying
      && this.performanceMotionUntilMs === null) {
      this.applyPresentation(presentation);
    }
  }

  setFraming(framing: WindowLive2DFraming): void {
    // 请求可以先于模型到达。鲸鱼娘不被提前改成半身；公皮用页面给出的取景。
    this.requestedFraming = framing;
    const committed: WindowLive2DFraming = this.modelId === "whale" ? "full" : framing;
    if (this.framing === committed) return;
    this.framing = committed;
    if (!this.disposed && this.model) {
      if (!this.contentBox) this.measureContentBox();
      this.fitModel();
      this.renderCurrentFrame();
    }
  }

  /**
   * 切换体型形态（2026-11-05）。不支持体型的形态静默忽略，而不是把参数写坏。
   *
   * 写入落在 `applyBodyForm`（每帧、在 motion/物理之后），所以动作里带的
   * `Clothes2` 曲线不会把体型抢回去。
   */
  setBodyForm(bodyForm: WindowLive2DBodyForm): void {
    if (this.bodyForm === bodyForm) return;
    this.bodyForm = bodyForm;
    if (this.disposed) return;
    this.applyBodyForm();
    // 体型直接改变角色可见高度，取景必须跟着重算，否则小形态会缩在角落里。
    if (this.model) {
      this.layoutDrawables = null;
      this.layoutHeadDrawables = null;
      this.measureContentBox();
      this.fitModel();
      this.renderCurrentFrame();
    }
  }

  /**
   * 体型与「永不显示」部件的实际写入点（每帧）。
   *
   * `Part46「鼻子」` 这类部件在部分体型取值下画的是纯黑贴图，登记在
   * `descriptor.hiddenParts` 里，这里每帧置 0——不依赖资产本身是否干净。
   */
  private applyBodyForm(): void {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    const value = this.bodyForm === null ? undefined : this.descriptor.bodyForms?.[this.bodyForm];
    if (typeof value === "number" && Number.isFinite(value)) {
      core.setParameterValueById("Clothes2", value);
      // Param34 是两套五官的透明度开关。中间值会把脸插在半道上；物理又把任意
      // 非零 Clothes2 收到 1，大号和中号就会叠上小号五官，皮肤颜色和眨眼都不对。
      // 小号用 1，中号和大号用 0。鲸鱼娘没有这条参数，写失败就跳过。
      try {
        core.setParameterValueById("Param34", value >= 0.7 ? 1 : 0);
      } catch {
        // 这个模型没有 Param34。
      }
    }
    const setPartOpacity = core.setPartOpacityByIndex;
    if (!setPartOpacity) return;
    if (this.hiddenPartIndices === null) {
      const resolvePart = core.getPartIndex;
      this.hiddenPartIndices = resolvePart
        ? (this.descriptor.hiddenParts ?? [])
          .map((id) => {
            try {
              return resolvePart.call(core, id);
            } catch {
              return -1;
            }
          })
          .filter((index): index is number => typeof index === "number" && index >= 0)
        : [];
    }
    for (const index of this.hiddenPartIndices) {
      setPartOpacity.call(core, index, 0);
    }
  }

  setVoiceLevel(level: number): void {
    this.voiceLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  pushEmotion(event: Live2DEmotionEvent): void {
    if (this.disposed) return;
    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    const intensity = clampLive2DEmotionIntensity(event.intensity);
    this.emotionController.push({ ...event, intensity, at: nowMs }, nowMs);
    this.playEmotionMotion(event.emotion, intensity, nowMs);
  }

  /**
   * 「看向手边」（方案 §5 第 9 项）：工具开始执行时给一次极小幅侧身。
   * 只记下起点时间，形状由 `parameterValuesForWindowLive2D` 的 `gaze` 层算，
   * 所以暂停 / 隐藏时不会留下半截参数。
   */
  pushToolAttention(): void {
    if (this.disposed) return;
    this.toolAttentionAtMs = typeof performance === "undefined" ? Date.now() : performance.now();
  }

  playInviteOnce(): void {
    if (this.disposed || !this.model || this.invitePlaying) return;
    // 点击 = 轮播表演：从洗牌袋里取下一条（动作或表情），一袋抽完才重洗，
    // 所以连点能把这个形态的全部动作和表情轮一遍，不会连着两下同一出。
    const cue = this.performanceRotation.next();
    if (cue) {
      const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
      const hadPerformanceExpression = this.performanceExpressionName !== null;
      this.model.internalModel?.motionManager?.stopAllMotions?.();
      this.pendingRelease = null;
      this.performanceMotionUntilMs = null;
      this.playingGagParameters = new Set();
      this.gagWindowUntilMs = null;
      this.performanceExpressionName = null;
      this.performanceExpressionUntilMs = null;
      this.overlayProp = null;
      if (hadPerformanceExpression) {
        this.model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
        if (cue.kind !== "expression" && typeof this.lastEmotionExpression === "string") {
          void Promise.resolve(this.model.expression?.(this.lastEmotionExpression)).catch(
            (error: unknown) => console.warn("[WindowLive2D] restoring emotion failed", error),
          );
        }
      }
      this.lastMotionKey = "";
      if (cue.kind !== "motion") this.applyPresentation(this.presentation);
      this.playPerformanceCue(cue, nowMs);
      this.schedulePerformance(nowMs);
      return;
    }
    // 清单读不出来的形态回落到 invite 动作；再没有就静默跳过（点击仍由父组件处理）。
    const inviteCue = this.descriptor.presentationMotion.invite;
    if (!inviteCue) return;
    this.invitePlaying = true;
    void Promise.resolve(
      this.model.motion?.(inviteCue.group, inviteCue.index, 2),
    )
      .catch((error: unknown) => {
        console.warn("[WindowLive2D] invite motion failed", error);
      })
      .finally(() => {
        this.invitePlaying = false;
        this.lastMotionKey = "";
        // If an emotion motion was already running, its completion owns the
        // restore. Applying the presentation here would otherwise interrupt
        // that motion with a late invite callback.
        if (!this.disposed && !this.emotionMotionPlaying && this.performanceMotionUntilMs === null) {
          this.applyPresentation(this.presentation);
        }
      });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      // A resize/zoom can rebuild the canvas while the window is already
      // unfocused. Paint one registered frame before stopping the ticker so
      // pause keeps a visible companion instead of a transparent ready canvas.
      this.renderCurrentFrame();
      this.app?.ticker?.stop?.();
    }
    else this.app?.ticker?.start?.();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.resizeToContainer);
    window.visualViewport?.removeEventListener("resize", this.resizeToContainer);
    this.model?.internalModel?.off?.("beforeMotionUpdate", this.handleMotionUpdate);
    this.model?.internalModel?.off?.("beforeModelUpdate", this.handleModelUpdate);
    this.app?.ticker?.remove(this.advanceModel);
    this.emotionController.reset();
    this.emotionMotionPlaying = false;
    this.switchToken = null;

    if (this.model) {
      this.app?.stage.removeChild?.(this.model);
      this.model.destroy?.();
      this.model = null;
    }
    this.app?.destroy(false);
    this.app = null;
  }

  private applyPresentation(presentation: WindowLive2DPresentation): void {
    if (!this.model) return;
    const cue = motionForWindowLive2D(presentation, this.modelId);
    const key = cue ? `${cue.group}|${cue.index}` : "hidden";
    if (key === this.lastMotionKey) return;

    this.lastMotionKey = key;
    if (!cue) return;
    void Promise.resolve(this.model.motion?.(cue.group, cue.index, 2)).catch(
      (error: unknown) => {
        console.warn("[WindowLive2D] presentation motion failed", {
          presentation,
          error,
        });
      },
    );
  }

  private playEmotionMotion(emotion: string | null, intensity: number, nowMs: number): void {
    const normalizedIntensity = clampLive2DEmotionIntensity(intensity);
    if (
      this.disposed
      || !this.model
      || this.invitePlaying
      || this.emotionMotionPlaying
      // 点击轮播 / 待机表演的动作有 3.5s 的占用窗口：轻点她脑袋会同时送进一个情绪，
      // 情绪动作如果不让位，"点击轮播不同动作"就会被立刻盖掉（表情不受影响，照常换）。
      || (this.performanceMotionUntilMs !== null && nowMs < this.performanceMotionUntilMs)
      || normalizedIntensity < EMOTION_MOTION_MIN_INTENSITY
    ) return;

    const cue = motionForWindowLive2DEmotion(emotion, this.modelId);
    if (!cue) return;
    const key = `${cue.group}|${cue.index}`;
    if (key === this.lastEmotionMotionKey && nowMs - this.lastEmotionMotionAt < 4_000) return;

    this.lastEmotionMotionKey = key;
    this.lastEmotionMotionAt = nowMs;
    this.emotionMotionPlaying = true;
    void Promise.resolve(this.startGagMotion(cue, nowMs))
      .catch((error: unknown) => console.warn("[WindowLive2D] emotion motion failed", error))
      .finally(() => {
        this.emotionMotionPlaying = false;
        this.lastMotionKey = "";
        // An invite can start while the emotion motion is finishing. Let the
        // invite completion own the next presentation restore instead of
        // allowing this late promise callback to interrupt it.
        if (!this.disposed && !this.invitePlaying && this.performanceMotionUntilMs === null) this.applyPresentation(this.presentation);
      });
  }

  private fitModel(): void {
    if (!this.model) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const modelWidth = this.model.internalModel?.originalWidth ?? 5_800;
    const modelHeight = this.model.internalModel?.originalHeight ?? 8_400;
    // Frame the character, not the canvas: Live2D canvases carry transparent
    // padding, so canvas-fraction math leaves the model floating off-centre with
    // a gap under its feet on every page.
    const box = this.contentBox ?? { top: 0, bottom: 1, left: 0, right: 1 };
    const boxWidth = Math.max(0.05, box.right - box.left) * modelWidth;
    const boxHeight = Math.max(0.05, box.bottom - box.top) * modelHeight;
    const face = this.faceBox;
    const boxCenterX = ((face ? (face.left + face.right) / 2 : (box.left + box.right) / 2)) * modelWidth;

    const formWindow = this.modelId === "fatfish" && this.bodyForm
      ? (this.framing === "bust" ? this.descriptor.bustWindows : this.descriptor.fullWindows)?.[this.bodyForm]
      : undefined;
    if (formWindow) {
      // 画布原点在中心，1 个模型单位等于画布宽度。窗口顶边贴容器顶边。
      const aspect = modelWidth / modelHeight;
      const top = 0.5 - formWindow.top * aspect;
      const bottom = 0.5 - formWindow.bottom * aspect;
      const visible = Math.max(0.02, bottom - top);
      const scale = (height * 0.98) / (visible * modelHeight);
      const center = modelWidth / 2 + formWindow.centerX * modelWidth;
      this.model.scale.set(scale);
      this.model.position.set(
        width / 2 + (modelWidth * scale) / 2 - center * scale,
        height * 0.02 - top * modelHeight * scale + (modelHeight * scale) / 2,
      );
      this.publishInkTop(0.02);
      return;
    }

    if (this.framing === "bust") {
      // Half-body framing: the top `bustHeightRatio` of the character
      // (head through hands) fills the container height. 按模型可覆盖比例，
      // 且可让容器宽也参与约束（内容盒过宽的模型不再水平裁切）。
      const bustRatio = this.descriptor.bustHeightRatio ?? WINDOW_LIVE2D_BUST_HEIGHT_RATIO;
      const heightScale = (height / (boxHeight * bustRatio)) * 0.98;
      const widthScale = (width * 0.98) / boxWidth;
      const widthConstrained = this.descriptor.bustFitWidth === true && widthScale < heightScale;
      const scale = widthConstrained ? widthScale : heightScale;
      this.model.scale.set(scale);
      if (widthConstrained) {
        // 宽度受限缩小时仍顶边对齐会在脚下留出一大段空档（2026-09-20 用户
        // 标注「角色下来」）：改按底边对齐，内容盒底贴容器底 98%，与全身
        // 取景的落地方式一致。`bustSinkRatio` 让这条底边继续往下沉，把头顶
        // 的空档留给控制列（2026-09-20 用户标注 whale「模型往下」）。
        const bottom = height * (0.98 + (this.descriptor.bustSinkRatio ?? 0));
        this.model.position.set(
          width / 2 + (modelWidth * scale) / 2 - boxCenterX * scale,
          bottom - box.bottom * modelHeight * scale + (modelHeight * scale) / 2,
        );
        this.publishInkTop(Math.max(0, (bottom - boxHeight * scale) / height));
        return;
      }
      this.model.position.set(
        width / 2 + (modelWidth * scale) / 2 - boxCenterX * scale,
        height * 0.02 - box.top * modelHeight * scale + (modelHeight * scale) / 2,
      );
      // 半身取景把内容盒顶边放在容器顶边之下 2%（见上面的 position）。
      this.publishInkTop(0.02);
      return;
    }

    // Full-body framing: the whole character fits, feet on the bottom edge.
    const scale = Math.min(width / boxWidth, height / boxHeight) * 0.98;
    this.model.scale.set(scale);
    this.model.position.set(
      width / 2 + (modelWidth * scale) / 2 - boxCenterX * scale,
      height * 0.98 - box.bottom * modelHeight * scale + (modelHeight * scale) / 2,
    );
    // 内容盒顶边 = (容器顶到脚底的距离) − 内容盒高度；按 min(宽比, 高比) 适配时，模型比
    // 容器瘦（宽比胜出）就会把头顶留在容器顶边之下——这段留白随缩放一起放大。
    this.publishInkTop(Math.max(0, (height * 0.98 - boxHeight * scale) / height));
  }

  /**
   * 把「角色**画出来的**顶边」按容器高度的分数写进容器（`--companion-model-ink-top`）。
   *
   * 气泡要悬在「她头顶之上 40px」，而容器顶边常常不是发际线：full 取景按
   * `min(宽比, 高比)` 适配，模型比容器瘦时头顶之下留白；用户把伴星放大（或相机变焦）时
   * 这段留白等比放大——只按容器顶定位的气泡就越飘越高，2026-09-20 用户截图："离的越来越
   * 远了"。分数而不是像素：容器被外层 gsap 缩放时，分数不变、像素会变。
   */
  private publishInkTop(ratio: number): void {
    const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    this.container.style.setProperty("--companion-model-ink-top", safe.toFixed(4));
  }

  private publishLayoutBounds(): void {
    const model = this.model;
    const internal = model?.internalModel;
    const core = internal?.coreModel;
    const count = core?.getDrawableCount?.() ?? 0;
    if (!model || !internal?.getDrawableBounds || !count) return;
    if (!this.layoutDrawables) {
      const boxes: Live2DDrawableBox[] = [];
      const headBoxes: Live2DDrawableBox[] = [];
      const headIndices = live2DHeadDrawableIndices(core?.getModel?.(), this.descriptor.layoutHeadParts ?? []);
      for (let index = 0; index < count; index += 1) {
        if ((core?.getDrawableOpacity?.(index) ?? 1) < .02
          || core?.getDrawableDynamicFlagIsVisible?.(index) === false) continue;
        const box = internal.getDrawableBounds(index);
        if (box.width > 0 && box.height > 0 && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
          const fixedBox = { x: box.x, y: box.y, width: box.width, height: box.height };
          boxes.push(fixedBox);
          if (headIndices.has(index)) headBoxes.push(fixedBox);
        }
      }
      if (!boxes.length) return;
      this.layoutDrawables = boxes;
      this.layoutHeadDrawables = headBoxes;
    }
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    // Resize/framing reprojects the original shape, even if the character is
    // currently nodding, waving or wearing a temporary animated prop.
    const projection = {
      width: internal.originalWidth ?? 5_800, height: internal.originalHeight ?? 8_400,
      scale: model.scale.x, x: model.position.x, y: model.position.y,
    };
    for (const [region, boxes] of [["ink", this.layoutDrawables], ["head", this.layoutHeadDrawables]] as const) {
      const visible = projectVisibleLive2DBounds(boxes ?? [], projection, { width, height });
      if (!visible) continue;
      for (const edge of ["left", "right", "top", "bottom"] as const) {
        const extent = edge === "left" || edge === "right" ? width : height;
        // Outward rounding preserves a small, fixed clearance around the shape.
        const round = edge === "left" || edge === "top" ? Math.floor : Math.ceil;
        const ratio = Math.max(0, Math.min(1, round(visible[edge] / 2) * 2 / extent)).toFixed(4);
        const key = `--companion-model-${region}-${edge}`;
        if (this.container.style.getPropertyValue(key) !== ratio) this.container.style.setProperty(key, ratio);
      }
    }
  }

  /**
   * Measures the real content box from the model's drawables. Cubism canvases
   * reserve generous transparent margins; without this the framing maths works
   * on empty space and every page shows a small, floating character.
   */
  private measureContentBox(): void {
    this.contentBox = null;
    this.faceBox = null;
    const internal = this.model?.internalModel;
    const count = internal?.coreModel?.getDrawableCount?.();
    if (!internal?.getDrawableBounds || typeof count !== "number" || count <= 0) return;

    const out: Live2DDrawableBounds = { x: 0, y: 0, width: 0, height: 0 };
    const core = internal.coreModel;
    const faceIndices = live2DHeadDrawableIndices(core?.getModel?.(), this.descriptor.layoutFaceParts ?? []);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let faceMinX = Number.POSITIVE_INFINITY;
    let faceMinY = Number.POSITIVE_INFINITY;
    let faceMaxX = Number.NEGATIVE_INFINITY;
    let faceMaxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      if ((core?.getDrawableOpacity?.(index) ?? 1) < 0.02) continue;
      if (core?.getDrawableDynamicFlagIsVisible?.(index) === false) continue;
      let bounds: Live2DDrawableBounds | undefined;
      try {
        bounds = internal.getDrawableBounds(index, out);
      } catch {
        bounds = undefined;
      }
      if (!bounds
        || !Number.isFinite(bounds.x)
        || !Number.isFinite(bounds.y)
        || !(bounds.width > 0)
        || !(bounds.height > 0)) continue;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
      if (faceIndices.has(index)) {
        faceMinX = Math.min(faceMinX, bounds.x);
        faceMinY = Math.min(faceMinY, bounds.y);
        faceMaxX = Math.max(faceMaxX, bounds.x + bounds.width);
        faceMaxY = Math.max(faceMaxY, bounds.y + bounds.height);
      }
    }

    const modelWidth = internal.originalWidth ?? 0;
    const modelHeight = internal.originalHeight ?? 0;
    if (!(minX < maxX) || !(minY < maxY) || !(modelWidth > 0) || !(modelHeight > 0)) return;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    // Cubism drawable space is y-up, so the canvas top is the largest y.
    this.contentBox = {
      left: clamp01(minX / modelWidth),
      right: clamp01(maxX / modelWidth),
      top: clamp01(1 - maxY / modelHeight),
      bottom: clamp01(1 - minY / modelHeight),
    };
    if (faceMinX < faceMaxX && faceMinY < faceMaxY) {
      this.faceBox = {
        left: clamp01(faceMinX / modelWidth),
        right: clamp01(faceMaxX / modelWidth),
        top: clamp01(1 - faceMaxY / modelHeight),
        bottom: clamp01(1 - faceMinY / modelHeight),
      };
    }
  }

  private renderCurrentFrame(): void {
    if (!this.app) return;
    try {
      this.app.renderer?.render(this.app.stage);
      this.publishLayoutBounds();
    } catch (error) {
      console.warn("[WindowLive2D] static frame render failed", error);
    }
  }
}
