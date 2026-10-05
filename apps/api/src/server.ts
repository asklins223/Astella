import { agentRoutes } from "./modules/agent/routes.ts";
import { agentMethodRoutes } from "./modules/agent/method-routes.ts";
import { sql } from "drizzle-orm";
import { closeDatabase, db, dbPoolOptionsMax } from "./db/client.ts";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
import { logger } from "./lib/logger.ts";
import { runWithRequestContext } from "./lib/request-context.ts";
import { authRoutes } from "./modules/identity/routes.ts";
import { noteRoutes } from "./modules/note/routes.ts";
import { noteAnnotationRoutes } from "./modules/note-annotations/routes.ts";
import { noteOverviewRoutes } from "./modules/note-overviews/routes.ts";
import { noteRecallRoutes } from "./modules/note-recalls/routes.ts";
import { noteExpansionRoutes } from "./modules/note-expansions/routes.ts";
import { noteLearningArtifactRoutes } from "./modules/note-learning-artifacts/routes.ts";
import { noteCollaborationRoutes, closeNoteCollaboration } from "./modules/note/collaboration.ts";
import { jobRoutes } from "./modules/job/routes.ts";
import { reviewRoutes } from "./modules/review/routes.ts";
import { sourceRoutes } from "./modules/source/routes.ts";
import { importRoutes } from "./modules/import/routes.ts";
import { searchRoutes } from "./modules/search/routes.ts";
import { exportRoutes } from "./modules/export/routes.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { statsRoutes } from "./modules/stats/routes.ts";
import { activityRoutes } from "./modules/activity/routes.ts";
import { uploadRoutes } from "./modules/upload/routes.ts";
import { cardGenerationV2Routes } from "./modules/card-generation-v2/routes.ts";
import { learningObjectiveRoutes } from "./modules/learning-objectives/routes.ts";
import { noteLearningRoundRoutes } from "./modules/note-learning-rounds/routes.ts";
import { learningDashboardRoutes } from "./modules/learning-dashboard/routes.ts";
import { understandingTopologyV3Routes } from "./modules/note-deepening/routes.ts";
import { isCardGenerationV2Enabled } from "./config/learning-companion-flags.ts";
import { companionShellRoutes } from "./modules/companion-shell/index.ts";
import { learningMetricRoutes } from "./modules/observability/routes.ts";
import { companionConversationRoutes, companionConversationManagementRoutes, companionDiscoveryRoutes, companionExportRoutes, companionRunDiagnosticsRoutes, continuousHistoryRoutes } from "./modules/companion-conversation/index.ts";
import { startCompanionNotifyListener, stopCompanionNotifyListener } from "./lib/companion-notify.ts";
import { learningRunRoutes } from "./modules/learning-runs/run-routes.ts";
import { learningDisputeRoutes } from "./modules/learning-runs/disputes/run-dispute-routes.ts";
import { companionBridgeRoutes } from "./modules/companion-bridge/routes.ts";
import { companionJourneyRoutes } from "./modules/companion-journey/routes.ts";
import { understandingProjectionRoutes } from "./modules/understanding/projection-routes.ts";
import { proactiveInboxRoutes } from "./modules/companion-conversation/delivery/inbox-routes.ts";
import { deliveryRoutes } from "./modules/companion-conversation/delivery/delivery-routes.ts";
import { memoryRoutes } from "./modules/companion-conversation/memory/memory-routes.ts";
import { petProfileRoutes } from "./modules/companion-conversation/pet-profile-routes.ts";
import { companionHomeProjectionRoutes } from "./modules/companion-conversation/home-projection-routes.ts";
import { dailySummaryRoutes } from "./modules/companion-conversation/daily-summary-routes.ts";
import { deliveryTimelineRoutes } from "./modules/companion-conversation/timeline-routes.ts";
import { voiceRoutes } from "./modules/learning-sessions/voice-routes.ts";
import { adminRoutes } from "./modules/admin/routes.ts";
import { desktopTrustRoutes, resolveApiBindHost } from "./modules/desktop-trust/routes.ts";
import { cleanupExpiredSessions } from "./modules/identity/service.ts";
import { purgeSoftDeletedNotes } from "./modules/note/maintenance.ts";
import { sweepIdleNoteRoundsForPauseV1 } from "./modules/note-learning-rounds/round/round-activity-sweep.ts";
import {
  ENV_ROUND_ACTIVITY_SWEEP_INTERVAL,
  roundActivitySweepIntervalMsV1,
} from "./modules/note-learning-rounds/round/round-idle-pause-policy.ts";
import { runLearningTtlMaintenance } from "./modules/learning-sessions/ttl-maintenance.ts";
import { runLearningRunProcessingTick, setLearningRunProcessingWaker, closeStructuredSolutionSql } from "./modules/learning-runs/processing/run-processing-tick.ts";
import { createGracefulShutdown } from "./server/graceful-shutdown.ts";
import {
  QUEUE_SAMPLE_INTERVAL_MS,
  SAMPLE_INTERVAL_MS,
  sampleMetricsSeries,
} from "./lib/metrics-series.ts";
import {
  getMetricsText,
  getMetricsContentType,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpErrors5xxTotal,
  readinessStatus,
  setReleaseInfo,
  statusToClass,
  normalizeRouteTemplate,
  dbPoolActiveConnections,
  dbMigrationVersion,
  dbRlsDeniedTotal,
  dbPoolMaxConnections,
  dbServerConnectionsTotal,
} from "./lib/metrics.ts";

