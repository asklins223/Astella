/**
 * 产物隔离展示面的**宿主那一侧**（39d W4-1 第二段的前半；D4 §6/§7.2）。
 *
 * 主进程侧（artifact-surface.ts／artifact-template.ts／主 CSP 的 frame-src）已经
 * 保证：产物文档跑在 `ailearn-app://artifact` 这个不透明 origin 上、只有
 * `allow-scripts` 一个能力、CSP 三路分流、子 frame 导航有闸。这一组件负责的是
 * 合同里明确留给宿主的另一半（`shared/artifact-frame.ts:96-99` 的原话：父侧判据
 * **不**检查 source——"宿主那一侧必须另做 event.source === frame.contentWindow；
 * 两者是'且'的关系，缺一不可"），以及 frame 没按时来心跳时的那两条降级路径：
 *
 *  - **心跳消失**（frame 卡死在 `while(true)` 或渲染进程崩溃，两者在宿主侧的
 *    可见信号相同：heartbeat 停了）→ 重建 frame 一次；第二次仍无心跳 ⇒ 降级：
 *    摘掉 iframe、如实说明"这份动态内容没能跑起来"（D4 §6：重建 frame；
 *    连续两次即降级，不再自动重试）。主页面不跟着卡——卡死循环死在 frame 自己
 *    的进程里，摘掉 iframe 它就没了。
 *  - **frame 自报 error**（artifact 脚本抛错）→ 不摘 frame（心跳可能还在、
 *    内容可能仍可用），把 detail 如实亮出来（模板侧已截到 500 字符）。
 *
 * 降级时的等价内容：`fallback` 由**调用方**给（W4-6 的教学流拿得到文字等价与
 * 分镜数据）；本组件没有就只说话，不编造一份假的分镜。
 *
 * 真窗口的 T6 两条探针（`while(true)` 产物、崩溃注入×2）要这个组件真被教学面
 * 挂载之后才跑得了——挂载点随 W4-6，本组件先以 jsdom 用例钉住状态机与判据。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import {
  ARTIFACT_FRAME_SANDBOX,
  ARTIFACT_FRAME_TARGET_ORIGIN,
  artifactFrameMotionMessage,
  artifactFrameUrl,
  isArtifactId,
  parseArtifactFrameEvent,
  type ArtifactFrameEvent,
} from "../../../../../shared/artifact-frame";

/**
 * 心跳看门的预算。模板的 heartbeat 是 1000ms 一拍（artifact-template.ts:120），
 * 这里给 4 拍的宽限——预算的"20 秒 CPU 墙"是另一件事（D4 §9：W4-1 核定、
 * §18.4 试用前冻结），不在这个值里。
 */
const HEARTBEAT_WATCHDOG_MS = 4_000;
/** 重建次数上限：第 2 次心跳消失即降级（D4 §6「连续两次即降级为静态分镜」）。 */
const MAX_FRAME_ATTEMPTS = 2;

/**
 * 产物高度的**下限与上限**。
 *
 * 下限：一份讲解再短也有一屏标题加一行读数，低于这个数说明量到的是还没排完的半张，
 * 照着它定高会得到一个空框。
 * 长内容按实际高度铺进页面的滚区；超过资源预算时改读文字等价，不再嵌套滚区。
 */
const ARTIFACT_MIN_HEIGHT_PX = 180;
const ARTIFACT_MAX_HEIGHT_PX = 100_000;

/** 高度抖动吸收：小于这个差值不重排，避免心跳每拍都改一次 style。 */
const ARTIFACT_HEIGHT_EPSILON_PX = 1;

type HostPhase =
  | { kind: "waiting" }
  | { kind: "live"; stepCount: number | null }
  | { kind: "error"; detail: string }
  | { kind: "degraded" };

function scrollReadingPage(frame: HTMLIFrameElement | null, event: ArtifactFrameEvent): void {
  for (let owner = frame?.parentElement; owner; owner = owner.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(owner).overflowY) || owner.scrollHeight <= owner.clientHeight) continue;
    const scale = event.scrollDeltaMode === 1 ? 16 : event.scrollDeltaMode === 2 ? owner.clientHeight : 1;
    const bounded = (delta: number | undefined) => Math.max(-1_000, Math.min(1_000, (delta ?? 0) * scale));
    owner.scrollBy({ top: bounded(event.scrollDeltaY), left: bounded(event.scrollDeltaX), behavior: "auto" });
    return;
  }
}

