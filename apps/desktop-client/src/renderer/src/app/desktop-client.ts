import {
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayErrorV1,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@astella/shared/desktop-ipc-contracts";
import { publishGateInvalidation } from "./gate-invalidation";
import { accountPreferenceRejectionMessage } from "@astella/shared/companion-memory-scope";

let requestSequence = 0;

function opaqueId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${Date.now()}-${requestSequence}`;
}

/**
 * 渲染层当前所在工作区的 epoch，由 `DesktopAccessGate` 在边界判定时写入。
 *
 * 为什么要有一个模块级兜底：主进程的 `assertEpoch` 已改成 fail-closed（不带 epoch
 * 即视为过期），而"调用方漏传 epoch"是常态而非例外——`SourceIntake` 的批量采集、
 * 笔记图片上传、伴星念头气泡都不持有任何 epoch 游标。让 `createRequestMeta()`
 * 默认取当前边界，使漏传在结构上不可能发生；显式传参仍然优先，各 surface 自己的
 * 游标语义不变。
 */
let currentWorkspaceEpoch = 0;

export function setCurrentWorkspaceEpoch(epoch: number): void {
  currentWorkspaceEpoch = epoch > 0 ? epoch : 0;
}

export function getCurrentWorkspaceEpoch(): number {
  return currentWorkspaceEpoch;
}

export function createRequestMeta(workspaceEpoch?: number): RequestMetaV1 {
  const meta: RequestMetaV1 = {
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    requestId: opaqueId("renderer-request"),
    correlationId: opaqueId("renderer-correlation"),
    clientStartedAt: new Date().toISOString(),
  };

  const boundary = workspaceEpoch && workspaceEpoch > 0 ? workspaceEpoch : currentWorkspaceEpoch;
  return boundary > 0 ? { ...meta, workspaceEpoch: boundary } : meta;
}

export function createCommandId(prefix: string): string {
  return opaqueId(`renderer-command-${prefix}`);
}

export class RendererGatewayError extends Error {
  readonly code: GatewayErrorV1["code"];
  readonly retry: GatewayErrorV1["retry"];
  readonly retryAfter?: string;
  /**
   * main 侧原样投影过来的 4xx（合同里只在 400–499 时带）。
   *
   * 上传那一类调用要按状态码给用户能行动的文案（413 太大 / 415 格式不支持 /
   * 429 太频繁），只留 `code` 就全部塌成"暂时不可用"。
   */
  readonly httpStatus?: number;

  constructor(error: GatewayErrorV1) {
    super(error.safeMessageKey);
    this.name = "RendererGatewayError";
    this.code = error.code;
    this.retry = error.retry;
    this.retryAfter = error.retryAfter;
    this.httpStatus = error.httpStatus;
  }
}

export function unwrapGatewayResult<T>(result: GatewayResultV1<T>): T {
  if (!result.ok) {
    publishGateInvalidation(result.error.code);
    throw new RendererGatewayError(result.error);
  }
  return result.data;
}

/**
 * 当前工作区纪元。写操作必须带上它：一旦切换过工作区，旧的在途请求就会落到
 * 新工作区上。会话发送与语音转写都从这里取。
 */
export async function requireWorkspaceEpoch(): Promise<number> {
  const session = await window.astella.auth.getState({ meta: createRequestMeta() });
  const context = unwrapGatewayResult(session);
  if (context.status !== "authenticated" || !context.workspace) {
    throw new Error("请先登录并进入工作区");
  }
  return context.workspace.workspaceEpoch;
}

export function gatewayErrorMessage(error: unknown): string {
  if (!(error instanceof RendererGatewayError)) return "服务暂时没有返回可确认的结果。";

  switch (error.code) {
    case "auth_required":
    case "reauth_required":
      return "请先登录或重新验证身份，再继续这条学习流程。";
    case "api_unavailable":
    case "network_timeout":
      return "学习服务暂时不可用；可以安全重试，不会重复创建学习旅程。";
    case "api_untrusted":
    case "configuration_error":
      return "桌面端尚未通过本机服务校验，当前不能读取真实学习数据。";
    case "unsupported_contract":
      return "服务返回的学习合同版本不受当前客户端支持，已安全停止。";
    case "forbidden":
      return "当前工作区或账号没有执行这个动作的权限。";
    // 没签同意不是"没权限"：那句会让人去问管理员，而这是他自己一分钟能解的事（doc 34 L13）。
    case "ai_consent_required":
      return "还没签署 AI 使用同意，内容不会离开这台电脑。在设置页的「AI 数据同意」里签一下就恢复。";
    case "ai_data_policy_denied":
      return "外部 AI 已关闭。请在「AI 数据同意」中开启「允许发送到外部模型服务」后继续。";
    case "stale_workspace":
      return "工作区已经变化，请重新加载当前学习队列。";
    case "conflict":
      return "这条学习状态已经发生变化，请先同步后再继续。";
    case "personal_workspace_not_shareable":
      // 审计 F31：这件事与"学习状态"无关——个人空间本来就没有名册可管。
      return "个人空间不能邀请成员。要一起学，先新建一个协作空间，进去之后再邀请。";
    // 笔记这一条不是"学习状态变了"：要的是重新取一次这一篇的编辑起点。**不能**承诺
    // "刚敲的字还能接回来"——那种错位下本机这份与重取到的那份没有共同历史，草稿并进去
    // 也落不到正文上（会挂成进不来的结构）。所以这句只说下一步做什么，不说做不到的事。
    case "note_doc_stale":
      return "这篇笔记的编辑起点已经过期（本机这份和服务端对不上），这次改动没有存进去。退出这篇重新打开就能继续写。";
    case "reflection_stale_revision":
      return "另一处已修改这条批注。你的文字还在；重新读取后，核对新的批注再保存。";
    case "teaching_grounding_failed":
      // 与服务端 422 那一句同源：说清"没展示"与"换问法比空转一次有用"。
      return "这次讲解里有几处说法，这篇笔记里没有依据，所以没有展示。换个问法多半就能过，或先继续读笔记。";
    case "teaching_model_unconfigured":
      return "讲解模型还没有配置，已有内容保留；配置好 AI 服务后再来。";
    case "note_artifact_too_long":
      return "这篇笔记太长，伴星没有截掉正文来假装讲全篇。选中一小段原文后，可以再做互动讲解。";
    case "note_artifact_stale":
      return "笔记版本刚刚变化，这份互动讲解没有贴到新正文上。重新打开当前笔记后再试。";
    case "note_artifact_generation_failed":
      return "伴星刚才没能做完互动讲解，原文和已有记录都还在；可以稍后重试。";
    case "teaching_in_progress":
      return "这一轮正在准备讲解，稍后刷新就能接回；不用重复生成。";
    case "round_budget_exhausted":
      return "这一轮的生成次数或等待预算已用完。已有内容保留，可以继续读或先到这里。";
    case "result_unknown":
      return "上一动作的结果尚未确认；请先同步当前学习状态，客户端不会重复提交。";
    case "rate_limited": {
      const retryAt = error.retryAfter ? new Date(error.retryAfter) : null;
      const retryTime = retryAt && Number.isFinite(retryAt.valueOf())
        ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(retryAt)
        : null;
      return retryTime ? `服务端暂时限流，请在 ${retryTime} 后再试。` : "服务端暂时限流，请稍后再试。";
    }
    case "not_found":
      return "这条学习内容已经不存在或不再对当前账号可见。";
    case "feature_disabled":
      return "这项学习能力当前未在本环境启用。";
    /**
     * 本机识别引擎（2026-10-06）。这句必须说清**服务端没参与**：录音没有离开这台
     * 电脑，出问题的是本机那份引擎。说成"学习服务内部出了点问题"会让人去查网络、
     * 换设备，而真正的下一步是重装识别模型或再试一次。
     */
    case "voice_engine_unavailable":
      return "本机识别引擎没能启动，这句话没有识别出来。录音没有离开这台电脑；可以在设置里重新下载语音识别模型，或稍后再试一次。";
    case "memory_global_kind_rejected":
      return accountPreferenceRejectionMessage("kind_not_preference");
    case "memory_global_content_bound":
      return accountPreferenceRejectionMessage("content_workspace_bound");
    case "memory_global_condition_bound":
      return accountPreferenceRejectionMessage("applies_when_workspace_bound");
    // 2026-09-19 补映射：这些码此前落到 default 兜底句，用户看不出发生了什么。
    case "invalid_request":
    case "validation":
      return "这次请求的内容没有通过校验，请检查后重试。";
    case "invalid_navigation":
    case "route_not_available":
      return "当前版本还不支持这个跳转目标。";
    case "cancelled":
      return "这一轮已经取消。";
    case "safe_internal_error":
      return "学习服务内部出了点问题，已记录；请稍后重试。";
    // Auth-form outcomes. These read as account and invitation problems, not as
    // learning-content problems, because that is the surface they appear on.
    case "email_exists":
      return "这个邮箱已经注册过，请直接登录；忘记密码请联系管理员。";
    case "invite_invalid":
      return "邀请码无效，请核对后重新输入，或向邀请你的人要一个新的。";
    case "invite_expired":
      return "邀请码已过期，请向邀请你的人要一个新的。";
    case "invite_consumed":
      return "这个邀请码已经被使用过了，请向邀请你的人要一个新的。";
    case "workspace_limit":
      return "你已经加入了可参与的工作区数量上限，无法再加入新的协作空间。";
    case "already_member":
      return "你的账号已经在这个协作空间里了，无需重复加入。";
    // 网关把 /auth/change-password 的 403 `invalid_password` 翻成这个码。
    // 没有它就会落到 `forbidden` 那句"没有执行这个动作的权限"：改密失败被说成权限
    // 问题，用户去翻权限，而真正要做的只是把当前密码重输一遍。（登录那道门
    // `desktop-gate.ts` 有自己的"邮箱或密码不正确"，不复用这一句。）
    case "invalid_credentials":
      return "当前密码不正确，请重新输入。";
    default:
      return "学习服务没有完成这次请求，请稍后重试。";
  }
}

/**
 * 一次失败**是哪一种**——界面据此决定它长什么样。
 *
 * 为什么必须分开：此前所有失败都被塞进同一个 `role="alert"` 灰字里，于是
 * 「这一轮正在准备讲解」这种**正常的等待态**和「真的没做成」在屏上长得一模一样，
 * 都是一条红字，摆在纸片最底下。
 *
 * 四档与各自的界面义务：
 *  - `pending`  还在做。它**不是**错误：不进 `role="alert"`，不配"重试"，
 *    配的是"稍后会自动接上"（§13.3「不伪造预计成功率」——所以不给进度条）。
 *  - `retryable` 没做成，但同样输入大概率能成。**必须**给一颗就地重试。
 *  - `blocked`  用户自己要先解决（登录、同意、权限）。重试没有意义，
 *    要指出去哪解决。
 *  - `failed`   其他。给回读与"先到这里"的出路，不许把人困在这一格。
 */
export type GatewayFailureKind = "pending" | "retryable" | "blocked" | "failed";

const RETRYABLE_GATEWAY_CODES = new Set([
  "api_unavailable",
  "network_timeout",
  "rate_limited",
  "safe_internal_error",
  "conflict",
  "stale_workspace",
  "result_unknown",
]);

const BLOCKED_GATEWAY_CODES = new Set([
  "auth_required",
  "reauth_required",
  "ai_consent_required",
  "ai_data_policy_denied",
  "forbidden",
  "feature_disabled",
  "api_untrusted",
  "configuration_error",
]);

export function classifyGatewayError(error: unknown): {
  readonly kind: GatewayFailureKind;
  readonly message: string;
} {
  if (!(error instanceof RendererGatewayError)) {
    return { kind: "retryable", message: "服务暂时没有返回可确认的结果。" };
  }
  // 「正在准备」是一次**成功受理**的回执，不是失败：服务端已经收下这一发，
  // 只是结果还没到。把它归到 failed，用户会以为按坏了。
  if (error.code === "teaching_in_progress") {
    return { kind: "pending", message: gatewayErrorMessage(error) };
  }
  if (RETRYABLE_GATEWAY_CODES.has(error.code)) {
    return { kind: "retryable", message: gatewayErrorMessage(error) };
  }
  if (BLOCKED_GATEWAY_CODES.has(error.code)) {
    return { kind: "blocked", message: gatewayErrorMessage(error) };
  }
  return { kind: "failed", message: gatewayErrorMessage(error) };
}