/**
 * DB gauge 刷新间隔（2026-10-03）。
 *
 * 原先写死 30 秒。池打满是**持续状态**，30 秒的采样周期意味着一轮短压测
 * （实测 5~6 秒）从头到尾都读不到变化——这正是"连接池是瓶颈"这件事长期
 * 在指标上不可见的原因之一。默认 5 秒，仍远大于这条查询自身耗时，且回调
 * 已有 in-flight 守卫。
 */
export function resolveDbGaugeIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw ?? 5_000);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5_000;
}

const trustProxyValue = process.env.TRUST_PROXY?.trim();
const normalizedTrustProxyValue = trustProxyValue?.toLowerCase();
const trustProxy = !trustProxyValue || normalizedTrustProxyValue === "false"
  ? false
  : normalizedTrustProxyValue === "true"
    ? true
    : /^\d+$/.test(trustProxyValue)
      // 数值跳数分支：运行时行为不变；新版 @types/fastify 将 trustProxy 收窄为
      // string | boolean | string[]，此处仅做类型桥接。
      ? Number(trustProxyValue) as unknown as boolean
      : trustProxyValue.split(",").map((value) => value.trim()).filter(Boolean);

const app = Fastify({
  loggerInstance: logger,
  // 2026-08-11（可观测性）：默认 reqId 是进程内递增计数器——多副本部署下
  // 各进程 id 相同，跨进程追踪不可用。改用随机 UUID（Node 20+ crypto.randomUUID）。
  genReqId: () => crypto.randomUUID(),
  // 不再无条件信任任意 X-Forwarded-For。默认不信任透传值；只有已覆写
  // X-Forwarded-For 的前置代理才允许部署方显式配置 TRUST_PROXY。
  trustProxy,
});

// Liveness only proves the process/event loop can answer HTTP. Database and
// schema checks belong exclusively to /ready so a transient dependency outage
// does not make the orchestrator kill an otherwise healthy API process.
app.get("/health", async () => {
  return {
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  };
});

// OPS-01: Prometheus 指标端点（ADR-0006 §1）
// 不需要认证，但应在生产环境通过网络策略限制访问（仅 Prometheus scraper 可达）。
app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", getMetricsContentType());
  return getMetricsText();
});

// 设计 P1-15（2026-09-15 审计）：把请求 id 放进 AsyncLocalStorage，供建 job 时
// 写入 payload.traceId——worker 日志因此能带上"来自哪次请求"，跨进程可关联。
// 放在最前面（onRequest 先于其它钩子），保证整条处理链都在上下文内。
app.addHook("onRequest", (request, _reply, done) => {
  runWithRequestContext(request.id, done);
});

// NFR-S（方案 16 §19.2）：全局基础安全头——API 独立服务暴露 4000，
// 与桌面客户端加载的 API 同等的防御基线。SSE 走 hijack
// （onSend 不触发），其 writeHead 已带 Content-Type/Cache-Control。
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
});

// OPS-01: HTTP 请求指标收集 hook（ADR-0006 §1）
// 在每个请求完成后记录 method、route template、status class 和延迟。
// 路由参数被规范化为模板，避免高基数和参数泄漏。
app.addHook("onResponse", async (request, reply) => {
  // 排除 /metrics 和 /health 自身，避免自我放大。
  // 2026-08-11（review 修复）：用 routeOptions.url（不含 query）而非
  // request.url 精确匹配——`/metrics?x=1` 也命中排除。
  const selfRoute = request.routeOptions.url;
  if (selfRoute === "/metrics" || selfRoute === "/health") return;
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    .includes(request.method)
    ? request.method
    : "OTHER";
  const routeTemplate = request.routeOptions.url;
  const route = typeof routeTemplate === "string" && routeTemplate.length > 0
    ? normalizeRouteTemplate(routeTemplate)
    : "unmatched";
  const statusClass = statusToClass(reply.statusCode);
  const durationSeconds = reply.elapsedTime / 1000;

  httpRequestsTotal.inc({ method, route, status_class: statusClass });
  httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
  if (statusClass === "5xx") {
    httpErrors5xxTotal.inc({ method, route });
  }
  // 2026-08-11（可观测性，review 修复）：4xx 安全事件统一在 onResponse 记录——
  // 此前放在 setErrorHandler，直接 reply.code(403/429).send() 的路径（限流、
  // switch-workspace 拒绝）不走 error handler，日志不可达。此处覆盖所有路径；
  // setErrorHandler 内的 4xx 日志已移除避免重复。
  if (reply.statusCode === 401 || reply.statusCode === 403 || reply.statusCode === 429) {
    request.log.warn({ statusCode: reply.statusCode, route }, "security event: auth/permission/rate-limit");
  }
});

