/**
 * 运维管理面板（`/admin/*`）。
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
  readPlatformCounts,
  readQueueBacklog,
  readRecentAudit,
  readRecentFailures,
  runJobAction,
} from "./ops-service.ts";
import { readTodo } from "./todo-service.ts";
import { adminLogBuffer, type LogLevelName } from "../../lib/log-buffer.ts";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(__dirname, "static");

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
};

/**
 * 面板的全部静态资源。
 *
 * 逐个列出而不是挂一个静态目录：新增文件必须在这里显式出现，
 * 否则它要么打不开（漏注册）要么被无意暴露（漏审查）。
 */
const STATIC_FILES: Array<{ route: string; file: string; type: string }> = [
  { route: "/admin", file: "index.html", type: STATIC_TYPES[".html"] },
  { route: "/admin/", file: "index.html", type: STATIC_TYPES[".html"] },
  { route: "/admin/app.js", file: "app.js", type: STATIC_TYPES[".js"] },
  { route: "/admin/charts.js", file: "charts.js", type: STATIC_TYPES[".js"] },
  { route: "/admin/styles.css", file: "styles.css", type: STATIC_TYPES[".css"] },
];

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

  const serveStatic = (filename: string, contentType: string) => async (_request: unknown, reply: {
    type: (value: string) => { send: (body: string | Buffer) => unknown };
  }) => {
    const body = await readFile(join(STATIC_ROOT, filename));
    return reply.type(contentType).send(body);
  };

  for (const { route, file, type } of STATIC_FILES) {
    app.get(route, serveStatic(file, type));
  }

  // ─── 数据接口：一条都要令牌 ────────────────────────────────────────────
  //
  // 单独开一个子作用域来挂 `requireAdmin`，而不是在本作用域上挂一个
  // 「按路径判断」的钩子：路径判断会在将来新增文件时被漏掉一次，
  // 而漏掉的后果是**新端点默认公开**。作用域把边界钉在结构上。
  await app.register(async (api) => {
    api.addHook("onRequest", requireAdmin);

  // ─── 概览 ────────────────────────────────────────────────────────────

  api.get("/admin/api/overview", async (_request, reply) => {
    const config = await readConfigSnapshot();
    return reply.send(await readOverview(config.path, config.exists));
  });

  // ─── 指标 ────────────────────────────────────────────────────────────

  api.get("/admin/api/metrics", async (_request, reply) => {
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
  api.get("/admin/api/metrics/series", async (_request, reply) => {
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

  // 日志用自己的上界，**不复用 limitQuery（200）**：
  // 环形缓冲的容量是 500，而搜索要的是"在完整缓冲里找"——
  // 只搜最近 200 条时，关键词命中的那条会随着新日志盖上来而凭空消失，
  // 那比搜不到更让人困惑。上界与 buffer.capacity 对齐（recent() 也夹 500）。
  const logsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    level: z.enum(LOG_LEVELS).optional(),
  });

  api.get("/admin/api/logs", async (request, reply) => {
    const query = logsQuery.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "日志查询参数非法");
    return reply.send({
      entries: adminLogBuffer.recent({
        limit: query.data.limit ?? 100,
        minLevel: query.data.level as LogLevelName | undefined,
      }),
      capacity: adminLogBuffer.capacity,
      size: adminLogBuffer.size,
      /** 说明这段数据的性质：进程内最近窗口，不是完整日志。 */
      scope: "in-process ring buffer (not persisted)",
    });
  });

  // ─── 队列 / 审计 / 计数 ─────────────────────────────────────────────

  /**
   * 首屏待办。**首屏的纲**：它回答「我现在该做什么」，而不是「读数是多少」。
   * 每个条目都带一个真实可执行的动作（见 todo-service.ts 的模块注释）。
   */
  api.get("/admin/api/todo", async (_request, reply) => {
    return reply.send(await readTodo());
  });

  /**
   * 执行队列操作（重试失败 / 清理死信）。
   *
   * 边界：只碰 `failed` / `dead`、必须指定作业类型、单次上界 500 ——
   * 全部钉在 0366 的 SECURITY DEFINER 函数里，服务层再收一次参数校验。
   * 绝不支持「全部类型一把梭」：跨全部空间的批量操作影响面不可控。
   */
  api.post("/admin/api/jobs/actions", async (request, reply) => {
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

  api.get("/admin/api/queues", async (_request, reply) => {
    const [backlog, failures, counts] = await Promise.all([
      readQueueBacklog(),
      readRecentFailures(20),
      readPlatformCounts(),
    ]);
    return reply.send({
      ...backlog,
      // byType 的人话名已在 service 层译好（readQueueBacklog），这里不再重复映射。
      byType: backlog.byType,
      recentFailures: failures.map((row) => ({
        ...row,
        label: JOB_TYPE_LABELS[row.jobType] ?? row.jobType,
        statusLabel: JOB_STATUS_LABELS[row.status] ?? row.status,
      })),
      counts,
    });
  });

  api.get("/admin/api/audit", async (request, reply) => {
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

  // ─── 配置读写 ───────────────────────────────────────────────────────

  api.get("/admin/api/config", async (_request, reply) => {
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

  api.put("/admin/api/config", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(reply, 400, "bad_request", "请求体必须是配置对象");
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
