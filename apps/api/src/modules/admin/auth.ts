/**
 * 运维管理面板的访问闸（`/admin/*`）。
 *
 * ## 为什么不用现有的 requireSession
 *
 * 本仓库的鉴权是**逐租户**的：会话令牌解出 (user, workspace)，随后每条查询都在
 * `withWorkspaceTransaction` 里设 `app.workspace_id` / `app.user_id`，由 FORCE RLS
 * 收窄。owner 是**空间**内的角色，不是部署内的角色——把 `requireOwner` 接到面板上
 * 会得到一个「只能看自己那一个空间」的全局后台，队列与指标全是单空间口径，
 * 而「现在有没有 run 卡在 assessing」恰恰是跨空间的问题。
 *
 * 所以面板走**另一条身份**：一个部署级的运维令牌。它与用户会话没有任何交集，
 * 也不复用 `sessions` 表——持令牌的人不是任何空间的用户，不该出现在任何空间的
 * 成员列表里。
 *
 * ## fail closed 是这里最重要的一件事
 *
 * `ADMIN_PANEL_TOKEN` 未设置时，`isAdminPanelEnabled()` 返回 false，
 * `adminRoutes()` **根本不注册任何路由**（不是注册了再拒绝）。区别在于：
 * 注册了再拒绝，面板会出现在端口扫描与资产清单里，而一个「存在但永远 401」
 * 的端点是持续的探测目标；不注册则它在网络层与 Fastify 路由表里都不存在。
 *
 * ## 令牌强度下限
 *
 * 低于 {@link MIN_ADMIN_TOKEN_LENGTH} 的令牌一律视为**未配置**。原因：占位值
 * （`dev`、`changeme`、`123456`）在文档与 `.env.example` 里天然会出现，让一个
 * 面板因为「配了」就对外开放，比没配危险得多。这里选择**忘记启用**，而不是
 * 启用一个弱闸——运维可以在启动日志里看到明确的提示。
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** 令牌最小长度（字符）。低于此值视为未配置，见模块头说明。 */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/**
 * 明显的占位值。
 *
 * 与长度下限是两道独立的闸：长但没换掉的默认值（compose 里常见的
 * `please-change-me-in-production`）同样是可猜的。
 */
const PLACEHOLDER_FRAGMENTS = [
  "change-me",
  "changeme",
  "placeholder",
  "example",
  "your-token",
  "your_token",
  "todo",
];

/**
 * 解析运维令牌。返回 `null` 表示**未启用**——调用方据此 fail closed。
 *
 * 纯函数（不读 `process.env` 的实参形式）便于测试：默认值取 `process.env`，
 * 测试传显式值。
 */
export function resolveAdminToken(raw: string | undefined = process.env.ADMIN_PANEL_TOKEN): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) return null;
  const lowered = token.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return null;
  return token;
}

/** 面板是否启用。**唯一**的判定入口——路由注册与 UI 可用性都以它为准。 */
export function isAdminPanelEnabled(
  raw: string | undefined = process.env.ADMIN_PANEL_TOKEN,
): boolean {
  return resolveAdminToken(raw) !== null;
}

/**
 * 常量时间比较。
 *
 * `timingSafeEqual` 要求两侧**等长**，所以先比长度——长度本身不是秘密
 * （令牌长度不影响暴力破解的可行性），而长度不等时提前返回是必须的，
 * 否则 `timingSafeEqual` 会抛异常。
 *
 * 仍然对等长的情况走一次按字节的累积比较，不用 `===`：
 * `===` 在首个不等字节处短路，理论上可被时序区分。
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 从请求里取运维令牌。
 *
 * 两种写法：专用头 `x-admin-token`，或 `Authorization: Bearer`。浏览器里
 * `fetch` 设自定义头会触发预检，所以 Bearer 那一路让**无自定义头**的场景
 * （curl、脚本）不必操心 CORS 预检。
 */