// security: 未捕获异常统一脱敏（SQL/S3/provider 细节不进响应体）。
// 5xx 一律返回占位 message（细节进日志）；带 statusCode 的业务错误（4xx）
// 保留 code + 产品文案 message（各业务错误类已按产品语义构造）。
app.setErrorHandler((error, request, reply) => {
  const statusCode = Number((error as { statusCode?: unknown }).statusCode ?? 500);
  if (statusCode >= 500) {
    // 2026-08-11：URL 脱敏——request.url 含 query（可能带参数）；改记 route
    // 模板（ADR-0006），query 细节进 request.log 的完整请求日志而非 error 行。
    const routeTemplate = request.routeOptions?.url ?? "unmatched";
    // 2026-08-11（可观测性）：RLS 拒绝（Postgres error code 42501）计数——
    // 此前 dbRlsDeniedTotal 定义后从未 set，RLS 误拦完全不可见。
    const errorCode = (error as { code?: unknown }).code;
    if (errorCode === "42501") {
      // 设计 P1-15（2026-09-15 审计）：此前经动态 import 异步自增，关停窗口会丢；
      // metrics.ts 在本文件已是静态导入，直接同步自增。
      dbRlsDeniedTotal.inc();
    }
    request.log.error({ err: error, route: typeof routeTemplate === "string" ? routeTemplate : "unmatched" }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "服务器内部错误" });
  }
  const code = (error as { code?: unknown }).code;
  // 2026-08-12（错误契约审计 P2-7）：4xx message 透传加形状白名单——
  // 仅透传带短 code + 短 message 的受控业务/Fastify 错误；超长 message
  // （可能是堆栈/内部细节）一律占位，防止未来 throw 未经包装的 Error 泄漏。
  const knownErrorShape = typeof code === "string"
    && code.length > 0
    && code.length <= 64
    && error instanceof Error
    && error.message.length <= 300;
  return reply.code(statusCode).send({
    error: typeof code === "string" && code.length > 0 && code.length <= 64 ? code : "request_error",
    message: knownErrorShape ? error.message : "请求错误",
  });
});

  // 2026-08-11：默认 404 会泄漏路由路径模板（如 "Route /v2/notes/:id not found"）；
// 统一为不泄漏内部路径的中文占位。
app.setNotFoundHandler((_request, reply) => {
  return reply.code(404).send({ error: "not_found", message: "资源不存在" });
});

// 2026-08-11：server 侧全局异步兜底（与 setErrorHandler 互补——后者只覆盖
// 请求生命周期内的错误；未捕获 rejection 会直接崩进程）。
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) }, "unhandledRejection — exiting");
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
});

/**
 * QUAL-08 修复：不再硬编码表名列表，改为运行时动态查询数据库 schema 中所有表。
 * 这样新增表时无需手动维护此列表，避免遗漏导致 readiness 检查误报。
 * 仅检查核心表是否存在（通过 information_schema.tables 查询）。
 */
