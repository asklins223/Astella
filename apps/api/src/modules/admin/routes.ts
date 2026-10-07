/**
 * 运维管理面板（默认挂在 `/admin`，可用 `ADMIN_PANEL_PATH` 换成随机前缀）。
 *
 * ## 挂载路径可混淆
 *
 * `ADMIN_PANEL_PATH`（如 `/panel-6b3f9c2d`）把静态壳与全部数据接口整体
 * 挪到一个不好猜的前缀下。它是**降低扫描噪声**，不是鉴权：真正的边界仍然
 * 是 `ADMIN_PANEL_TOKEN` 与 requireAdmin。未设置时回落 `/admin` 并记一条
 * 提示日志；形状非法（带大写、`..`、连续斜杠）同样回落到 `/admin`。
 *
 * ## fail closed 的实现方式
 *
 * `ADMIN_PANEL_TOKEN` 未设置（或弱于下限）时，{@link adminRoutes} **不注册任何
 * 路由**并直接返回。见 `auth.ts` 的模块注释——「注册了再拒绝」与「不注册」
 * 在可被扫描的资产面上是两件不同的事。
 *
 * ## 静态资源与 CSP
 *
 * 面板的 HTML/CSS/JS 全部由本服务以独立文件提供，**没有内联脚本或内联样式**。
 * 这不是为了洁癖：`/admin` 是本部署里唯一能读跨租户数据的页面，给它配
 * `default-src 'none'; script-src 'self'; style-src 'self'` 之后，即使某天有人
 * 在 JSON 响应里找到一个能注入的属性并写进 innerHTML，也无法执行——
 * 注入面留在 DOM 里，出不了脚本。
 *
 * ## 认证覆盖范围
 *
 * `onRequest` 而非 `preHandler`：静态资源也在保护范围内。用 preHandler 时
 * Fastify 已经完成了路由匹配与参数解析，白白让未授权请求走到那里。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isAdminPanelEnabled, logAdminPanelDisabled, requireAdmin } from "./auth.ts";
import { ConfigWriteError, readConfigSnapshot, writeConfig } from "./config-service.ts";
import { readMetricsSnapshot } from "./metrics-service.ts";
import { readOverview } from "./overview-service.ts";
import {
  AdminActionError,
  groupFailures,
  readPlatformCounts,
  readQueueBacklog,
  readRecentAudit,
  readRecentFailures,
  runJobAction,
} from "./ops-service.ts";
import { readTodo } from "./todo-service.ts";
import {
  InfraActionError,
  readContainerLogs,
  readContainerStats,
  readContainers,
  readDatabaseView,
  readStorageView,
  runContainerAction,
} from "./infra-service.ts";
import {
  adminLogBuffer,
  adminRequestLogBuffer,
  type LogLevelName,
} from "../../lib/log-buffer.ts";
import { adminMetricsSeries, SAMPLE_INTERVAL_MS } from "../../lib/metrics-series.ts";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_LABELS,
  CAPABILITY_KIND_LABELS,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  METRIC_SERIES_META,
} from "./labels.ts";
import { logger } from "../../lib/logger.ts";

// 这一行在**模块顶层**求值，所以"取不到自己所在目录"不是延后失败，是导入即崩。
//
// 2026-10-05 实测：生产镜像的 CMD 是 `node dist/server.cjs`，而构建是
// `esbuild --format=cjs` —— CJS 里 `import.meta` 是空的，于是
// `fileURLToPath(undefined)` 抛 ERR_INVALID_ARG_TYPE，容器启动即崩、进入 crash-loop。
// dev 阶段跑的是 `npm run dev`（tsx 走 src，ESM，`import.meta.url` 有值），所以
// 本地怎么试都是好的，只有真实产物会炸。
//
// 两边都成立的那一份目录：ESM 用 `import.meta.url`，CJS 用它自带的 `__dirname`。
// `typeof` 对未声明标识符求值不会抛，所以这一行在 ESM 下也是安全的。
const moduleDir = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(moduleDir, "static");

/** 面板自身的 CSP。无内联资源，所以 `script-src 'self'` 就够。 */
const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

