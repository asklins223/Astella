import { AuthLampControl, type LampTransitionDirection } from "./AuthLampControl";
import { acceptVerifiedSpaceArrival, clearSpaceArrival } from "./hud/space-arrival";
// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { useGSAP } from "@gsap/react";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Hash,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  LogIn,
  LogOut,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Ticket,
  UserRound,
  UserPlus,
} from "lucide-react";
import type {
  AstellaDesktopApiM2,
  RuntimeSnapshotV1,
  WorkspaceSummaryV1,
} from "@astella/shared/desktop-ipc-contracts";
import {
  decideBootstrapGatewayFailure,
  decideRuntimeGate,
  decideSessionGate,
  gateErrorPolicy,
  inspectDesktopContract,
  type AuthenticatedDesktopSession,
  type ReadyDesktopSession,
  type ReauthenticationDesktopSession,
} from "../app/desktop-gate";
import {
  createRequestMeta,
  RendererGatewayError,
  setCurrentWorkspaceEpoch,
  unwrapGatewayResult,
} from "../app/desktop-client";
import {
  clearAccountSignOutNotice,
  peekAccountSignOutNotice,
  signOutCurrentAccount,
} from "../app/account-signout";
import {
  subscribeGateInvalidation,
  type GateInvalidationCode,
} from "../app/gate-invalidation";
import {
  establishRequiredRuntimeSubscription,
  type RequiredRuntimeSubscription,
} from "../app/runtime-gate-subscription";
import { mediaAssetUrl, useLearningRoomManifest } from "../media/learning-room-manifest";
import { sceneMotionDuration, type SceneMotionMode } from "../scene/scene-motion";
import { useRoomStore } from "../app/room-store";
import { setAuthenticatedSurfaceSession } from "../app/surface-session";
import { HudFirstSpaceScene } from "./hud/HudFirstSpace";
import { requestSpaceMenuRefresh } from "./hud/space-menu-events";
/**
 * 登录页那张氛围画布是**整个渲染层里唯一还在活的 pixi.js 引用**（`scene/*-pixi*` 那条链
 * 已经没有人 import 了，只剩自己的测试）。它以前静态引入，于是 pixi 的全部运行时被拖进
 * 首屏那一个 eager chunk 里解析——而这块画布只是好看，不参与任何交互与判据。
 * 改成 lazy 之后 pixi 离开首包；`fallback={null}` 是刻意的：画布晚到一帧只是没有背景，
 * 不该在登录界面上闪一块占位。类型仍然静态引入（type-only，编译期就擦掉，不产生运行时边）。
 */
const AuthAmbientCanvas = lazy(() =>
  import("./AuthAmbientCanvas").then((module) => ({ default: module.AuthAmbientCanvas })),
);
import type { AuthAmbientLampCue } from "./AuthAmbientCanvas";
import { MIN_PASSWORD_LENGTH, validateAuthForm, validateEmailCode, validateEmailFormat, validateResetForm } from "./auth-form-validation";
import { GateUpdateRow } from "./gate-update-row";
import {
  formatAuthSceneClock,
  resolveAuthScene,
  resolveAuthSceneFromDate,
  type AuthScenePreference,
  type AuthSceneTime,
} from "./auth-scene-time";

gsap.registerPlugin(useGSAP, CustomEase);

const gateSurfaceEase = CustomEase.create("astella-gate-surface", "0.16,1,0.3,1");

type RetryAction = "bootstrap" | "connect" | "reload" | null;

type BlockedView = {
  phase: "blocked";
  title: string;
  detail: string;
  retryAction: RetryAction;
  retryAfter?: string;
};

type GateView =
  | { phase: "loading"; title: string; detail: string; stage?: string }
  | BlockedView
  | { phase: "auth"; mode: "login" | "register" | "reset"; serviceNotice?: string }
  | { phase: "reauth"; session: ReauthenticationDesktopSession | ReadyDesktopSession | null }
  | {
      phase: "workspace";
      session: AuthenticatedDesktopSession;
      workspaces: WorkspaceSummaryV1[];
    }
  | {
      phase: "ready";
      runtime: RuntimeSnapshotV1;
      session: ReadyDesktopSession;
    };

const initialView: GateView = {
  phase: "loading",
  title: "正在准备应用",
  detail: "请稍候，我们正在检查连接和登录状态。",
  stage: "正在启动本地组件",
};

/** Short, concrete labels for the spinner row of each start-up step. */
const GATE_STAGES = {
  refresh: "正在同步最新状态",
  reconnect: "正在重新连接学习服务",
  connect: "正在建立安全连接",
  trust: "正在验证本机服务身份",
  restoring: "正在校验已保存的登录凭据",
  checking: "正在向学习服务确认会话",
  resume: "正在恢复上次登录",
  switchWorkspace: "正在切换当前空间",
  loadWorkspaces: "正在读取可用的学习空间",
} as const;

/**
 * 一趟 bootstrap 的最长等待。超过它还没结论，spinner 就必须换成能点的重试：
 * 无限转圈看起来像"还在努力"，实际是把唯一的出路也藏了起来（F01 验收要求）。
 */
const BOOTSTRAP_DEADLINE_MS = 12_000;

function desktopApi(): AstellaDesktopApiM2 | null {
  const value = (window as unknown as { astella?: AstellaDesktopApiM2 }).astella;
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.runtime?.getSnapshot !== "function"
    || typeof value.runtime?.retryApiConnection !== "function"
    || typeof value.auth?.getState !== "function"
    || typeof value.auth?.login !== "function"
    || typeof value.auth?.register !== "function"
    || typeof value.auth?.reauthenticate !== "function"
    || typeof value.workspace?.list !== "function"
    || typeof value.workspace?.switch !== "function"
    || typeof value.subscriptions?.subscribe !== "function"
    || typeof value.subscriptions?.onEvent !== "function"
    || typeof value.subscriptions?.unsubscribe !== "function"
  ) return null;
  return value;
}

function blockedFromError(error: unknown, title: string): BlockedView {
  const policy = gateErrorPolicy(error, title);
  const reconnect = error instanceof RendererGatewayError
    && (error.code === "api_unavailable" || error.code === "network_timeout");
  const retryAction = policy.retry === "safe_retry"
    ? reconnect ? "connect" : "bootstrap"
    : policy.retry === "resync_first"
      ? "bootstrap"
      : null;
  return {
    phase: "blocked",
    title: policy.title,
    detail: policy.detail,
    retryAction,
    ...(policy.retryAfter ? { retryAfter: policy.retryAfter } : {}),
  };
}

function isConfigurationBoundary(connection: RuntimeSnapshotV1["apiConnection"]): boolean {
  return connection.kind === "not_configured" || connection.kind === "configuration_error";
}