export interface ArtifactFrameHostProps {
  /** 产物 id（uuid；协议 handler 只认 uuid，非法 id 在这里就地说明而不是 404）。 */
  readonly artifactId: string;
  /**
   * 动效档位。给了就在 frame 进入 live 之后发 `motion` 指令，**并且在这一档改变时
   * 再发一次**（`reduced` 让模板铺静态分镜、关掉自动播放）；不给则由 frame 自己的
   * `prefers-reduced-motion` 决定。
   */
  readonly motion?: "full" | "reduced";
  /** 降级时的等价内容（文字等价／静态分镜）。由调用方提供；没有就只如实说明。 */
  readonly fallback?: ReactNode;
  /** 页面已在 frame 外呈现标题、原文和文字说明时，仅展示模型设计的画面。 */
  readonly contentOnly?: boolean;
  /**
   * 测试接缝：判定一个 message 事件的 source 是不是本 frame。
   * 生产默认 `source === iframe.contentWindow`（jsdom 里 contentWindow 是 null，
   * 用例经这个接缝喂假 source；真窗口的 T6 探针验的就是这条默认实现）。
   */
  readonly isTrustedFrameSource?: (source: MessageEventSource | null) => boolean;
  /** 测试接缝：心跳看门预算（生产默认 4 拍）。 */
  readonly watchdogMs?: number;
}

