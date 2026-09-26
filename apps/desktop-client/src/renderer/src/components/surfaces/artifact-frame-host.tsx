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
import {
  ARTIFACT_FRAME_ORIGIN,
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameMotionMessage,
  artifactFrameUrl,
  isArtifactId,
  parseArtifactFrameEvent,
  type ArtifactFrameEvent,
} from "../../../../shared/artifact-frame";

/**
 * 心跳看门的预算。模板的 heartbeat 是 1000ms 一拍（artifact-template.ts:120），
 * 这里给 4 拍的宽限——预算的"20 秒 CPU 墙"是另一件事（D4 §9：W4-1 核定、
 * §18.4 试用前冻结），不在这个值里。
 */
const HEARTBEAT_WATCHDOG_MS = 4_000;
/** 重建次数上限：第 2 次心跳消失即降级（D4 §6「连续两次即降级为静态分镜」）。 */
const MAX_FRAME_ATTEMPTS = 2;

type HostPhase =
  | { kind: "waiting" }
  | { kind: "live"; stepCount: number | null }
  | { kind: "error"; detail: string }
  | { kind: "degraded" };

export interface ArtifactFrameHostProps {
  /** 产物 id（uuid；协议 handler 只认 uuid，非法 id 在这里就地说明而不是 404）。 */
  readonly artifactId: string;
  /**
   * 动效档位。给了就在 ready 之后把 `motion` 指令发给 frame（`reduced` 让模板
   * 铺静态分镜）；不给则由 frame 自己的 `prefers-reduced-motion` 决定。
   */
  readonly motion?: "full" | "reduced";
  /** 降级时的等价内容（文字等价／静态分镜）。由调用方提供；没有就只如实说明。 */
  readonly fallback?: ReactNode;
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
  isTrustedFrameSource,
  watchdogMs = HEARTBEAT_WATCHDOG_MS,
}: ArtifactFrameHostProps) {
  const [phase, setPhase] = useState<HostPhase>({ kind: "waiting" });
  /** 第几次加载（iframe 用它当 key：重建 = 换一个全新的 frame）。 */
  const [attempt, setAttempt] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastBeatRef = useRef<number>(Date.now());
  /** 最新相位与动作，让 message 监听器只绑一次（D5 的判据：监听器不是状态）。 */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  if (!isArtifactId(artifactId)) {
    return (
      <div className="artifact-frame-host__notice" role="note">
        这份动态内容的引用不合法，没有加载。请回到学习页重新打开。
      </div>
    );
  }

  const trustedSource = isTrustedFrameSource
    ?? ((source: MessageEventSource | null) =>
      source !== null && iframeRef.current !== null && source === iframeRef.current.contentWindow);

  const handleFrameEvent = (event: ArtifactFrameEvent) => {
    lastBeatRef.current = Date.now();
    if (event.phase === "ready") {
      setPhase({ kind: "live", stepCount: event.stepCount ?? null });
      if (motion) {
        // targetOrigin 必须是产物 origin：消息只能落到这个 origin 的 frame 里。
        iframeRef.current?.contentWindow?.postMessage(
          artifactFrameMotionMessage(motion),
          ARTIFACT_FRAME_ORIGIN,
        );
      }
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
    const timer = window.setInterval(() => {
      if (Date.now() - lastBeatRef.current <= watchdogMs) return;
      lastBeatRef.current = Date.now();
      if (attempt >= MAX_FRAME_ATTEMPTS) {
        setPhase({ kind: "degraded" });
        return;
      }
      // 重建：key 换掉 ⇒ 旧 frame 连同卡死其中的脚本一起销毁，新 frame 重走 ready。
      setAttempt((n) => n + 1);
      setPhase({ kind: "waiting" });
    }, 500);
    return () => window.clearInterval(timer);
  }, [phase.kind, attempt, watchdogMs]);

  if (phase.kind === "degraded") {
    return (
      <div className="artifact-frame-host artifact-frame-host--degraded" role="note">
        <p>这份动态内容没能跑起来，已停止等待。文字等价与分镜如下（若有）。</p>
        {fallback}
      </div>
    );
  }

  return (
    <figure
      className="artifact-frame-host"
      aria-busy={phase.kind === "waiting"}
      aria-label="动态教学演示"
    >
      <iframe
        key={attempt}
        ref={iframeRef}
        src={artifactFrameUrl(artifactId)}
        sandbox={ARTIFACT_FRAME_SANDBOX}
        title="动态教学演示"
        className="artifact-frame-host__frame"
      />
      {phase.kind === "waiting" && <figcaption>正在准备动态内容…</figcaption>}
      {phase.kind === "error" && (
        <figcaption role="note">
          这份动态内容报告了错误，仍可尝试阅读：{phase.detail}
        </figcaption>
      )}
      {phase.kind === "live" && phase.stepCount !== null && (
        <figcaption>{`共 ${phase.stepCount} 步`}</figcaption>
      )}
    </figure>
  );
}