app.get("/ready", async (_req, reply) => {
  try {
    await db.execute(sql`SELECT 1`);
    // 动态查询当前数据库中所有 public schema 的表
    const tableRows = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const presentTables = new Set(
      tableRows.map((row) => (row as { table_name: string }).table_name),
    );
    // QUAL-08 修复：不再与硬编码列表对比，改为检查当前 LearningRun 核心表是否存在。
    const coreTables = [
      "users",
      "workspaces",
      "notes",
      "jobs",
      "sessions",
      "learning_runs",
      "learning_run_private_contracts",
      "learning_tasks",
      "learning_task_variants",
    ];
    const missingTables = coreTables.filter((table) => !presentTables.has(table));

    // Drizzle journal 的最新迁移时间戳。可通过环境变量在后续版本提升门槛，
    // 避免只存在早期核心表时 readiness 仍误报成功。
    const minimumMigrationRaw = process.env.MIN_READY_MIGRATION_CREATED_AT ?? "1786683800000";
    const minimumMigration = Number(minimumMigrationRaw);
    if (!Number.isSafeInteger(minimumMigration) || minimumMigration <= 0) {
      readinessStatus.set(0);
      return reply.code(503).send({
        status: "not_ready",
        service: "api",
        error: "MIN_READY_MIGRATION_CREATED_AT must be a positive safe integer",
        timestamp: new Date().toISOString(),
      });
    }
    const migrationRows = await db.execute(sql`
      SELECT max(created_at)::bigint AS created_at
      FROM drizzle.__drizzle_migrations
    `);
    const appliedMigration = Number(
      (migrationRows[0] as { created_at: string | number | null } | undefined)?.created_at ?? 0,
    );

    if (missingTables.length > 0 || appliedMigration < minimumMigration) {
      readinessStatus.set(0);
      return reply.code(503).send({
        status: "not_ready",
        service: "api",
        error: "business schema is incomplete — run migrations",
        missingTables,
        appliedMigration,
        requiredMigration: minimumMigration,
        timestamp: new Date().toISOString(),
      });
    }
    readinessStatus.set(1);
    return {
      status: "ready",
      service: "api",
      timestamp: new Date().toISOString(),
    };
  } catch {
    readinessStatus.set(0);
    return reply.code(503).send({
      status: "not_ready",
      service: "api",
      error: "database connection failed",
      timestamp: new Date().toISOString(),
    });
  }
});