/**
 * 面板的全部静态资源。
 *
 * 逐个列出而不是挂一个静态目录：新增文件必须在这里显式出现，
 * 否则它要么打不开（漏注册）要么被无意暴露（漏审查）。
 */
const STATIC_FILES: Array<{ path: string; file: string; type: string }> = [
  // path 是相对挂载前缀的部分；"" 是面板首页（同时注册带尾斜杠的等价路由）。
  { path: "", file: "index.html", type: STATIC_TYPES[".html"] },
  { path: "/app.js", file: "app.js", type: STATIC_TYPES[".js"] },
  { path: "/ui.js", file: "ui.js", type: STATIC_TYPES[".js"] },
  { path: "/api-client.js", file: "api-client.js", type: STATIC_TYPES[".js"] },
  { path: "/format.js", file: "format.js", type: STATIC_TYPES[".js"] },
  { path: "/charts.js", file: "charts.js", type: STATIC_TYPES[".js"] },
  { path: "/views/shared.js", file: "views/shared.js", type: STATIC_TYPES[".js"] },
  { path: "/views/overview.js", file: "views/overview.js", type: STATIC_TYPES[".js"] },
  { path: "/views/queues.js", file: "views/queues.js", type: STATIC_TYPES[".js"] },
  { path: "/views/logs.js", file: "views/logs.js", type: STATIC_TYPES[".js"] },
  { path: "/views/metrics.js", file: "views/metrics.js", type: STATIC_TYPES[".js"] },
  { path: "/views/config.js", file: "views/config.js", type: STATIC_TYPES[".js"] },
  { path: "/views/infra.js", file: "views/infra.js", type: STATIC_TYPES[".js"] },
  { path: "/styles.css", file: "styles.css", type: STATIC_TYPES[".css"] },
  { path: "/assets/astella-mark-v1.png", file: "assets/astella-mark-v1.png", type: STATIC_TYPES[".png"] },
];

/**
 * 解析面板挂载前缀。非法形状或未设置时回落 `/admin`（并留一条日志）。
 *
 * 纯函数（实参形式）便于测试；默认读 `process.env`。
 */
export function resolveAdminPath(raw: string | undefined = process.env.ADMIN_PANEL_PATH): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) return "/admin";
  if (!/^\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(value)) {
    logger.warn({ scope: "admin-panel", value }, "ADMIN_PANEL_PATH 形状非法（小写字母/数字/连字符，不能含 ..），回落 /admin");
    return "/admin";
  }
  return value.replace(/\/+$/, "");
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const limitQuery = z.coerce.number().int().min(1).max(200).optional();