function retryTimeLabel(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return null;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Room lighting the gate renders against; owned by the gate itself. */
type GateTheme = "day" | "night";
type GateBackdropUrls = Record<GateTheme, string | null> & { dusk: string | null };

function GateFrame({
  title,
  detail,
  tone = "default",
  variant = "default",
  motionMode = "off",
  requestedScene,
  scenePreference,
  systemScene,
  systemTimeLabel,
  onScenePreferenceChange,
  backdropUrls,
  corner,
  children,
}: {
  title: string;
  detail: string;
  tone?: "default" | "danger";
  variant?: "default" | "register";
  motionMode?: SceneMotionMode;
  requestedScene: AuthSceneTime;
  scenePreference: AuthScenePreference;
  systemScene: AuthSceneTime;
  systemTimeLabel: string;
  onScenePreferenceChange: (preference: AuthScenePreference) => void;
  backdropUrls: GateBackdropUrls;
  /**
   * 钉在窗口上的那一类控件（版本与更新）。必须挂在 `<main>` 这一层而不是
   * `{children}` 那一层：`.desktop-access-gate__panel` 入场时被 GSAP 打了
   * `transform`，而带 transform 的祖先会接管 `position: fixed` 的 containing
   * block——挂在 panel 里的右上角控件会在动效那几百毫秒里贴到面板边上，
   * `clearProps` 撤掉 transform 后再弹回窗口角，登录↔注册每切一次都跳一下。
   */
  corner?: ReactNode;
  children?: ReactNode;
}) {
  const frameRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lampCueIdRef = useRef(0);
  const [lampCue, setLampCue] = useState<AuthAmbientLampCue | null>(null);
  const [visibleScene, setVisibleScene] = useState<AuthSceneTime>(requestedScene);
  // The posters share one room composition, but dusk has its own mid-value
  // background.  Keeping it as a distinct visual theme lets form contrast,
  // focus treatment, and ambient particles adapt instead of borrowing the
  // brighter day palette.
  const visualTheme: AuthSceneTime = visibleScene;
  const style = {
    ...(backdropUrls.day ? { "--desktop-gate-backdrop-day": `url("${backdropUrls.day}")` } : {}),
    ...(backdropUrls.dusk ? { "--desktop-gate-backdrop-dusk": `url("${backdropUrls.dusk}")` } : {}),
    ...(backdropUrls.night ? { "--desktop-gate-backdrop-night": `url("${backdropUrls.night}")` } : {}),
  } as CSSProperties;

  const handleLampCue = useCallback((direction: LampTransitionDirection) => {
    lampCueIdRef.current += 1;
    setLampCue({ id: lampCueIdRef.current, direction });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [title]);

  useGSAP(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const panel = frame.querySelector<HTMLElement>(".desktop-access-gate__panel");
    if (!panel) return undefined;

    const brand = panel.querySelector<HTMLElement>(".desktop-access-gate__brand");
    const heading = panel.querySelector<HTMLElement>(".desktop-access-gate__heading");
    const fields = [...frame.querySelectorAll<HTMLElement>(".desktop-access-gate__fields > label")];
    const form = panel.querySelector<HTMLElement>(".desktop-access-gate__form");
    const formSupport = form
      ? [...form.children].filter((element) => !element.matches(".desktop-access-gate__fields")) as HTMLElement[]
      : [];
    const directContent = [...panel.children]
      .filter((element) => !element.matches(".desktop-access-gate__brand, .desktop-access-gate__heading, .desktop-access-gate__form")) as HTMLElement[];
    const supportingNodes = [...formSupport, ...directContent];
    const animatedNodes = [brand, heading, ...fields, ...supportingNodes].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const compact = window.matchMedia("(max-width: 760px), (max-height: 620px)").matches;
    const effectiveMode = compact && motionMode === "full" ? "lite" : motionMode;
    const duration = sceneMotionDuration(effectiveMode, "surfaceEnter");
    const direction = variant === "register" ? 1 : -1;
    frame.dataset.gateMotionState = duration > 0 ? "running" : "settled";

    if (duration <= 0) {
      gsap.set([panel, ...animatedNodes], { clearProps: "transform,opacity,visibility,willChange" });
      return undefined;
    }

    // The entrance animates `opacity`, never `autoAlpha`: `autoAlpha` would set
    // `visibility: hidden`, and for the length of the stagger the inputs and the
    // submit button would drop out of the tab order and out of the accessibility
    // tree. They stay focusable and announced while they fade in.
    gsap.set(panel, { willChange: "transform,opacity" });
    gsap.set(animatedNodes, { opacity: 0, y: 7, willChange: "transform,opacity" });
    const timeline = gsap.timeline({
      defaults: { ease: gateSurfaceEase },
      onComplete: () => {
        frame.dataset.gateMotionState = "settled";
      },
    });
    timeline.fromTo(
      panel,
      {
        opacity: 0,
        x: direction * (effectiveMode === "lite" ? 7 : 12),
        scale: effectiveMode === "lite" ? 0.998 : 0.994,
      },
      {
        opacity: 1,
        x: 0,
        scale: 1,
        duration,
        clearProps: "transform,opacity,visibility,willChange",
      },
      0,
    );
    const reveal = (targets: HTMLElement[], startAt: number, revealDuration: number, stagger = 0) => {
      if (targets.length === 0) return;
      timeline.to(targets, {
        opacity: 1,
        y: 0,
        duration: revealDuration,
        stagger,
        clearProps: "transform,opacity,visibility,willChange",
      }, startAt);
    };
    reveal(brand ? [brand] : [], Math.min(duration * 0.08, 0.04), Math.min(duration * 0.5, 0.23));
    reveal(heading ? [heading] : [], Math.min(duration * 0.14, 0.065), Math.min(duration * 0.52, 0.24));
    reveal(fields, Math.min(duration * 0.2, 0.09), Math.min(duration * 0.5, 0.23), Math.min(duration * 0.03, 0.014));
    reveal(supportingNodes, Math.min(duration * 0.3, 0.14), Math.min(duration * 0.46, 0.21), Math.min(duration * 0.025, 0.012));

    return () => {
      timeline.kill();
      frame.dataset.gateMotionState = "settled";
    };
  }, {
    scope: frameRef,
    dependencies: [motionMode, title, variant],
    revertOnUpdate: true,
  });

  return (
    <main
      ref={frameRef}
      id="main-content"
      className="desktop-access-gate"
      data-tone={tone}
      data-gate-variant={variant}
      data-gate-scene={visibleScene}
      data-gate-visual-theme={visualTheme}
      data-gate-time-mode={scenePreference}
      data-gate-motion-mode={motionMode}
      data-gate-asset-source={backdropUrls.day && backdropUrls.night ? "manifest" : "fallback"}
      style={style}
    >
      <div className="desktop-access-gate__drag-region" aria-hidden="true" />
      <Suspense fallback={null}>
        <AuthAmbientCanvas theme={visualTheme} variant={variant} motionMode={motionMode} lampCue={lampCue} />
      </Suspense>
      <AuthLampControl
        scene={visibleScene}
        targetScene={requestedScene}
        preference={scenePreference}
        systemScene={systemScene}
        systemTimeLabel={systemTimeLabel}
        motionMode={motionMode}
        onSceneChange={setVisibleScene}
        onPreferenceChange={onScenePreferenceChange}
        onLampCue={handleLampCue}
      />
      <section className="desktop-access-gate__panel" aria-labelledby="desktop-gate-title" aria-describedby="desktop-gate-detail">
        <div className="desktop-access-gate__brand" aria-label="拾星笔记">
          <img
            className="desktop-access-gate__brand-mark"
            src="/assets/brand/astella-mark-v1.png"
            alt=""
            width={34}
            height={34}
          />
          <span className="desktop-access-gate__brand-name">拾星笔记</span>
          <span className="desktop-access-gate__brand-dot" aria-hidden="true" />
        </div>
        <div className="desktop-access-gate__heading">
          <h1 ref={headingRef} id="desktop-gate-title" tabIndex={-1}>{title}</h1>
          <p id="desktop-gate-detail">{detail}</p>
        </div>
        {children}
      </section>
      {corner}
    </main>
  );
}

export function DesktopAccessGate({
  children,
  onWorkspaceBoundaryReset,
  motionMode = "full",
}: {
  children: ReactNode;
  onWorkspaceBoundaryReset?: () => void;
  motionMode?: SceneMotionMode;
}) {
  const [view, setView] = useState<GateView>(initialView);
  useEffect(() => {
    if (view.phase !== "ready") setAuthenticatedSurfaceSession(null);
  }, [view.phase]);
  useEffect(() => () => setAuthenticatedSurfaceSession(null), []);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [formBusy, setFormBusy] = useState(false);
  /** 重认证那一屏的「退出并重新登录」在飞；与 formBusy 分开，因为两件事的按钮文案不同。 */
  const [signingOut, setSigningOut] = useState(false);
  const [formFailure, setFormFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  /** 只属于注册第一步：协作空间在账号创建时一起加入，登录侧不再收码。 */
  const [inviteToken, setInviteToken] = useState("");
  /** 邮箱验证码通道是否配置齐全（auth-surface manifest 端点的动态能力位）。 */
  const [emailChannelAvailable, setEmailChannelAvailable] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  /** 重发冷却剩余秒数（0 = 可以再发）。 */
  const [resendIn, setResendIn] = useState(0);
  /** 发码成功后的中性提示；formFailure 是红色告警，两者不混用。 */
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  /** 登录屏的「用验证码登录」开关。 */
  const [loginViaCode, setLoginViaCode] = useState(false);
  /** 注册的两步：先填基础信息，下一步才去邮箱取码（发码是自动的）。 */
  const [registerStep, setRegisterStep] = useState<"details" | "verify">("details");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [credentialPersistence, setCredentialPersistence] = useState<"local_file" | "memory">("memory");
  const [authSurfaceHelp, setAuthSurfaceHelp] = useState<string | null>(null);
  const [roomRevealed, setRoomRevealed] = useState(false);
  const [scenePreference, setScenePreference] = useState<AuthScenePreference>("system");
  const [systemNow, setSystemNow] = useState(() => new Date());
  const { manifest: roomManifest } = useLearningRoomManifest();
  const gateBackdropUrls: GateBackdropUrls = {
    day: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.day.path) : null,
    dusk: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.dusk.path) : null,
    night: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.night.path) : null,
  };
  const registerBackdropUrls: GateBackdropUrls = {
    day: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.day.path) : null,
    dusk: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.dusk.path) : null,
    night: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.night.path) : null,
  };
  const generationRef = useRef(0);
  const forceConnectionRef = useRef(false);
  /** 这一趟 bootstrap 是不是"静默复核"：视图已经是 ready，复核期间不换视图。 */
  const silentReverifyRef = useRef(false);
  /** 是否有一趟 bootstrap 在飞：同一个账号+空间+epoch 的复核靠它合并成一趟。 */
  const bootstrapFlightRef = useRef(false);
  const connectionFlightRef = useRef<Promise<unknown> | null>(null);
  const readyBoundaryRef = useRef<string | null>(null);
  /** 上一次发布给顶栏胶囊的空间身份；只在真的变了时写 store，避免每次 ready 都刷一遍订阅者。 */
  const spaceIdentityBoundaryRef = useRef<string | null>(null);
  const lastTrustedSessionRef = useRef<ReadyDesktopSession | null>(null);
  const settingsReturnRef = useRef<{
    userId: string;
    workspaceId: string;
    section: ReturnType<typeof useRoomStore.getState>["settingsSection"];
  } | null>(null);
  const viewPhaseRef = useRef<GateView["phase"]>(initialView.phase);
  const systemScene = resolveAuthSceneFromDate(systemNow);
  const requestedScene = resolveAuthScene(scenePreference, systemNow);
  const systemTimeLabel = formatAuthSceneClock(systemNow);
  const gateSceneProps = {
    requestedScene,
    scenePreference,
    systemScene,
    systemTimeLabel,
    onScenePreferenceChange: setScenePreference,
  };
  viewPhaseRef.current = view.phase;

  useEffect(() => {
    if (scenePreference !== "system") return undefined;
    const syncSystemTime = () => setSystemNow(new Date());
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 24;
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      syncSystemTime();
      interval = window.setInterval(syncSystemTime, 60_000);
    }, untilNextMinute);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [scenePreference]);

  useEffect(() => {
    if (view.phase !== "auth") return;
    const api = desktopApi();
    if (!api) return;
    let cancelled = false;
    void api.auth.getSurfaceManifest({ meta: createRequestMeta() }).then((response) => {
      if (cancelled || !response.ok) return;
      // 能力位与签名无关：testMode 只说 manifest 的签名来源，通道配没配是另一件事。
      setEmailChannelAvailable(response.data.emailChannelAvailable === true);
      if (response.data.testMode) return;
      const targetId = `${view.mode}:static_help`;
      const entry = response.data.manifest.surfaces.find((surface) => surface.surfaceId === targetId);
      setAuthSurfaceHelp(entry?.textContent || null);
    }).catch(() => {
      if (!cancelled) setAuthSurfaceHelp(null);
    });
    return () => { cancelled = true; };
  }, [view.phase, view.phase === "auth" ? view.mode : null]);

  // 重发倒计时：一秒一跳，到 0 放开「发送验证码」。
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const beginRoomReveal = useCallback(() => {
    // The gate owns a distinct window-side alcove, so entering the Room is a
    // short CSS reveal rather than a threshold animation through an unrelated
    // environment.
    setRoomRevealed(true);
  }, []);

  useEffect(() => {
    if (view.phase !== "ready" && roomRevealed) {
      setRoomRevealed(false);
    }
  }, [roomRevealed, view.phase]);

  const requestBootstrap = useCallback((forceConnection = false, reverify = false) => {
    // 静默复核只对"已经在跑的房间"成立；视图不是 ready 时，该走的还是门禁视图那条路。
    const silent = reverify && viewPhaseRef.current === "ready";
    // 同代合并：同一个账号+空间+epoch 只允许一趟复核在飞。伴星投递、可见性恢复、
    // 空间事件可能在同一瞬间各来一条，不合并就是各起一趟 bootstrap——每趟一条
    // /auth/me，而它们对当前边界说的是同一句话。
    if (silent && bootstrapFlightRef.current) return;
    generationRef.current += 1;
    forceConnectionRef.current = forceConnectionRef.current || forceConnection;
    silentReverifyRef.current = silent;
    setFormFailure(null);
    if (!silent) {
      setAuthenticatedSurfaceSession(null);
      setView({
        phase: "loading",
        title: forceConnection ? "正在重新连接" : "正在刷新状态",
        detail: "连接恢复后会自动继续。",
        stage: forceConnection ? GATE_STAGES.reconnect : GATE_STAGES.refresh,
      });
    }
    setRefreshRevision((revision) => revision + 1);
  }, []);

  const invalidateReadyGate = useCallback((code?: GateInvalidationCode) => {
    if (viewPhaseRef.current !== "ready") return;
    // 没有错误码的失效（runtime 的 snapshot_invalidated）先做一次静默复核：同一个
    // 账号+空间+epoch 复核通过时视图、房间视图状态与焦点都不动，真的换了边界才在
    // apply 里收口。以前这里无条件清空工作区并重建，于是任何一条运行时事件都能把
    // 用户正在看的页面推倒重来（F01）。
    // 一个业务 DTO 未通过校验，不能据此认定账号或工作区变化。
    // 静默复核整体合同与会话；失败仍进入门禁，成功保留页面的局部报错。
    if (code === undefined || code === "unsupported_contract") {
      requestBootstrap(false, true);
      return;
    }
    // 服务短暂离线没有证明身份或工作区改变。隐藏内容并复核，保留原任务落点；
    // 若复核真的换了边界，apply(ready) 仍会清空旧领域状态。
    if (code === "api_unavailable") {
      requestBootstrap(false);
      return;
    }
    const previous = lastTrustedSessionRef.current;
    const room = useRoomStore.getState();
    settingsReturnRef.current = code === "stale_workspace" && previous && room.surface === "settings"
      ? { userId: previous.user.userId, workspaceId: previous.workspace.workspaceId, section: room.settingsSection }
      : null;
    onWorkspaceBoundaryReset?.();
    readyBoundaryRef.current = null;
    if (["auth_required", "api_untrusted", "configuration_error", "unsupported_contract"].includes(code)) {
      lastTrustedSessionRef.current = null;
    }
    requestBootstrap(false);
  }, [onWorkspaceBoundaryReset, requestBootstrap]);

  useEffect(() => subscribeGateInvalidation((code) => invalidateReadyGate(code)), [invalidateReadyGate]);

  const connectOnce = useCallback(async (api: AstellaDesktopApiM2) => {
    if (!connectionFlightRef.current) {
      const flight = api.runtime
        .retryApiConnection({ meta: createRequestMeta() })
        .then((response) => unwrapGatewayResult(response));
      connectionFlightRef.current = flight;
      void flight.finally(() => {
        if (connectionFlightRef.current === flight) connectionFlightRef.current = null;
      }).catch(() => undefined);
    }
    return connectionFlightRef.current;
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let waitTimer: number | undefined;
    let runtimeSubscription: RequiredRuntimeSubscription | null = null;
    const silentReverify = silentReverifyRef.current;
    silentReverifyRef.current = false;
    bootstrapFlightRef.current = true;
    const isCurrent = () => generationRef.current === generation;
    const apply = (next: GateView) => {
      if (!isCurrent()) return;
      // 静默复核只报结论、不报过程：房间还在屏幕上，不该因为后台复核走到了哪一步
      // 就闪一次 spinner。
      if (silentReverify && next.phase === "loading" && viewPhaseRef.current === "ready") return;
      if (next.phase === "ready") {
        const nextBoundary = [
          next.session.user.userId,
          next.session.workspace.workspaceId,
          next.session.workspaceEpoch,
        ].join(":");
        const boundaryChanged = readyBoundaryRef.current !== null && readyBoundaryRef.current !== nextBoundary;
        const pendingSettings = settingsReturnRef.current;
        settingsReturnRef.current = null;
        const previous = lastTrustedSessionRef.current;
        const room = useRoomStore.getState();
        const settingsSection = pendingSettings?.userId === next.session.user.userId
          && pendingSettings.workspaceId === next.session.workspace.workspaceId
          ? pendingSettings.section
          : boundaryChanged && room.surface === "settings"
            && previous?.user.userId === next.session.user.userId
            && previous.workspace.workspaceId === next.session.workspace.workspaceId
            ? room.settingsSection : null;
        if (boundaryChanged) {
          // 同空间的改名或 AI 政策会推进权限纪元。旧请求仍要失效，但设置操作
          // 完成后应留在正在调整的分区，不能把用户赶回首页。
          onWorkspaceBoundaryReset?.();
        }
        if (settingsSection) {
          useRoomStore.getState().invoke("open-settings");
          useRoomStore.getState().setSettingsSection(settingsSection);
          useRoomStore.getState().setHudPage("settings", "returning");
        }
        readyBoundaryRef.current = nextBoundary;
        lastTrustedSessionRef.current = next.session;
        // 边界一旦确定就同步给 createRequestMeta 的兜底，漏传 epoch 的调用点因此
        // 不可能把请求打到别的空间上；登出后视图不再是 ready，这里保持最后一次的
        // 值，而主进程届时已把 activeWorkspaceEpoch 归零 → 不匹配 → stale_workspace。
        setCurrentWorkspaceEpoch(next.session.workspaceEpoch);
        setAuthenticatedSurfaceSession(next.session);
        // 顶栏空间胶囊的身份随同一次已验证会话发布：胶囊不自己发请求，也就不会
        // 出现「菜单说 A、胶囊说 B」。登出后视图不再是 ready，这里保留最后一次的
        // 值——届时药丸本身也不在屏幕上。
        const identity = {
          workspaceId: next.session.workspace.workspaceId,
          workspaceEpoch: next.session.workspaceEpoch,
          userId: next.session.user.userId,
          deploymentRef: next.session.deploymentRef ?? "desktop",
          name: next.session.workspace.name,
          role: next.session.workspace.role,
          isPersonal: next.session.workspace.isPersonal,
        };
        const identityBoundary = [identity.userId, identity.deploymentRef, identity.workspaceId, identity.workspaceEpoch, identity.name, identity.role, String(identity.isPersonal)].join(":");
        if (spaceIdentityBoundaryRef.current !== identityBoundary) {
          spaceIdentityBoundaryRef.current = identityBoundary;
          useRoomStore.getState().setSpaceIdentity(identity);
        }
        acceptVerifiedSpaceArrival(next.session, identity);
        // 账号身份与空间身份同一时机、同一来源发布：顶栏那个小框要回答「我是谁」，
        // 而它不该为这句话自己发请求——设置页已经有一份档案，两处各读各的就会打架。
        const account = {
          email: next.session.user.email,
          displayName: next.session.user.displayName ?? null,
        };
        const published = useRoomStore.getState().accountIdentity;
        if (published?.email !== account.email || published?.displayName !== account.displayName) {
          useRoomStore.getState().setAccountIdentity(account);
        }
        // 会话重新成立，上一次退出留下的那句话就用完了。不清的话它会在下一次
        // 完全不同的场合（比如会话到期）再冒出来。
        clearAccountSignOutNotice();
        // 静默复核落在同一个边界上：视图不落地。整棵房间因此不卸载，页面、滚动
        // 位置与焦点都留在原处；上面这些发布语句已经把这趟读到的会话对齐了。
        if (silentReverify && !boundaryChanged && viewPhaseRef.current === "ready") return;
      }
      if (next.phase !== "ready") clearSpaceArrival();
      setView(next);
    };

    const bootstrap = async () => {
      const api = desktopApi();
      if (!api) {
        apply({
          phase: "blocked",
          title: "应用组件加载失败",
          detail: "请重新载入应用；如果仍然失败，请退出后重新打开。",
          retryAction: "reload",
        });
        return;
      }
      const contractDecision = inspectDesktopContract(api.contract);
      if (contractDecision.kind === "blocked") {
        apply({
          phase: "blocked",
          title: "当前版本无法继续",
          detail: contractDecision.detail,
          retryAction: null,
        });
        return;
      }

      try {
        try {
          const subscription = await establishRequiredRuntimeSubscription(api, createRequestMeta(), (event) => {
            if (!isCurrent() || viewPhaseRef.current !== "ready") return;
            if (event.data.kind === "connection_changed") {
              // 连接恢复（ready）不是会话失效：房间已经在跑，再校验一次不会让任何
              // 东西变新，只会白拆一次页面。
              if (event.data.state.kind === "ready") return;
              const decision = decideRuntimeGate(event.data.state);
              if (decision.kind === "blocked") {
                if (decision.connection.kind !== "api_unavailable") {
                  onWorkspaceBoundaryReset?.();
                  readyBoundaryRef.current = null;
                }
                generationRef.current += 1;
                setFormFailure(null);
                setView(isConfigurationBoundary(decision.connection)
                  ? { phase: "auth", mode: "login", serviceNotice: decision.detail }
                  : {
                      phase: "blocked",
                      title: decision.title,
                      detail: decision.detail,
                      retryAction: decision.retry === "safe_retry" ? "connect" : null,
                      ...(decision.connection.kind === "api_unavailable" && decision.connection.retryAfter
                        ? { retryAfter: decision.connection.retryAfter }
                        : {}),
                    });
                return;
              }
              // 还在连接/核验：交给一次静默复核收口——成功就什么都不动，失败会落到
              // blocked。它不是"页面该重来"的理由。
              invalidateReadyGate();
              return;
            }
            // 伴星投递（companion_activity_changed）这类局部事件由伴星小屋与首页投影
            // 自己消费；门禁只对显式的 snapshot_invalidated 复核会话。
            if (event.data.kind !== "snapshot_invalidated") return;
            invalidateReadyGate();
          });
          if (!isCurrent()) {
            subscription.close();
            return;
          }
          runtimeSubscription = subscription;
        } catch (error) {
          if (!isCurrent()) return;
          const blocked = blockedFromError(error, "应用状态暂时无法更新");
          if (error instanceof RendererGatewayError && error.code === "configuration_error") {
            apply({ phase: "auth", mode: "login", serviceNotice: blocked.detail });
          } else {
            apply({ ...blocked, retryAction: blocked.retryAction ?? "bootstrap" });
          }
          return;
        }

        let runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        setCredentialPersistence(runtime.sessionCredential.persistence);
        let runtimeDecision = decideRuntimeGate(runtime.apiConnection);
        const forceConnection = forceConnectionRef.current;
        forceConnectionRef.current = false;

        if (runtimeDecision.kind === "connect" || forceConnection) {
          apply({
            phase: "loading",
            title: "正在连接学习服务",
            detail: "连接成功后会继续检查登录状态。",
            stage: GATE_STAGES.connect,
          });
          await connectOnce(api);
          if (!isCurrent()) return;
          runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
          runtimeDecision = decideRuntimeGate(runtime.apiConnection);
          setCredentialPersistence(runtime.sessionCredential.persistence);
        }

        if (runtimeDecision.kind === "connect") {
          apply({
            phase: "loading",
            title: "正在建立安全连接",
            detail: "完成后会自动继续。",
            stage: GATE_STAGES.trust,
          });
          waitTimer = window.setTimeout(() => requestBootstrap(), 650);
          return;
        }

        if (runtimeDecision.kind === "blocked") {
          if (isConfigurationBoundary(runtimeDecision.connection)) {
            apply({ phase: "auth", mode: "login", serviceNotice: runtimeDecision.detail });
            return;
          }
          apply({
            phase: "blocked",
            title: runtimeDecision.title,
            detail: runtimeDecision.detail,
            retryAction: runtimeDecision.retry === "safe_retry" ? "connect" : null,
            ...(runtimeDecision.connection.kind === "api_unavailable" && runtimeDecision.connection.retryAfter
              ? { retryAfter: runtimeDecision.connection.retryAfter }
              : {}),
          });
          return;
        }

        // A credential left by a previous launch is the difference between
        // "resuming your session" and "asking whether you are signed in".
        const resumingStoredSession = runtime.sessionCredential.stored;
        apply({
          phase: "loading",
          title: resumingStoredSession ? "正在恢复上次登录" : "正在检查登录状态",
          detail: resumingStoredSession
            ? "已找到上次的登录状态，正在向学习服务确认。"
            : "请稍候，完成后会自动继续。",
          stage: resumingStoredSession ? GATE_STAGES.restoring : GATE_STAGES.checking,
        });
        const session = unwrapGatewayResult(await api.auth.getState({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        const sessionDecision = decideSessionGate(session);

        switch (sessionDecision.kind) {
          case "wait":
            apply({
              phase: "loading",
              title: sessionDecision.reason === "restoring" ? "正在恢复登录" : "正在切换学习空间",
              detail: "完成后会自动继续。",
              stage: sessionDecision.reason === "restoring" ? GATE_STAGES.resume : GATE_STAGES.switchWorkspace,
            });
            waitTimer = window.setTimeout(() => requestBootstrap(), 700);
            return;
          case "authenticate":
            apply({ phase: "auth", mode: "login", serviceNotice: peekAccountSignOutNotice() ?? undefined });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: sessionDecision.session });
            return;
          case "blocked":
            apply({
              phase: "blocked",
              title: sessionDecision.reason === "api_untrusted" ? "无法安全登录" : "登录服务暂时不可用",
              detail: sessionDecision.detail,
              retryAction: sessionDecision.reason === "api_unavailable" ? "connect" : null,
            });
            return;
          case "resync":
            apply({
              phase: "blocked",
              title: "账号信息需要更新",
              detail: sessionDecision.detail,
              retryAction: "bootstrap",
            });
            return;
          case "workspace_required": {
            apply({
              phase: "loading",
              title: "正在加载学习空间",
              detail: "加载完成后，选择你要使用的空间。",
              stage: GATE_STAGES.loadWorkspaces,
            });
            const response = await api.workspace.list({ meta: createRequestMeta(sessionDecision.session.workspaceEpoch) });
            const workspaces = unwrapGatewayResult(response).workspaces;
            apply({ phase: "workspace", session: sessionDecision.session, workspaces });
            return;
          }
          case "ready": {
            // `/auth/me` always resolves an active workspace, so a ready session
            // already has a space to work in. More than one space no longer
            // gates the room — switching happens in the room control's
            // learning-space menu (mockup 04B), which lists `workspace.list` for
            // itself.
            apply({
              phase: "ready",
              runtime,
              session: sessionDecision.session,
            });
            return;
          }
        }
      } catch (error) {
        if (!isCurrent()) return;
        const failureDecision = decideBootstrapGatewayFailure(error);
        switch (failureDecision.kind) {
          case "authenticate":
            apply({ phase: "auth", mode: "login", serviceNotice: peekAccountSignOutNotice() ?? undefined });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: lastTrustedSessionRef.current });
            return;
          case "resync":
          case "blocked":
            if (error instanceof RendererGatewayError && error.code === "configuration_error") {
              apply({ phase: "auth", mode: "login", serviceNotice: gateErrorPolicy(error).detail });
              return;
            }
            apply(blockedFromError(error, "暂时无法打开学习空间"));
            return;
        }
      }
    };

    void bootstrap().finally(() => {
      // 一趟落地（成功、失败或被更新的一趟取代）就放掉在飞标记：下一个失效事件
      // 才有资格再起一趟。
      if (isCurrent()) bootstrapFlightRef.current = false;
    });
    // 有限等待：卡在 spinner 上超过时限就换成能点的重试。静默复核没有 spinner，
    // 它只放掉在飞标记，让后面的失效事件还能重来。
    const deadlineTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      bootstrapFlightRef.current = false;
      if (viewPhaseRef.current !== "loading") return;
      apply({
        phase: "blocked",
        title: "状态同步超时",
        detail: "学习服务一直没有回应。可以重试；已经读到的内容不会丢失。",
        retryAction: "bootstrap",
      });
      // 这一趟等不到结论了：把它的后续落地一并作废，免得迟到的"正在…"再把
      // spinner 放回屏幕上。
      generationRef.current += 1;
    }, BOOTSTRAP_DEADLINE_MS);
    return () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      window.clearTimeout(deadlineTimer);
      runtimeSubscription?.close();
    };
  }, [connectOnce, invalidateReadyGate, onWorkspaceBoundaryReset, refreshRevision, requestBootstrap]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const api = desktopApi();
    if (!api) return;
    let active = true;
    let subscriptionId: string | null = null;
    let stopEvents: (() => void) | undefined;

    const subscribe = async () => {
      try {
        const response = await api.subscriptions.subscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          topic: { kind: "workspace" },
        });
        if (!active) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        stopEvents = api.subscriptions.onEvent(subscriptionId, () => {
          // The learning-space menu owns `workspace.list`; a workspace event is
          // the one signal that the list may have changed under it. Refresh it
          // before the bootstrap re-verifies the session.
          requestSpaceMenuRefresh();
          requestBootstrap();
        });
      } catch (error) {
        if (!active) return;
        if (error instanceof RendererGatewayError && error.code === "configuration_error") {
          setView({ phase: "auth", mode: "login", serviceNotice: gateErrorPolicy(error).detail });
        } else {
          setView(blockedFromError(error, "学习空间暂时无法更新"));
        }
      }
    };

    void subscribe();
    return () => {
      active = false;
      stopEvents?.();
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          subscriptionId,
        }).catch(() => undefined);
      }
    };
  }, [requestBootstrap, view]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const onVisibilityChange = () => {
      // 回到窗口只是复核一次：同一个账号+空间+epoch 复核通过时页面不该被推倒重来。
      if (document.visibilityState === "visible") requestBootstrap(false, true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [requestBootstrap, view.phase]);

  /**
   * 门禁这一屏的"一次只跑一件事"闸门。
   *
   * `formBusy`/`codeSending` 是 React state，同一 tick 内连点两次都会读到旧值——
   * 发码是花钱的（外部邮箱有日配额），所以真正的防重复要落在同步的 ref 上，
   * state 只负责让按钮看起来禁用。
   */
  const gateActionRef = useRef(false);
  const beginGateAction = (): boolean => {
    if (gateActionRef.current) return false;
    gateActionRef.current = true;
    return true;
  };
  const endGateAction = () => { gateActionRef.current = false; };

  /** 发一枚验证码。本机只查邮箱格式，限流与通道状态由服务端回答。 */
  const handleSendCode = async () => {
    const api = desktopApi();
    if (!api || view.phase !== "auth" || codeSending || resendIn > 0 || formBusy) return;
    const emailFailure = validateEmailFormat(email);
    if (emailFailure) {
      setFormFailure(emailFailure);
      return;
    }
    if (!beginGateAction()) return;
    const purpose = view.mode === "register"
      ? "register"
      : view.mode === "reset"
        ? "reset_password"
        : "login";
    setCodeSending(true);
    setFormFailure(null);
    setCodeNotice(null);
    try {
      const sent = unwrapGatewayResult(
        await api.auth.sendEmailCode({ meta: createRequestMeta(), email: email.trim(), purpose }),
      );
      setEmailCode("");
      setResendIn(Math.max(1, sent.resendInSeconds));
      setCodeNotice(`验证码已发到 ${email.trim()}，5 分钟内有效。没收到可以看看垃圾邮件。`);
    } catch (error) {
      setFormFailure(gateErrorPolicy(error, "验证码发送失败").detail);
    } finally {
      setCodeSending(false);
      endGateAction();
    }
  };

  /**
   * 注册第一步：校验基础信息并自动发出验证码，成功才进第二步。
   * 只由 `handleAuthSubmit` 调用（下一步那颗按钮就是表单的提交键），
   * 防连点的闸门在那边已经拿到了。
   */
  const handleRegisterNext = async () => {
    const api = desktopApi();
    if (!api || view.phase !== "auth") return;
    const localFailure = validateAuthForm({ mode: "register", email, password, confirmPassword });
    if (localFailure) {
      setFormFailure(localFailure);
      return;
    }
    setFormBusy(true);
    setFormFailure(null);
    setCodeNotice(null);
    try {
      const sent = unwrapGatewayResult(
        await api.auth.sendEmailCode({ meta: createRequestMeta(), email: email.trim(), purpose: "register" }),
      );
      setEmailCode("");
      setResendIn(Math.max(1, sent.resendInSeconds));
      setRegisterStep("verify");
    } catch (error) {
      setFormFailure(gateErrorPolicy(error, "验证码发送失败").detail);
    } finally {
      setFormBusy(false);
    }
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "auth") return;
    if (!beginGateAction()) return;
    // 注册第一步的「下一步」走发码那条路，不提交注册。
    if (view.mode === "register" && emailChannelAvailable && registerStep === "details") {
      try {
        await handleRegisterNext();
      } finally {
        endGateAction();
      }
      return;
    }
    const registering = view.mode === "register";
    const resetting = view.mode === "reset";
    const viaCode = view.mode === "login" && loginViaCode;
    const inviteForRegister = inviteToken.trim();
    // 本机校验按模式分流：错在哪一格，就在哪一格回答，不打一发必败的往返。
    const localFailure = resetting
      ? validateResetForm({ email, code: emailCode, password, confirmPassword })
      : viaCode
        ? validateEmailFormat(email) ?? validateEmailCode(emailCode)
        : (validateAuthForm({ mode: registering ? "register" : "login", email, password, confirmPassword })
          ?? (registering && emailChannelAvailable ? validateEmailCode(emailCode) : null));
    if (localFailure) {
      setFormFailure(localFailure);
      endGateAction();
      return;
    }
    // 开始下一次登录，上一次退出留下的结论就翻篇了：它描述的是刚离开的那个账号，
    // 继续挂在表单下面会把两件事混成一件。
    clearAccountSignOutNotice();
    setFormBusy(true);
    setFormFailure(null);
    try {
      if (resetting) {
        unwrapGatewayResult(await api.auth.resetPassword({
          meta: createRequestMeta(),
          email: email.trim(),
          code: emailCode.trim(),
          newPassword: password,
        }));
        // 没有会话可签发：把人送回登录屏，带上"已重置"那句话，邮箱留着免得重打。
        setPassword("");
        setConfirmPassword("");
        setEmailCode("");
        setResendIn(0);
        setCodeNotice(null);
        setView({ phase: "auth", mode: "login", serviceNotice: "密码已重置，请用新密码登录。" });
        return;
      }
      const response = viaCode
        ? await api.auth.loginWithCode({
            meta: createRequestMeta(),
            email,
            code: emailCode.trim(),
            remember: keepSignedIn,
          })
        : registering
          ? await api.auth.register({
              meta: createRequestMeta(),
              email,
              password,
              remember: keepSignedIn,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
              ...(inviteForRegister ? { inviteToken: inviteForRegister } : {}),
              ...(emailChannelAvailable && emailCode.trim() ? { emailCode: emailCode.trim() } : {}),
            })
          : await api.auth.login({ meta: createRequestMeta(), email, password, remember: keepSignedIn });
      unwrapGatewayResult(response);
      setPassword("");
      setConfirmPassword("");
      setEmailCode("");
      setResendIn(0);
      setCodeNotice(null);
      beginRoomReveal();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(
        error,
        resetting ? "无法重置密码" : registering ? "无法创建账号" : viaCode ? "验证码登录没成功" : "无法登录",
      );
      if (error instanceof RendererGatewayError && error.code === "configuration_error") {
        setFormFailure(policy.detail);
        setView({ phase: "auth", mode: view.mode, serviceNotice: policy.detail });
      } else if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
      endGateAction();
    }
  };

  const handleReauthenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "reauth" || signingOut) return;
    if (!password) {
      setFormFailure("请输入当前密码。");
      return;
    }
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = await api.auth.reauthenticate({ meta: createRequestMeta(), password });
      unwrapGatewayResult(response);
      setPassword("");
      beginRoomReveal();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, "无法重新验证身份");
      if (error instanceof RendererGatewayError && error.code === "configuration_error") {
        setFormFailure(policy.detail);
      } else if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  /**
   * 重认证那一屏的出口。密码想不起来时，这一屏是唯一的一条路，而它走不通——
   * 所以把人送回登录页，让他换账号登录或注册新账号。
   *
   * 为什么不能只靠 `signOutCurrentAccount()` 里那条失效广播：`invalidateReadyGate`
   * 只对 ready 视图生效，这一屏停在 reauth，广播到这里就断了，会话已经拆掉而画面
   * 还留在原处。所以视图要在这里自己换，退出结论也要在这里带到登录页上。
   */
  const handleReauthSignOut = async () => {
    const api = desktopApi();
    if (!api || view.phase !== "reauth" || signingOut) return;
    // 登录页把邮箱预填成刚离开的那个账号：这条路只是离开这台设备上的登录，
    // 不该让人再把自己是谁输一遍。
    const previousEmail = view.session?.user?.email ?? "";
    setSigningOut(true);
    setFormFailure(null);
    // 这个方法自己消化所有失败结局（换成一句人话留给登录页），不会抛。
    await signOutCurrentAccount();
    setSigningOut(false);
    setPassword("");
    setEmail(previousEmail);
    setView({ phase: "auth", mode: "login", serviceNotice: peekAccountSignOutNotice() ?? undefined });
  };

  if (view.phase === "ready") {
    return (
      <div className="desktop-access-gate__room-content" data-room-revealed={roomRevealed}>
        {children}
      </div>
    );
  }

  if (view.phase === "loading") {
    return (
      <GateFrame title={view.title} detail={view.detail} motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <div className="desktop-access-gate__loading" role="status" aria-live="polite">
          <LoaderCircle size={24} aria-hidden="true" />
          <span>{view.stage ?? "正在与学习服务确认"}</span>
        </div>
      </GateFrame>
    );
  }

  if (view.phase === "blocked") {
    const retryAt = retryTimeLabel(view.retryAfter);
    return (
      <GateFrame title={view.title} detail={view.detail} tone="danger" motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <div className="desktop-access-gate__notice" role="alert">
          <span className="desktop-access-gate__notice-mark" aria-hidden="true">
            <ShieldAlert size={19} />
          </span>
          <p>{retryAt
            ? `请在 ${retryAt} 后再试。`
            : "重新连接学习服务后，应用会继续读取工作区内容。"}
          </p>
        </div>
        {view.retryAction ? (
          <button
            className="desktop-access-gate__primary"
            type="button"
            onClick={() => view.retryAction === "reload" ? window.location.reload() : requestBootstrap(view.retryAction === "connect")}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {view.retryAction === "reload" ? "重新载入应用" : view.retryAction === "connect" ? "重新连接" : "再试一次"}
          </button>
        ) : null}
      </GateFrame>
    );
  }

  if (view.phase === "auth") {
    const registering = view.mode === "register";
    const resetting = view.mode === "reset";
    const viaCode = view.mode === "login" && loginViaCode;
    // 注册分两步（只在有邮箱通道时）：第一步基础信息，第二步邮箱验证码。
    const registerVerifying = registering && emailChannelAvailable && registerStep === "verify";
    const registerBasics = !registering || !emailChannelAvailable || registerStep === "details";
    const showCodeField = viaCode || resetting || registerVerifying;
    const title = resetting
      ? "重置密码"
      : registerVerifying
        ? "确认邮箱"
        : registering
          ? "创建账号"
          : viaCode
            ? "验证码登录"
            : "欢迎回来";
    const detail = resetting
      ? "邮箱收验证码，设置一个新密码。"
      : registerVerifying
        ? `验证码已发到 ${email.trim()}，5 分钟内有效。没收到就看看垃圾邮件。`
        : registering
          ? emailChannelAvailable
            ? "先填基础信息，下一步去邮箱取验证码。"
            : "填写邮箱和密码即可；昵称和邀请码按需填写。"
          : viaCode
            ? "不用记密码，邮箱收码直接进。"
            : "登录后继续上次的学习。";
    return (
      <GateFrame
        title={title}
        detail={detail}
        variant={registering ? "register" : "default"}
        motionMode={motionMode}
        backdropUrls={registering ? registerBackdropUrls : gateBackdropUrls}
        corner={<GateUpdateRow />}
        {...gateSceneProps}
      >
        <form
          className={`desktop-access-gate__form${registering ? " desktop-access-gate__form--register" : ""}`}
          aria-busy={formBusy}
          noValidate
          onSubmit={handleAuthSubmit}
        >
          <div className={`desktop-access-gate__fields${registering ? " desktop-access-gate__fields--register" : ""}`}>
          <label className={registering ? "desktop-access-gate__field--wide" : undefined}>
            <span className="desktop-access-gate__field-label">邮箱</span>
            <span className="desktop-access-gate__field-control">
              <Mail size={18} aria-hidden="true" />
              <input
                type="email"
                autoComplete="email"
                maxLength={320}
                required
                readOnly={registerVerifying}
                value={email}
                placeholder="name@example.com"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFormFailure(null);
                  // 验证码跟着邮箱走：换了一个地址，旧的码与冷却都不再对应。
                  setEmailCode("");
                  setCodeNotice(null);
                  setResendIn(0);
                }}
              />
            </span>
          </label>
          {showCodeField ? (
            <label className={registering ? "desktop-access-gate__field--wide" : undefined}>
              <span className="desktop-access-gate__field-label desktop-access-gate__field-label--send">
                邮箱验证码
                <button
                  className="desktop-access-gate__code-send"
                  type="button"
                  disabled={codeSending || resendIn > 0 || formBusy}
                  onClick={() => void handleSendCode()}
                >
                  {codeSending
                    ? "发送中…"
                    : resendIn > 0
                      ? `${resendIn}s 后可重发`
                      : registerVerifying || codeNotice
                        ? "重新发送"
                        : "发送验证码"}
                </button>
              </span>
              <span className="desktop-access-gate__field-control">
                <Hash size={18} aria-hidden="true" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={emailCode}
                  placeholder="6 位数字"
                  onChange={(event) => { setEmailCode(event.target.value.replace(/\D/g, "")); setFormFailure(null); }}
                />
              </span>
            </label>
          ) : null}
          {!viaCode && !registerVerifying ? (
          <label>
            <span className="desktop-access-gate__field-label">
              {resetting ? "新密码" : "密码"} {registering || resetting ? <small>至少 {MIN_PASSWORD_LENGTH} 位</small> : null}
            </span>
            <span className="desktop-access-gate__field-control desktop-access-gate__field-control--with-action">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                type={passwordVisible ? "text" : "password"}
                autoComplete={registering || resetting ? "new-password" : "current-password"}
                maxLength={200}
                required
                value={password}
                placeholder={registering || resetting ? `至少 ${MIN_PASSWORD_LENGTH} 位` : "输入密码"}
                onChange={(event) => { setPassword(event.target.value); setFormFailure(null); }}
              />
              <button
                className="desktop-access-gate__reveal"
                type="button"
                aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </span>
          </label>
          ) : null}
          {(registering || resetting) && !registerVerifying ? (
            <label>
              <span className="desktop-access-gate__field-label">{resetting ? "确认新密码" : "确认密码"}</span>
              <span className="desktop-access-gate__field-control">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="new-password"
                  maxLength={200}
                  required
                  value={confirmPassword}
                  placeholder="再输入一次"
                  onChange={(event) => { setConfirmPassword(event.target.value); setFormFailure(null); }}
                />
              </span>
            </label>
          ) : null}
          {registering && registerBasics ? (
            <label>
              <span className="desktop-access-gate__field-label">昵称 <small>选填</small></span>
              <span className="desktop-access-gate__field-control">
                <UserRound size={18} aria-hidden="true" />
                <input autoComplete="name" maxLength={200} value={displayName} placeholder="怎么称呼你" onChange={(event) => setDisplayName(event.target.value)} />
              </span>
            </label>
          ) : null}
          {registering && registerBasics ? (
            <label>
              <span className="desktop-access-gate__field-label">邀请码 <small>选填 · 加入协作空间</small></span>
              <span className="desktop-access-gate__field-control">
                <Ticket size={18} aria-hidden="true" />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  value={inviteToken}
                  placeholder="粘贴邀请码"
                  onChange={(event) => { setInviteToken(event.target.value); setFormFailure(null); }}
                />
              </span>
            </label>
          ) : null}
          </div>
          {(formFailure ?? view.serviceNotice) ? <p className="desktop-access-gate__form-error" role="alert">{formFailure ?? view.serviceNotice}</p> : null}
          {codeNotice ? <p className="desktop-access-gate__code-notice" role="status">{codeNotice}</p> : null}
          {credentialPersistence === "local_file" ? (
            <label className="desktop-access-gate__keep-signed-in">
              <input
                type="checkbox"
                checked={keepSignedIn}
                disabled={formBusy}
                onChange={(event) => setKeepSignedIn(event.target.checked)}
              />
              <span>保持登录，下次打开不用重新输入</span>
            </label>
          ) : null}
          <p className="desktop-access-gate__trust-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              {authSurfaceHelp ?? (credentialPersistence === "local_file"
                ? "登录凭据只保存在这台设备的本地文件里，密码本身不会写入磁盘。"
                : "密码会安全提交；这次没能把登录状态写到这台设备，关闭应用后需要重新登录。")}
            </span>
          </p>
          <button className="desktop-access-gate__primary" type="submit" disabled={formBusy}>
            {formBusy
              ? <LoaderCircle className="desktop-access-gate__button-spinner" size={17} aria-hidden="true" />
              : resetting ? <KeyRound size={17} aria-hidden="true" />
                : registerVerifying ? <UserPlus size={17} aria-hidden="true" />
                  : registering ? <Mail size={17} aria-hidden="true" />
                    : viaCode ? <Mail size={17} aria-hidden="true" />
                      : <LogIn size={17} aria-hidden="true" />}
            {formBusy
              ? registering
                ? registerVerifying ? "正在创建账号…" : "正在发送验证码…"
                : resetting ? "正在重置…" : "正在登录…"
              : resetting ? "重置密码"
                : registering
                  ? registerVerifying ? "创建账号" : "下一步"
                  : "登录"}
            {/* 登录态不排尾箭头：`→]` 与 `→` 都在说"进入"，而文字已经写了"登录"。
                尾箭头留给注册的两步——那里说的是"往下一步走"，方向就是它要讲的。 */}
            {!formBusy && registering ? <ArrowRight className="desktop-access-gate__primary-arrow" size={16} aria-hidden="true" /> : null}
          </button>
          {registerVerifying ? (
            <button
              className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
              type="button"
              disabled={formBusy}
              onClick={() => {
                setFormFailure(null);
                setCodeNotice(null);
                setEmailCode("");
                setResendIn(0);
                setRegisterStep("details");
              }}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              返回上一步，改邮箱或密码
            </button>
          ) : null}
          {!registering && !resetting ? (
            // 两个入口都是"换个进门方式"，同一层级就并排一行，不各占一行高度。
            // **不看通道探针**：探针说的是"这台服务现在配没配发信凭据"，而忘了密码
            // 的人手里没有第二条路。此前探针一失败（未配对、断网、契约不符都算失败）
            // 这两格就一起消失，且不留一句解释——最需要一个出口的人，看到的是没有出口。
            // 通道真没开时，点进去发码会回 503 并说清是通道问题，那才是该说话的地方。
            <div className="desktop-access-gate__auth-links">
              <button
                className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
                type="button"
                disabled={formBusy}
                onClick={() => {
                  setFormFailure(null);
                  setCodeNotice(null);
                  setEmailCode("");
                  setResendIn(0);
                  setLoginViaCode((on) => !on);
                }}
              >
                <Mail size={15} aria-hidden="true" />
                {loginViaCode ? "改用密码登录" : "用验证码登录"}
              </button>
              <button
                className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
                type="button"
                disabled={formBusy}
                onClick={() => {
                  setFormFailure(null);
                  setCodeNotice(null);
                  setEmailCode("");
                  setResendIn(0);
                  setLoginViaCode(false);
                  setPassword("");
                  setConfirmPassword("");
                  setView({ phase: "auth", mode: "reset" });
                }}
              >
                <KeyRound size={15} aria-hidden="true" />
                忘记密码？
              </button>
            </div>
          ) : null}
          {resetting ? (
            <button
              className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
              type="button"
              disabled={formBusy}
              onClick={() => {
                setFormFailure(null);
                setCodeNotice(null);
                setEmailCode("");
                setResendIn(0);
                setPassword("");
                setConfirmPassword("");
                setView({ phase: "auth", mode: "login" });
              }}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              返回登录
            </button>
          ) : null}
          {!resetting ? (
          <button
            className="desktop-access-gate__text-action desktop-access-gate__text-action--mode"
            type="button"
            disabled={formBusy}
            onClick={() => {
              setFormFailure(null);
              setPassword("");
              setConfirmPassword("");
              setInviteToken("");
              // 验证码按用途签发：换屏就把上一屏的码与冷却清掉，不留错位状态。
              setEmailCode("");
              setCodeNotice(null);
              setResendIn(0);
              setLoginViaCode(false);
              setRegisterStep("details");
              setView({ phase: "auth", mode: registering ? "login" : "register" });
            }}
          >
            {registering ? <ArrowLeft size={15} aria-hidden="true" /> : null}
            {registering ? "已有账号？登录" : "还没有账号？注册"}
          </button>
          ) : null}
        </form>
      </GateFrame>
    );
  }

  if (view.phase === "reauth") {
    const accountLabel = view.session?.user?.displayName ?? view.session?.user?.email ?? "当前账号";
    return (
      <GateFrame title="请再次输入密码" detail={`为了保护 ${accountLabel} 的账号，请确认当前密码。`} motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <form className="desktop-access-gate__form" aria-busy={formBusy} onSubmit={handleReauthenticate}>
          <label>
            <span className="desktop-access-gate__field-label">当前密码</span>
            <span className="desktop-access-gate__field-control">
              <LockKeyhole size={18} aria-hidden="true" />
              <input type="password" autoComplete="current-password" maxLength={200} required value={password} placeholder="输入当前密码" onChange={(event) => setPassword(event.target.value)} />
            </span>
          </label>
          {formFailure ? <p className="desktop-access-gate__form-error" role="alert">{formFailure}</p> : null}
          <p className="desktop-access-gate__trust-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>确认通过后，会继续打开你的学习空间。</span>
          </p>
          <button className="desktop-access-gate__primary" type="submit" data-busy={formBusy} disabled={formBusy || signingOut}>
            {formBusy
              ? <LoaderCircle className="desktop-access-gate__button-spinner" size={17} aria-hidden="true" />
              : <KeyRound size={17} aria-hidden="true" />}
            {formBusy ? "正在确认…" : "确认并继续"}
          </button>
          <button
            className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
            type="button"
            disabled={formBusy || signingOut}
            onClick={() => void handleReauthSignOut()}
          >
            {signingOut
              ? <LoaderCircle className="desktop-access-gate__button-spinner" size={15} aria-hidden="true" />
              : <LogOut size={15} aria-hidden="true" />}
            {signingOut ? "正在退出…" : "想不起来密码？退出并重新登录"}
          </button>
        </form>
      </GateFrame>
    );
  }

  // `workspace_required` is the one-time choice every other phase leaves alone:
  // the account is signed in but no space is bound, so the client still reads
  // nothing about any of them. The mockup folds that choice into the home page
  // (04A), which is what `HudFirstSpaceScene` restores.
  return (
    <HudFirstSpaceScene
      session={view.session}
      workspaces={view.workspaces}
      onCommitted={() => {
        beginRoomReveal();
        requestBootstrap();
      }}
    />
  );
}