// G-002: 包装在 async IIFE 中，使 esbuild --format=cjs 能正确构建（CJS 不支持 top-level await）
async function main() {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: allowedOrigins.length > 0,
  });

  // 提供 httpErrors（badRequest / unauthorized / notFound 等）和统一错误序列化。
  await app.register(sensible);

  // 2026-08-11（性能专项）：响应压缩——graph/export/messages/notes 等 JSON 大响应
  // 文本压缩率 >80%，显著降低带宽与传输时间（TLS 场景下压缩收益仍明显）。
  await app.register(compress, { global: true });

  // 图片上传：multipart/form-data 解析插件
  // 在流式读取阶段就拒绝超大文件，防止 OOM
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,  // 10MB — 全局上限；头像端点通过 req.file({ limits }) 单独覆写为 2MB
      files: 1,                     // 每次请求只允许 1 个文件
      fields: 3,                    // 非文件字段上限（noteId 等；CSRF token 通过 header 传递，不计入）
      fieldSize: 1024,              // 单个字段值上限
    },
  });

  // OPS-01: 设置 Release 信息（ADR-0006 §2）
  // 在启动时将版本、commit 和迁移数暴露为 Prometheus label。
  const releaseVersion = process.env.npm_package_version ?? "0.5.0";
  const releaseCommit = process.env.GIT_COMMIT ?? "unknown";
  const releaseMigrations = Number(process.env.MIGRATION_COUNT ?? "0");
  setReleaseInfo(releaseVersion, releaseCommit, releaseMigrations);

  // 2026-10-03：池上限是静态值，启动时设一次即可。有了这个分母，
  // `ailearn_db_pool_active_connections / ailearn_db_pool_max_connections`
  // 才能直接当饱和度告警——而饱和度是 postgres.js 不公开排队计数时
  // 唯一可靠的"池在排队"信号。
  dbPoolMaxConnections.set(dbPoolOptionsMax());

  await app.register(authRoutes);
  await app.register(desktopTrustRoutes);
  await app.register(noteRoutes);
  await app.register(noteAnnotationRoutes);
  await app.register(noteOverviewRoutes);
  await app.register(noteRecallRoutes);
  await app.register(noteExpansionRoutes);
  await app.register(noteLearningArtifactRoutes);
  // 笔记协同的 WS 通道：必须与 `noteRoutes` 平级注册，不能嵌在它下面——那条链顶部有
  // `preHandler: requireSession`，而 v4 的 token 在握手之后的 Auth 消息里，不在请求头上。
  await app.register(noteCollaborationRoutes);
  // §21.5：Card Generation V2 是原子 capability bundle，默认 fail-closed。
  if (isCardGenerationV2Enabled()) {
    await app.register(cardGenerationV2Routes);
  } else {
    app.log.info({ capability: "card_generation_v2" }, "card-generation-v2 disabled (CARD_GENERATION_V2_ENABLED not set)");
  }
  // Plan 23 W2/W3：Objective Surface + Dashboard 读取端点（只读；V3 已完成预上线
  // 切流，能力状态由 shared capability contract 对外投影）。
  await app.register(learningObjectiveRoutes);
  // 39d W4-5（2026-09-26）：轮次的读写入口。合同里三件事由服务端定
  // （实际用哪一版正文、三项预算、终态与冲突要带回现在那一版），所以这一层不是薄壳。
  await app.register(noteLearningRoundRoutes);
  await app.register(learningDashboardRoutes);
  await app.register(understandingTopologyV3Routes);
  await app.register(jobRoutes);
  await app.register(reviewRoutes);
  await app.register(sourceRoutes);
  await app.register(importRoutes);
  await app.register(searchRoutes);
  await app.register(exportRoutes);
  await app.register(auditRoutes);
  await app.register(statsRoutes);
  await app.register(activityRoutes);
  await app.register(uploadRoutes);
  await app.register(companionShellRoutes);
  await app.register(learningMetricRoutes);
  await app.register(companionConversationRoutes);
  await app.register(agentRoutes);
  await app.register(agentMethodRoutes);
  // 40 §7 发现簿（本人收藏的视图）。取消收藏不删原始内容，见 discovery-service 的文件头。
  await app.register(companionDiscoveryRoutes);
  await app.register(companionRunDiagnosticsRoutes);
  await app.register(continuousHistoryRoutes);
  await app.register(companionConversationManagementRoutes);
  await app.register(companionExportRoutes);
  // §11.6：启动清扫崩溃残留的临时探测音频（>1h hard cap；不阻塞启动）
  import("./modules/learning-sessions/ffprobe.ts")
    .then((m) => m.cleanupStaleTempAudio(60 * 60 * 1000, "/tmp"))
    .catch(() => {});

  // §5.4：进程级单 NOTIFY listener（conversation + account channels）——
  // SSE live 订阅的即时 wake hint；各 SSE 处理器保留 durable fallback。
  startCompanionNotifyListener(
    process.env.DATABASE_URL_API?.trim() ??
      process.env.DATABASE_URL?.trim() ??
      "postgres://ailearn:ailearn_dev@postgres:5432/ailearn",
  );
  await app.register(learningRunRoutes);
  // 39d W5-5：§14.2 的争议与更正。与 learningRunRoutes 分开注册而不是并进去，
  // 是因为它服务的是**判定的读侧与更正**（§16.25 的一半在结算那一侧），
  // 与 run 的生命周期写入不是同一条链。
  await app.register(learningDisputeRoutes);
  await app.register(companionBridgeRoutes);
  await app.register(companionJourneyRoutes);
  await app.register(understandingProjectionRoutes);
  await app.register(proactiveInboxRoutes);
  await app.register(deliveryRoutes);
  await app.register(memoryRoutes);
  await app.register(petProfileRoutes);
  await app.register(companionHomeProjectionRoutes);
  await app.register(dailySummaryRoutes);
  await app.register(deliveryTimelineRoutes);
  await app.register(voiceRoutes);

  // 运维管理面板（/admin）。未设置足够强度的 ADMIN_PANEL_TOKEN 时**不注册任何
  // 路由**（见 modules/admin/auth.ts）——不是注册了再拒绝，所以这个调用本身
  // 在默认部署下是完全 inert 的。
  await app.register(adminRoutes);

  const PORT = Number(process.env.PORT ?? 4000);
  const HOST = resolveApiBindHost();

  let dbGaugeTimer: NodeJS.Timeout | undefined;
  let metricsSeriesTimer: NodeJS.Timeout | undefined;
  let queueSeriesTimer: NodeJS.Timeout | undefined;
  let sessionCleanupTimer: NodeJS.Timeout | undefined;
  let notePurgeTimer: NodeJS.Timeout | undefined;
  let learningRunProcessingTimer: NodeJS.Timeout | undefined;
  let roundActivitySweepTimer: NodeJS.Timeout | undefined;
  // P1-10：`clearTimer` 取消不了"已经在跑"的那一轮 tick。记住在途 promise 与
  // 等它的 waiter，关停时先等它收尾，免得它在连接池关掉之后还去写库。
  // 声明放在 shutdown 之前——`drainInFlight` 闭包要用，而 shutdown 建得更早。
  let processingTickInFlight: Promise<void> | null = null;
  let processingDrainWaiters: Array<() => void> = [];

  const shutdown = createGracefulShutdown({
    clearTimer: () => {
      // F5（审计 #13）：dbGaugeTimer 也纳入关停清理，避免优雅停机期间继续每
      // 30s 发 DB gauge 查询。
      if (dbGaugeTimer) clearInterval(dbGaugeTimer);
      dbGaugeTimer = undefined;
      if (metricsSeriesTimer) clearInterval(metricsSeriesTimer);
      metricsSeriesTimer = undefined;
      if (queueSeriesTimer) clearInterval(queueSeriesTimer);
      queueSeriesTimer = undefined;
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = undefined;
      if (notePurgeTimer) clearInterval(notePurgeTimer);
      notePurgeTimer = undefined;
      if (learningRunProcessingTimer) clearInterval(learningRunProcessingTimer);
      learningRunProcessingTimer = undefined;
      if (roundActivitySweepTimer) clearInterval(roundActivitySweepTimer);
      roundActivitySweepTimer = undefined;
    },
    // 先刷协同快照再关服务器：`onStoreDocument` 是 debounce 的，反过来会把窗口里
    // 最后一段编辑连同连接一起丢掉。
    closeServer: async () => {
      await closeNoteCollaboration();
      await app.close();
    },
    // P1-10：等在途 tick 收尾。有界超时在 createGracefulShutdown 里。
    drainInFlight: async () => {
      if (!processingTickInFlight) return;
      await new Promise<void>((resolve) => {
        processingDrainWaiters.push(resolve);
        // 先注册 waiter 再复查一次，避免"刚好在这两行之间收完"时永久挂死。
        if (!processingTickInFlight) {
          const waiters = processingDrainWaiters;
          processingDrainWaiters = [];
          for (const r of waiters) r();
        }
      });
    },
    drainTimeoutMs: 15_000,
    // 2026-08-11：NOTIFY listener 连接必须显式关闭，否则进程退出挂起
    afterClose: () => {
      void closeStructuredSolutionSql();
      stopCompanionNotifyListener();
    },
    closeDatabase,
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutdown requested");
    void shutdown.shutdown(signal).catch((error) => {
      app.log.error({ err: error, signal }, "graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  // 2026-09-29（P0-9）：这一段整块从 main() 末尾**提到 app.listen() 之前**。
  //
  // 原来 `setLearningRunProcessingWaker(...)` 装在 listen 之后 200 多行处，于是
  // 冷启动窗口里 `run-routes.ts` 提交产出物后调的 `wakeLearningRunProcessing()`
  // 是**静默 no-op**（那是个模块级可变全局，没装就是没装），唤醒请求丢失，
  // 用户要等最多 10 秒的轮询周期。同一段窗口里 outbox 也完全无人消费。
  //
  // 提前到 listen 之前有两个效果：唤醒不再丢；停机期间攒下的命令在开始收流量
  // 之前就被接住。ticker 是 unref 的，不会因此把进程吊住。
  // LR-PROC-01: learning_run_processing_outbox 消费（assessment_requested →
  // 确定性评估/Fail-closed → commit_requested → canonical_unable Commit）。
  // 轮询 10s，与 commit outbox 同一节奏；失败退避同模式。
  if (!shutdown.isShuttingDown()) {
    const processingWorkerId = `run-proc:${crypto.randomUUID()}`;
    let processingIntervalMs = 10 * 1000;
    let processingFailedStreak = 0;
    let processingWakeRequested = false;

    const runProcessingTickOnce = async (): Promise<void> => {
      try {
        const result = await runLearningRunProcessingTick(processingWorkerId, 50);
        if (result.processed > 0 || result.failed > 0) {
          app.log.info({ ...result }, "learning run processing tick");
        }
        processingFailedStreak = 0;
        processingIntervalMs = 10 * 1000;
      } catch (err) {
        processingFailedStreak += 1;
        processingIntervalMs = Math.min(10 * 1000 * (2 ** processingFailedStreak), 60_000);
        app.log.error({ err, nextRetryMs: processingIntervalMs }, "learning run processing tick failed");
      }
    };

    const scheduleProcessingTick = (delayMs: number): void => {
      if (learningRunProcessingTimer) clearTimeout(learningRunProcessingTimer);
      learningRunProcessingTimer = setTimeout(() => {
        learningRunProcessingTimer = undefined;
        const inFlight = runProcessingTickOnce().then(() => {
          processingTickInFlight = null;
          // 关停已经发起就不再续下一轮：否则会对着已关的连接池再挂一个定时器，
          // 那个定时器下一次触发时拿到的 pool 已经 end 了。
          if (shutdown.isShuttingDown()) return;
          // 正在跑的这一轮里被喊过 → 不等节奏，立刻再来一轮。
          scheduleProcessingTick(processingWakeRequested ? 0 : processingIntervalMs);
          processingWakeRequested = false;
        });
        processingTickInFlight = inFlight;
        void inFlight.finally(() => {
          if (processingTickInFlight === inFlight) processingTickInFlight = null;
          // 放行所有在等这一轮收尾的 drain waiter。
          const waiters = processingDrainWaiters;
          processingDrainWaiters = [];
          for (const resolve of waiters) resolve();
        });
      }, delayMs);
      learningRunProcessingTimer.unref();
    };

    setLearningRunProcessingWaker(() => {
      if (learningRunProcessingTimer) {
        scheduleProcessingTick(0);
        return;
      }
      // 一轮正在执行中，无法重排定时器；标记下来让这轮结束后立即续跑。
      processingWakeRequested = true;
    });
    // 启动先跑一次，把停机期间攒下的命令接住。
    scheduleProcessingTick(0);
  }

  // 2026-09-29（P0-9，启动顺序竞态）：`app.listen()` 原来在**这一段之前**，
  // 也就是在 SIGTERM 处理与关停协调器装好之前就开始对外服务。后果是这个窗口里
  // 进来的 SIGTERM 走 Node 默认行为（不优雅关停），而 `shutdown` 还没建起来——
  // 编排器每次滚动更新都可能撞上。
  //
  // 现在把 listen 移到关停协调器与信号处理**之后**。下面那 4 发启动维护
  // （session 清理 / 软删物理清除 / TTL 维护 / 轮次空闲扫描）刻意**留在 listen 之后**：
  // 它们各自 try/catch 兜住了，但仍是会打库的 await，让它们挡在 listen 前面等于
  // 「库慢 → 容器一直 not ready → 被编排器杀掉」，那是用一个竞态换另一个更糟的。
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // §2.4: 清理过期 session — 启动时立即执行一次，之后每小时定时清理
  // 启动时先清理一次（进程崩溃重启后可能积累了大量过期 session）
  try {
    const deleted = await cleanupExpiredSessions();
    if (deleted > 0) {
      app.log.info({ deleted }, "expired sessions cleaned up on startup");
    }
  } catch (err) {
    app.log.error({ err }, "session cleanup on startup failed");
  }

  // 每小时定时清理
  if (!shutdown.isShuttingDown()) {
    // 2026-08-11（可观测性）：DB 池活跃连接 + 迁移版本周期 gauge——
    // 此前两个 gauge 定义后从未 set，空转。
    // 2026-10-03：口径与刷新频率都改了。见下面两条查询的注释。
    // 2026-08-11：in-flight 守卫变量（回调重叠防护，见下方注释）
    let dbGaugeRunning = false;
    // 2026-10-03：30s → 5s。原频率下"池被打满"这种持续状态只能在采样点撞上
    // 一次才看得见——实测一轮 5 秒压测期间它一直是陈旧的旧值。5s 仍远大于这条
    // 查询自身的耗时（count(*) 走 pg_stat_activity 的索引，通常 < 5ms），
    // 而且已有 in-flight 守卫兜底重叠。
    const dbGaugeIntervalMs = resolveDbGaugeIntervalMs(process.env.DB_GAUGE_INTERVAL_MS);
    dbGaugeTimer = setInterval(async () => {
      // 2026-08-11（review 修复）：in-flight 守卫——DB 慢查询时上一轮未完成
      // 则跳过本轮，避免回调重叠堆积。
      if (dbGaugeRunning) return;
      dbGaugeRunning = true;
      try {
        const [poolRow, serverRow, migRow] = await Promise.all([
          // 池饱和度：只看**本进程**的连接。此前这条查的是全库所有进程，
          // API 与 worker 的连接混在一个数里，谁也看不出自己的池有没有打满。
          // application_name 由 db/client.ts 给连接池设置（'ailearn_api'）。
          // 同时排除本连接自己，否则活跃数永远至少有 1，饱和度算不出真信号。
          db.execute(sql`
            SELECT count(*)::int AS n
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = 'ailearn_api'
              AND pid <> pg_backend_pid()
          `),
          // 全库连接数：副本数 × 池上限 对 max_connections 的预算只看这个。
          // 它是原 gauge 真正在测的东西，只是名字与它测的东西对不上。
          db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
          db.execute(sql`SELECT max(id)::int AS v FROM drizzle.__drizzle_migrations`),
        ]);
        const poolRows = poolRow as Array<Record<string, unknown>>;
        const serverRows = serverRow as Array<Record<string, unknown>>;
        const migRows = migRow as Array<Record<string, unknown>>;
        dbPoolActiveConnections.set(Number(poolRows[0]?.n ?? 0));
        dbServerConnectionsTotal.set(Number(serverRows[0]?.n ?? 0));
        dbMigrationVersion.set(Number(migRows[0]?.v ?? 0));
      } catch (err) {
        app.log.warn({ err }, "db gauges refresh failed");
      } finally {
        dbGaugeRunning = false;
      }
    }, dbGaugeIntervalMs);
    dbGaugeTimer?.unref?.();

    // 运维面板的图表数据源（/admin）。
    //
    // 与 dbGauge 分开：那一组是**给 Prometheus 抓的瞬时 gauge**，这一组是
    // **给面板画趋势的时序窗口**。两者节奏与口径都不同（15 秒 vs 5 秒），
    // 混在一起会让告警的采样语义被面板的采样需求污染。
    //
    // 启动时立刻采一次：否则面板打开后的第一个 15 分钟只有一条线。
    void sampleMetricsSeries(true);
    metricsSeriesTimer = setInterval(() => {
      void sampleMetricsSeries(false);
    }, SAMPLE_INTERVAL_MS);
    metricsSeriesTimer.unref?.();

    // 队列深度要打一次库，所以走自己的更慢节奏（30 秒 vs 15 秒）。
    queueSeriesTimer = setInterval(() => {
      void sampleMetricsSeries(true);
    }, QUEUE_SAMPLE_INTERVAL_MS);
    queueSeriesTimer.unref?.();

    sessionCleanupTimer = setInterval(async () => {
      try {
        const deleted = await cleanupExpiredSessions();
        if (deleted > 0) {
          app.log.info({ deleted }, "expired sessions cleaned up");
        }
      } catch (err) {
        app.log.error({ err }, "session cleanup failed");
      }
    }, 60 * 60 * 1000); // 1 hour
    sessionCleanupTimer.unref();
  }

  // CONC-03: 定时物理清除超过保留期（30 天）的软删除笔记
  // 启动时先执行一次，之后每 6 小时执行一次
  try {
    const purged = await purgeSoftDeletedNotes();
    if (purged > 0) {
      app.log.info({ purged }, "soft-deleted notes purged on startup");
    }
  } catch (err) {
    app.log.error({ err }, "note purge on startup failed");
  }

  // Learning Companion TTL（0076/0081/0083 承诺的清理落地）：audit/ledger
  // tombstone 化 + 已处理 outbox 与过期 nonce 删除。启动先跑一次，之后每 6 小时。
  try {
    const ttl = await runLearningTtlMaintenance();
    const touched = ttl.auditedRows + ttl.ledgerRows;
    if (touched > 0) {
      app.log.info({ ttl }, "learning TTL maintenance ran on startup");
    }
  } catch (err) {
    app.log.error({ err }, "learning TTL maintenance on startup failed");
  }

  if (!shutdown.isShuttingDown()) {
    notePurgeTimer = setInterval(async () => {
      try {
        const purged = await purgeSoftDeletedNotes();
        if (purged > 0) {
          app.log.info({ purged }, "soft-deleted notes purged");
        }
      } catch (err) {
        app.log.error({ err }, "note purge failed");
      }
      try {
        const ttl = await runLearningTtlMaintenance();
        const touched = ttl.auditedRows + ttl.ledgerRows;
        if (touched > 0) {
          app.log.info({ ttl }, "learning TTL maintenance ran");
        }
      } catch (err) {
        app.log.error({ err }, "learning TTL maintenance failed");
      }
    }, 6 * 60 * 60 * 1000); // 6 hours
    notePurgeTimer.unref();
  }

  // 39d W4-5 ④（PRD §3.2）：最后一个活跃端离开 ⇒ 把进行中的轮次标成可恢复暂停。
  // **只能服务端扫，不能让正要离开的那一端报**（39d D1 §3.1 实现记录已拍），所以这里
  // 是一条周期对账，不是任何事件钩子。总控一个常量＋一个环境变量：
  //  - `NOTE_ROUND_IDLE_PAUSE_SWEEP_MS` 未设 ⇒ 默认 60 秒（`DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS`）；
  //  - `off`／`disabled`／`none`／`0` ⇒ 关掉整条链路：既不跑启动那一发，也不建定时器，
  //    等于完全回到本刀之前的行为（`roundActivitySweepIntervalMsV1()` 返回 null 时
  //    扫描本体自己也拒绝写库，所以"关"不需要在这里再判一次）；
  //  - 坏值（非整数、比租约续租节奏还密）⇒ 回落默认，**不**让一个写错的 env 把服务拦在起不来。
  // 启动先跑一次（进程重启前留下的那一轮该由重启这一次收出来），之后按间隔跑，形状照
  // 上面 `sessionCleanupTimer`／`notePurgeTimer` 那两条。
  const roundActivitySweepIntervalMs = roundActivitySweepIntervalMsV1();
  if (roundActivitySweepIntervalMs === null) {
    app.log.info({ env: ENV_ROUND_ACTIVITY_SWEEP_INTERVAL }, "note round idle-pause sweep is off");
  } else {
    try {
      const swept = await sweepIdleNoteRoundsForPauseV1();
      if (swept.paused.length > 0) {
        app.log.info(
          { paused: swept.paused.length, scopesScanned: swept.scopesScanned },
          "idle note rounds paused on startup",
        );
      }
    } catch (err) {
      app.log.error({ err }, "note round idle-pause sweep on startup failed");
    }

    if (!shutdown.isShuttingDown()) {
      roundActivitySweepTimer = setInterval(async () => {
        try {
          const swept = await sweepIdleNoteRoundsForPauseV1();
          if (swept.paused.length > 0) {
            app.log.info(
              { paused: swept.paused.length, scopesScanned: swept.scopesScanned },
              "idle note rounds paused",
            );
          }
        } catch (err) {
          app.log.error({ err }, "note round idle-pause sweep failed");
        }
      }, roundActivitySweepIntervalMs);
      roundActivitySweepTimer.unref();
    }
  }

}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