/** 统一的响应封装：所有面板端点都不回显异常细节。 */
function fail(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string) {
  return reply.code(status).send({ error: code, message });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  if (!isAdminPanelEnabled()) {
    logAdminPanelDisabled(logger);
    return;
  }

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Content-Security-Policy", ADMIN_CSP);
    reply.header("Cache-Control", "no-store");
  });

  // ─── 静态壳：公开 ────────────────────────────────────────────────────
  //
  // 这里的三个文件是**外壳**：一个登录框，加上把它画出来的 CSS/JS。
  // 它们不含任何数据——没有指标、没有配置、没有日志、没有密钥。
  //
  // 它们**必须**公开，否则面板无法使用：浏览器第一次打开 `/admin` 时手里
  // 没有令牌，如果外壳也要令牌，拿到的是一段 `{"error":"forbidden"}` JSON，
  // 而**登录框正好在这段 HTML 里面**——于是人永远看不到输入令牌的地方，
  // 被挡在门外。这不是安全，是把自己锁死。
  //
  // 真正的边界在下面的 `/admin/api/*`：跨空间的队列、审计、配置与密钥状态
  // 全在那里，一条都要令牌。

  const base = resolveAdminPath();
  if (base === "/admin") {
    logger.warn({ scope: "admin-panel" }, "面板挂在默认 /admin；建议设置 ADMIN_PANEL_PATH（如 /panel-$(openssl rand -hex 4)）降低扫描噪声");
  }

  const serveStatic = (filename: string, contentType: string) => async (_request: unknown, reply: {
    type: (value: string) => { send: (body: string | Buffer) => unknown };
  }) => {
    // Binary assets must stay binary: UTF-8 decoding corrupts the brand PNG.
    if (!contentType.startsWith("text/") && !contentType.startsWith("image/svg")) {
      return reply.type(contentType).send(await readFile(join(STATIC_ROOT, filename)));
    }
    const raw = await readFile(join(STATIC_ROOT, filename), "utf8");
    // 首页里的资源地址与前端请求前缀都由这里注入：面板整体可以搬家，
    // 静态文件不用跟着改。
    const body = filename === "index.html" ? raw.replaceAll("__BASE__", base) : raw;
    return reply.type(contentType).send(body);
  };

  for (const entry of STATIC_FILES) {
    app.get(`${base}${entry.path}`, serveStatic(entry.file, entry.type));
    if (entry.path === "") app.get(`${base}/`, serveStatic(entry.file, entry.type));
  }

  // ─── 数据接口：一条都要令牌 ────────────────────────────────────────────
  //
  // 单独开一个子作用域来挂 `requireAdmin`，而不是在本作用域上挂一个
  // 「按路径判断」的钩子：路径判断会在将来新增文件时被漏掉一次，
  // 而漏掉的后果是**新端点默认公开**。作用域把边界钉在结构上。
  await app.register(async (api) => {
    api.addHook("onRequest", requireAdmin);
    const apiBase = `${base}/api`;

  // ─── 概览 ────────────────────────────────────────────────────────────

  api.get(`${apiBase}/overview`, async (_request, reply) => {
    const config = await readConfigSnapshot();
    return reply.send(await readOverview(config.path, config.exists));
  });

  // ─── 指标 ────────────────────────────────────────────────────────────

  api.get(`${apiBase}/metrics`, async (_request, reply) => {
    return reply.send(await readMetricsSnapshot());
  });

  /**
   * 图表数据源。与 `/admin/api/metrics` 分开是因为**口径不同**：
   * 那个是「此刻的累计值」，这个是「最近窗口的时序」。
   *
   * `series` 每一项自带 `label` / `hint` / `unit` —— **服务端给文案**。
   * 放在服务端是因为这套说法要跟指标的采集口径绑在一起：改了采样方式
   * （比如 p95 从全站改成按路由）对应的中文说明也要跟着改，
   * 两边分开放就会漂。
   */
  api.get(`${apiBase}/metrics/series`, async (_request, reply) => {
    const points = adminMetricsSeries.recent();
    return reply.send({
      points,
      /** 实际覆盖的跨度（毫秒）。窗口没攒满时用这个而不是标称窗口。 */
      spanMs: adminMetricsSeries.spanMs,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      series: METRIC_SERIES_META,
    });
  });

  // ─── 日志 ────────────────────────────────────────────────────────────
  //
  // 应用日志与请求日志是**两条独立的有界环**（见 log-buffer.ts 模块头）：
  // 这里读应用日志；/logs/requests 读投影后的访问日志；/logs/stream 把新
  // 应用日志以 SSE 推给面板。

  // 日志用自己的上界，**不复用 limitQuery（200）**：
  // 环形缓冲的容量是 500，而搜索要的是"在完整缓冲里找"——
  // 只搜最近 200 条时，关键词命中的那条会随着新日志盖上来而凭空消失，
  // 那比搜不到更让人困惑。上界与 buffer.capacity 对齐（recent() 也夹 500）。
  const logsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    level: z.enum(LOG_LEVELS).optional(),
  });

  api.get(`${apiBase}/logs`, async (request, reply) => {
    const query = logsQuery.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "日志查询参数非法");
    return reply.send({
      entries: adminLogBuffer.recent({
        limit: query.data.limit ?? 200,
        minLevel: query.data.level as LogLevelName | undefined,
      }),
      capacity: adminLogBuffer.capacity,
      size: adminLogBuffer.size,
      /** 说明这段数据的性质：进程内最近窗口，不是完整日志。 */
      scope: "in-process ring buffer (not persisted)",
    });
  });

  const requestsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(300).optional(),
    /** 只看 4xx/5xx。访问日志最常见的用法就是「刚才哪个请求炸了」。 */
    onlyProblems: z.enum(["1", "0", "true", "false"]).optional(),
  });

  api.get(`${apiBase}/logs/requests`, async (request, reply) => {
    const query = requestsQuery.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "请求日志查询参数非法");
    const onlyProblems = query.data.onlyProblems === "1" || query.data.onlyProblems === "true";
    const entries = adminRequestLogBuffer.recent({ limit: query.data.limit ?? 150 });
    const filtered = onlyProblems
      ? entries.filter((entry) => {
          const status = entry.fields.statusCode;
          return typeof status === "number" && status >= 400;
        })
      : entries;
    return reply.send({
      entries: filtered,
      capacity: adminRequestLogBuffer.capacity,
      size: adminRequestLogBuffer.size,
      onlyProblems,
      scope: "completed requests only (in-process ring buffer)",
    });
  });

  /**
   * 实时推送（SSE）：应用日志 + 请求完成事件。
   *
   * 客户端用 **fetch 流**而不是 EventSource 消费：EventSource 不能带
   * Authorization 头，令牌只能塞 query string——那会把它留在访问日志与浏览器
   * 历史里。fetch + ReadableStream 保住 Bearer 鉴权，代价是 40 行的解析。
   *
   * 两条事件流共用一条连接：`event: log` 是应用日志的实时尾随，
   * `event: req` 是访问日志（实时表）。访问日志的"每条请求"在 dev 下也只有
   * 个位数量级，不值得为它再开一条连接。
   *
   * `reply.hijack()` 之后 Fastify 不再管这个响应（onSend 里那套 CSP 不适用，
   * 对事件流本来也不需要），因此头部与生命周期清理都要自己来。客户端的
   * 断开以 socket 的 close 事件为准——SSE 没有请求体，收不到别的信号。
   */
  api.get(`${apiBase}/logs/stream`, async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // nginx 之类的缓冲代理会把 SSE 攒成一次性响应；显式关掉。
      "X-Accel-Buffering": "no",
    });
    raw.write("retry: 3000\n\n");

    const write = (event: string, entry: unknown) => {
      // 慢客户端保护：socket 攒了超过 1MB 未写出就跳过这条，而不是把内存
      // 无限堆在进程里。丢的是"最新几条"而不是连接本身。
      if (raw.writableEnded || raw.writableLength > 1_000_000) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(entry)}\n\n`);
    };

    const unsubscribeLogs = adminLogBuffer.subscribe((entry) => write("log", entry));
    const unsubscribeRequests = adminRequestLogBuffer.subscribe((entry) => write("req", entry));

    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribeLogs();
      unsubscribeRequests();
    };
    request.raw.on("close", cleanup);
    raw.on("close", cleanup);
    return reply;
  });

  // ─── 队列 / 审计 / 计数 ─────────────────────────────────────────────

  /**
   * 首屏待办。**首屏的纲**：它回答「我现在该做什么」，而不是「读数是多少」。
   * 每个条目都带一个真实可执行的动作（见 todo-service.ts 的模块注释）。
   */
  api.get(`${apiBase}/todo`, async (_request, reply) => {
    return reply.send(await readTodo());
  });

  /**
   * 执行队列操作（重试失败 / 清理死信）。
   *
   * 边界：只碰 `failed` / `dead`、必须指定作业类型、单次上界 500 ——
   * 全部钉在 0366 的 SECURITY DEFINER 函数里，服务层再收一次参数校验。
   * 绝不支持「全部类型一把梭」：跨全部空间的批量操作影响面不可控。
   */
  api.post(`${apiBase}/jobs/actions`, async (request, reply) => {
    const parsed = z.object({
      jobType: z.string().trim().min(1).max(64),
      action: z.enum(["retry", "purge"]),
      limit: z.number().int().min(1).max(500).optional(),
    }).safeParse(request.body ?? {});
    if (!parsed.success) {
      return fail(reply, 400, "bad_request", "操作参数非法（需要 jobType 与 action）");
    }
    try {
      const result = await runJobAction(parsed.data);
      return reply.send(result);
    } catch (error) {
      if (error instanceof AdminActionError) {
        return fail(reply, 400, error.code, error.message);
      }
      logger.error({ scope: "admin-panel", err: error }, "运维面板执行队列操作失败");
      return fail(reply, 500, "internal_error", "操作失败，细节见服务日志");
    }
  });

  api.get(`${apiBase}/queues`, async (_request, reply) => {
    const [backlog, failures, counts] = await Promise.all([
      readQueueBacklog(),
      // 一次取满函数上界（200）：失败清单既要给「按原因聚合」用，也要给展开后
      // 的样例行用。只取 20 条时聚合出来的原因分布是失真的。
      readRecentFailures(200),
      readPlatformCounts(),
    ]);
    const withLabels = <T extends { jobType: string; status: string }>(row: T) => ({
      ...row,
      label: JOB_TYPE_LABELS[row.jobType] ?? row.jobType,
      statusLabel: JOB_STATUS_LABELS[row.status] ?? row.status,
    });
    return reply.send({
      ...backlog,
      // byType 的人话名已在 service 层译好（readQueueBacklog），这里不再重复映射。
      byType: backlog.byType,
      // 聚合与样例行同源（同一批 200 条），面板上两处数字不会打架。
      failureGroups: groupFailures(failures).map((group) => ({
        ...group,
        label: JOB_TYPE_LABELS[group.jobType] ?? group.jobType,
        statusLabel: JOB_STATUS_LABELS[group.status] ?? group.status,
        sample: withLabels(group.sample),
      })),
      recentFailures: failures.map(withLabels),
      counts,
    });
  });

  api.get(`${apiBase}/audit`, async (request, reply) => {
    const query = z.object({ limit: limitQuery }).safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "审计查询参数非法");
    const entries = await readRecentAudit(query.data.limit ?? 50);
    return reply.send({
      entries: entries.map((row) => ({
        ...row,
        label: AUDIT_ACTION_LABELS[row.action] ?? row.action,
        targetLabel: AUDIT_TARGET_LABELS[row.targetKind] ?? row.targetKind,
      })),
    });
  });

  // ─── 基础设施（容器 / 数据库 / 对象存储）──────────────────────────────
  //
  // Docker 能力由 `ADMIN_DOCKER_SOCKET` 决定：未设置就返回 available:false，
  // 面板显示"未接入"而不是报错。服务的白名单在 service 层（只认本 compose
  // 项目里的容器），路由层只做参数形状校验。

  /** compose 服务名的形状；与 compose 的命名规则一致。 */
  const serviceName = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

  api.get(`${apiBase}/infra`, async (_request, reply) => {
    const [docker, database, storage] = await Promise.all([
      readContainers(),
      readDatabaseView(),
      readStorageView(),
    ]);
    return reply.send({ docker, database, storage });
  });

  api.get(`${apiBase}/infra/containers/:service/logs`, async (request, reply) => {
    const params = z.object({ service: serviceName }).safeParse(request.params);
    const query = z.object({ tail: z.coerce.number().int().min(10).max(500).optional() }).safeParse(request.query ?? {});
    if (!params.success || !query.success) return fail(reply, 400, "bad_request", "服务名或 tail 非法");
    try {
      return reply.send(await readContainerLogs(params.data.service, query.data.tail ?? 200));
    } catch (error) {
      if (error instanceof InfraActionError) return fail(reply, 400, error.code, error.message);
      return fail(reply, 500, "internal_error", "读取容器日志失败");
    }
  });

  api.get(`${apiBase}/infra/containers/:service/stats`, async (request, reply) => {
    const params = z.object({ service: serviceName }).safeParse(request.params);
    if (!params.success) return fail(reply, 400, "bad_request", "服务名非法");
    try {
      return reply.send(await readContainerStats(params.data.service));
    } catch (error) {
      if (error instanceof InfraActionError) return fail(reply, 400, error.code, error.message);
      return fail(reply, 500, "internal_error", "读取容器用量失败");
    }
  });

  /**
   * 容器操作（start / stop / restart）。
   *
   * 挂载 docker socket 等于把宿主机的 root 权限交给服务进程，所以边界按
   * 「只碰自己这套栈」钉死：动作用白名单动词、目标按 compose 服务名解析，
   * 不接受容器 id。每个动作都会留下一条服务日志。
   */
  api.post(`${apiBase}/infra/containers/:service/action`, async (request, reply) => {
    const params = z.object({ service: serviceName }).safeParse(request.params);
    const body = z.object({ action: z.enum(["start", "stop", "restart"]) }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return fail(reply, 400, "bad_request", "服务名或动作非法");
    try {
      return reply.send(await runContainerAction(params.data.service, body.data.action));
    } catch (error) {
      if (error instanceof InfraActionError) return fail(reply, 400, error.code, error.message);
      logger.error({ scope: "admin-infra", err: error }, "容器操作失败");
      return fail(reply, 500, "internal_error", "容器操作失败，细节见服务日志");
    }
  });

  // ─── 配置读写 ───────────────────────────────────────────────────────

  api.get(`${apiBase}/config`, async (_request, reply) => {
    const snapshot = await readConfigSnapshot();
    return reply.send({
      ...snapshot,
      platforms: snapshot.platforms.map((platform) => ({
        ...platform,
        usedByCapabilities: platform.usedByCapabilities.map(
          (capability) => CAPABILITY_KIND_LABELS[capability] ?? capability,
        ),
      })),
      capabilities: snapshot.capabilities.map((capability) => ({
        ...capability,
        label: CAPABILITY_KIND_LABELS[capability.capability] ?? capability.capability,
      })),
    });
  });

  /**
   * 保存配置改动。请求体是**补丁**（platforms / capabilities / tts 的子集），
   * 服务端把它合并到磁盘上的现状——理由见 config-service.ts 的 writeConfig：
   * 整文件替换会把面板看不见的明文密钥抹掉。
   */
  api.put(`${apiBase}/config`, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(reply, 400, "bad_request", "请求体必须是配置补丁对象（platforms / capabilities / tts）");
    }
    try {
      const result = await writeConfig(body);
      return reply.send(result);
    } catch (error) {
      if (error instanceof ConfigWriteError) {
        // 409 而不是 400：配置本身可能合法，是**当前环境**不接受写入
        // （生产 compose 的 :ro 挂载）。让前端据此切换到只读态而不是重试。
        const status = error.code === "config_read_only" ? 409 : 400;
        return fail(reply, status, error.code, error.message);
      }
      logger.error({ scope: "admin-config", err: error }, "写入 AI 平台配置失败");
      return fail(reply, 500, "internal_error", "写入配置失败，细节见服务日志");
    }
  });
  });
}