export function ArtifactFrameHost({
  artifactId,
  motion,
  fallback,
  contentOnly = false,
  isTrustedFrameSource,
  watchdogMs = HEARTBEAT_WATCHDOG_MS,
}: ArtifactFrameHostProps) {
  const [phase, setPhase] = useState<HostPhase>({ kind: "waiting" });
  /** 第几次加载（iframe 用它当 key：重建 = 换一个全新的 frame）。 */
  const [attempt, setAttempt] = useState(1);
  /**
   * 产物报上来的内容高度（已夹在 [MIN, MAX] 内）。
   * `null` = 还没量到 ⇒ 宿主给一个**保守的起始高度**，而不是塌成 iframe 的默认 150px。
   * 父侧量不到 frame 内容（同源策略），这是唯一的信息来源——不给它，内容就会被
   * 压进一小格、frame 内部自己出滚动条。
   */
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastBeatRef = useRef<number>(Date.now());
  /** 最新相位与动作，让 message 监听器只绑一次（D5 的判据：监听器不是状态）。 */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  if (!isArtifactId(artifactId)) {
    return (
      <div className="artifact-frame-host artifact-frame-host--degraded" role="note">
        <p className="artifact-frame-host__notice">这份动态内容的引用不合法，没有加载。请回到学习页重新打开。</p>
      </div>
    );
  }

  const trustedSource = isTrustedFrameSource
    ?? ((source: MessageEventSource | null) =>
      source !== null && iframeRef.current !== null && source === iframeRef.current.contentWindow);

  const handleFrameEvent = (event: ArtifactFrameEvent) => {
    if (event.phase === "scroll") {
      scrollReadingPage(iframeRef.current, event);
      return;
    }
    lastBeatRef.current = Date.now();
    // 高度先于阶段处理：任何一条消息（ready／heartbeat）都可能带新的高度，
    // 而静态分镜切换会在 ready **之后**重排 root——只认 ready 会停在旧高度上。
    if (typeof event.contentHeight === "number") {
      if (event.contentHeight > ARTIFACT_MAX_HEIGHT_PX) {
        setPhase({ kind: "degraded" });
        return;
      }
      const clamped = Math.min(
        ARTIFACT_MAX_HEIGHT_PX,
        Math.max(ARTIFACT_MIN_HEIGHT_PX, event.contentHeight),
      );
      setContentHeight((previous) =>
        previous !== null && Math.abs(previous - clamped) < ARTIFACT_HEIGHT_EPSILON_PX
          ? previous
          : clamped,
      );
    }
    if (event.phase === "ready") {
      setPhase({ kind: "live", stepCount: event.stepCount ?? null });
      return;
    }
    if (event.phase === "error") {
      setPhase({ kind: "error", detail: event.detail ?? "产物没有说明失败原因" });
    }
    // heartbeat：只刷新 lastBeat（上面第一行），状态不变。
  };

  const handleEventRef = useRef(handleFrameEvent);
  handleEventRef.current = handleFrameEvent;

  const trustedSourceRef = useRef(trustedSource);
  trustedSourceRef.current = trustedSource;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!trustedSourceRef.current(event.source)) return;
      const frameEvent = parseArtifactFrameEvent(event.data);
      if (!frameEvent) return;
      handleEventRef.current(frameEvent);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 心跳看门：只在没降级时值守。心跳消失 ⇒ 摘掉重挂一次；第二次 ⇒ 降级。
  useEffect(() => {
    if (phase.kind === "degraded") return;
    // Electron may suspend a hidden window's frame timers. A visibility change
    // starts a fresh heartbeat allowance instead of treating that pause as a crash.
    const resetHeartbeatAllowance = () => { lastBeatRef.current = Date.now(); };
    document.addEventListener("visibilitychange", resetHeartbeatAllowance);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastBeatRef.current <= watchdogMs) return;
      lastBeatRef.current = Date.now();
      if (attempt >= MAX_FRAME_ATTEMPTS) {
        setPhase({ kind: "degraded" });
        return;
      }
      // 重建：key 换掉 ⇒ 旧 frame 连同卡死其中的脚本一起销毁，新 frame 重走 ready。
      // 高度一并清掉：新产物的高度与旧产物无关，留在旧值上就是拿旧画面撑新画面。
      setAttempt((n) => n + 1);
      setContentHeight(null);
      setPhase({ kind: "waiting" });
    }, 500);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resetHeartbeatAllowance);
    };
  }, [phase.kind, attempt, watchdogMs]);

  /**
   * 动效档位是**随时可切**的（书房里那颗"完整／轻量／关闭"按钮），而 frame 收指令
   * 的地方原先只有 ready 那一处——切档之后打开的演示是对的，**已经开着的**那份
   * 却停在旧档上：2026-10-06 窗口实测，切到"关闭动效"后 frame 的
   * `data-artifact-motion` 仍是 `full`、自动播放照跑。放在 effect 里也顺带覆盖
   * 重建那条路（重建 = waiting → ready → live），新 frame 会再收到一次当前档位。
   */
  useEffect(() => {
    if (!motion || phase.kind !== "live") return;
    // targetOrigin 只能是 '*'：frame 是不透明 origin（`allow-scripts`，没有
    // `allow-same-origin`），具名 origin 的消息会被浏览器静默丢掉。理由与实测见
    // `ARTIFACT_FRAME_TARGET_ORIGIN`。
    iframeRef.current?.contentWindow?.postMessage(
      artifactFrameMotionMessage(motion),
      ARTIFACT_FRAME_TARGET_ORIGIN,
    );
  }, [motion, phase.kind]);

  if (phase.kind === "degraded") {
    return (
      <div className="artifact-frame-host artifact-frame-host--degraded" role="note">
        <p className="artifact-frame-host__notice">{contentOnly ? "动态画面暂时无法运行，可继续阅读下方的说明。" : "这份动态内容没能跑起来，已停止等待。文字等价与分镜如下（若有）。"}</p>
        {fallback}
      </div>
    );
  }

  // 还没量到高度时给一个中位起始值：太矮会闪一下空框，太高会留一截空白，
  // 而这份产物最常见的高度本来就在这个量级。
  const frameHeight = contentHeight === null ? 420 : contentHeight + 2;

  return (
    <figure
      className="artifact-frame-host"
      data-phase={phase.kind}
      aria-busy={phase.kind === "waiting"}
      aria-label="动态教学演示"
    >
      <div className="artifact-frame-host__stage">
        <iframe
          key={attempt}
          ref={iframeRef}
          src={`${artifactFrameUrl(artifactId)}${contentOnly ? "#content" : ""}`}
          sandbox={ARTIFACT_FRAME_SANDBOX}
          title="动态教学演示"
          className="artifact-frame-host__frame"
          style={{ height: `${frameHeight}px` }}
        />
        {phase.kind === "waiting" ? (
          <p className="artifact-frame-host__overlay">
            <LoaderCircle className="artifact-frame-host__spinner" size={16} aria-hidden="true" />
            正在准备动态内容…
          </p>
        ) : null}
      </div>
      {phase.kind === "error" ? (
        <figcaption className="artifact-frame-host__caption artifact-frame-host__caption--error" role="note">
          这份动态内容报告了错误，仍可尝试阅读：{phase.detail}
        </figcaption>
      ) : null}
      {!contentOnly && phase.kind === "live" && phase.stepCount !== null && phase.stepCount > 0 ? (
        // 「共 N 步」是上一版的说法——那一版的产物是自己的一排格，按顺序推一遍。
        // 现在画面是模型为这一个知识点写的页面，N 是它讲的**要点**条数
        // （服务端渲染出来的文字等价，frame 之外、永远在屏上），所以这一行说的是
        // "这一页讲了几件事"，而不是"你要点几下才走得完"。
        <figcaption className="artifact-frame-host__caption">这一页讲了 {phase.stepCount} 个要点</figcaption>
      ) : null}
    </figure>
  );
}