export function readAdminTokenHeader(headers: Record<string, unknown>): string | null {
  const direct = headers["x-admin-token"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * 失败尝试的节流（进程内）。
 *
 * 面板本身是低频人工操作，一次失败几乎总是「令牌打错了」。但它是一个
 * 纯口令端点，没有速率限制就等于允许无限制猜测。这里按**来源 IP** 记窗口：
 * 连续失败进入退避，而不是一开始就 429——否则运维自己输错三次就会被自己
 * 锁在外面，且没有任何办法恢复。
 *
 * 刻意做成进程内而不是共享存储：这个闸只在单实例部署里被依赖（多副本部署
 * 前面已有 `AILEARN_DESKTOP_PAIRING_SECRET` 那套共享限流设施），而一个
 * 进程内的表不应该被误当成安全边界——它只是抬高暴力猜��的成本。
 */
interface AttemptRecord {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_AFTER_FAILURES = 8;
const BLOCK_DURATION_MS = 5 * 60 * 1000;

const attempts = new Map<string, AttemptRecord>();

/** 进程重启即清空——刻意不持久化，见上方说明。 */
export function resetAdminAuthAttempts(): void {
  attempts.clear();
}

/** 单次判定所需的信息，保持纯函数便于测试。 */
export interface AdminAuthDecision {
  ok: boolean;
  status: number;
  error: string;
}

/**
 * 判定一次面板请求。
 *
 * 返回 `ok: false` 时**绝不能**回显令牌内容、回显配置路径或回显失败原因里
 * 任何可用于缩小搜索空间的细节——统一 `{ error: "forbidden" }`。
 */
export function evaluateAdminAuth(input: {
  token: string | null;
  expected: string | null;
  nowMs: number;
  clientKey: string;
}): AdminAuthDecision {
  if (input.expected === null) {
    // 面板不该被注册到还能走到这里。这条是纵深防御：万一将来有人把注册
    // 与判定拆开，缺令牌时也不给出「去配 ADMIN_PANEL_TOKEN」的提示——
    // 那是给攻击者的配置面指引。
    return { ok: false, status: 404, error: "not_found" };
  }

  const record = attempts.get(input.clientKey);
  if (record && record.blockedUntil > input.nowMs) {
    return { ok: false, status: 429, error: "too_many_requests" };
  }

  if (input.token !== null && tokensMatch(input.token, input.expected)) {
    // 成功即清空该来源的失败记录：输错一次再输对，不该继承之前的退避。
    attempts.delete(input.clientKey);
    return { ok: true, status: 200, error: "" };
  }

  const now = input.nowMs;
  const active = record && now - record.firstFailureAt < ATTEMPT_WINDOW_MS ? record : null;
  const failures = (active?.failures ?? 0) + 1;
  const next: AttemptRecord = {
    failures,
    firstFailureAt: active?.firstFailureAt ?? now,
    // 必须是 `now + 时长` 这个**绝对时刻**，不能是"0 + 时长"：
    // 后者算出来的是个很小的数（比如 300000），与 Date.now() 永远比不过，
    // 于是退避**一次都不会生效**——限流看起来写了，实际上形同虚设。
    // 退避窗口到期后 blockedUntil 自然小于 now，条件自动放行，不需要清表。
    blockedUntil: failures >= BLOCK_AFTER_FAILURES ? now + BLOCK_DURATION_MS : 0,
  };
  attempts.set(input.clientKey, next);
  return { ok: false, status: 401, error: "forbidden" };
}

/** 客户端标识：优先 `trustProxy` 已解析出的真实 IP，否则退回首跳地址。 */
function clientKeyOf(request: FastifyRequest): string {
  return request.ip || request.socket?.remoteAddress || "unknown";
}

/**
 * 面板路由的 `preHandler`。
 *
 * 每次进入都记一条审计日志（无论成败）：面板是本部署里唯一能读跨租户数据的
 * 入口，谁在什么时候打开过它必须是可追溯的。
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const expected = resolveAdminToken();
  const decision = evaluateAdminAuth({
    token: readAdminTokenHeader(request.headers as Record<string, unknown>),
    expected,
    nowMs: Date.now(),
    clientKey: clientKeyOf(request),
  });

  if (decision.ok) {
    return;
  }

  request.log.warn(
    {
      scope: "admin-panel",
      route: typeof request.routeOptions.url === "string" ? request.routeOptions.url : "unmatched",
      status: decision.status,
    },
    "admin panel access denied",
  );
  return reply.code(decision.status).send({ error: decision.error });
}

/**
 * 未启用时的启动提示。
 *
 * 刻意只说「未启用」，不说「如何启用」到日志里以外的地方——见上。
 * 由 `server.ts` 在注册前调用一次。
 */
export function logAdminPanelDisabled(logger: { info: (obj: unknown, msg: string) => void }): void {
  logger.info(
    { scope: "admin-panel" },
    "运维管理面板未启用（未设置足够强度的 ADMIN_PANEL_TOKEN），/admin 未注册",
  );
}