/**
 * 运维面板的**基础设施视图**（容器 / 数据库 / 对象存储）。
 *
 * ## 容器：为什么不引依赖
 *
 * Docker 的 API 就是一个跑在 unix socket 上的 HTTP 服务：列容器是 GET
 * `/containers/json`，操容器是 POST `/{id}/restart`，日志是 GET
 * `/{id}/logs`。为这几条请求引入 dockerode 不划算，直接用 `node:http` 的
 * `socketPath` 发请求即可——顺带也没有版本漂移与依赖审计的负担。
 *
 * ## 只碰"自己这套栈"的容器
 *
 * 挂载 docker socket 等于把宿主机的 root 权限交给了这个容器，而宿主机上
 * 可能跑着别的项目。所以：
 *   - **能力自证**：用 `HOSTNAME`（容器里就是自己的短 id）inspect 自己，
 *     从 compose 标签读出项目名；只列出、也只允许操作**同一个 compose 项目**
 *     下的容器。列表为空、标签读不到时不猜——退回"未接入"，不列全宿主机。
 *   - **动作白名单**：start / stop / restart 三个动词，逐个服务解析真实 id，
 *     绝不接受调用方传来的容器 id。
 *   - **留痕**：每个动作写一条服务日志（跨租户操作不进 workspace 审计表）。
 *   - **默认关闭**：`ADMIN_DOCKER_SOCKET` 未设置就整个视图显示"未接入"，
 *     生产 compose 默认不挂 socket（见 .env.example 的说明）。
 *
 * ## 数据库与对象存储
 *
 * Postgres 走本进程已有的连接池（版本 / 大小 / 连接数 / 最大的表），对象
 * 存储走与业务同一份凭证做 HeadBucket 探测——面板看到的"能不能用"就是业务
 * 侧真实的可用性，而不是另配一套探测口径。
 */

import { request } from "node:http";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { isStorageConfigured, probeStorageBucket } from "../../lib/object-storage.ts";

/* ── Docker over unix socket ───────────────────────────────────────────── */

/** 未设置 = 容器视图未接入（默认如此；dev compose 显式挂载）。 */
function socketPath(): string | null {
  const raw = process.env.ADMIN_DOCKER_SOCKET?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function isDockerConfigured(): boolean {
  return socketPath() !== null;
}

interface DockerResponse {
  status: number;
  body: Buffer;
}

function dockerRequest(method: string, path: string, { timeoutMs = 4000, body }: { timeoutMs?: number; body?: string } = {}): Promise<DockerResponse> {
  const socket = socketPath();
  if (!socket) return Promise.reject(new Error("docker_socket_unset"));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method, timeout: timeoutMs, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("docker_timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dockerJson<T>(method: string, path: string, options?: { timeoutMs?: number; body?: string }): Promise<T> {
  const response = await dockerRequest(method, path, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`docker_http_${response.status}`);
  }
  return JSON.parse(response.body.toString("utf8")) as T;
}

export interface ContainerView {
  /** compose 服务名（面板上作为稳定标识）。 */
  service: string;
  /** 容器名（含 compose 前缀），展示用。 */
  name: string;
  image: string;
  /** running | exited | created | restarting | paused | dead */
  state: string;
  /** docker healthcheck 的结果：healthy | unhealthy | starting | none。 */
  health: "healthy" | "unhealthy" | "starting" | "none";
  /** 人类可读的运行时长或退出说明。 */
  statusText: string;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  ports: string[];
  /** 是不是面板自己所在的容器（重启它会断开当前页面）。 */
  isSelf: boolean;
  /**
   * 状态分级（面板与左栏徽标共用一处判据）：
   *   ok   —— running 且健康（或没有 healthcheck）；exited 且退出码 0
   *   warn —— 正在重启 / created / paused
   *   bad  —— 不健康，或非零退出
   */
  tone: "ok" | "warn" | "bad";
  /** 一次性任务（migrate / init / seed）退出码 0：显示"已完成"而不是"已退出"。 */
  completion: boolean;
}

interface DockerContainerSummary {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
}

interface DockerContainerInspect {
  Id: string;
  Name?: string;
  Config?: { Image?: string; Labels?: Record<string, string>; Hostname?: string };
  State?: {
    Status?: string;
    StartedAt?: string;
    ExitCode?: number;
    RestartCount?: number;
    Health?: { Status?: string };
  };
  NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
}

let selfProjectCache: { value: string | null } | null = null;

/** 从自己的容器标签读出 compose 项目名；读不到就是 null（不猜）。 */
async function resolveSelfProject(): Promise<string | null> {
  if (selfProjectCache) return selfProjectCache.value;
  try {
    const selfId = (process.env.HOSTNAME ?? "").trim();
    if (!selfId) {
      selfProjectCache = { value: null };
      return null;
    }
    const self = await dockerJson<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(selfId)}/json`);
    const project = self.Config?.Labels?.["com.docker.compose.project"] ?? null;
    selfProjectCache = { value: project };
    return project;
  } catch {
    selfProjectCache = { value: null };
    return null;
  }
}

function formatPorts(ports: DockerContainerInspect["NetworkSettings"]): string[] {
  const map = ports?.Ports ?? {};
  const out: string[] = [];
  for (const [containerPort, hostBindings] of Object.entries(map)) {
    if (!hostBindings || hostBindings.length === 0) continue;
    for (const binding of hostBindings) {
      out.push(`${binding.HostIp ?? "0.0.0.0"}:${binding.HostPort ?? "?"} → ${containerPort}`);
    }
  }
  return out.slice(0, 8);
}

/** 人类可读的起始时刻（"3 分 22 秒前启动"交给前端；这里给 ISO）。 */
function normalizeHealth(state: DockerContainerInspect["State"]): ContainerView["health"] {
  const status = state?.Health?.Status;
  if (status === "healthy" || status === "unhealthy" || status === "starting") return status;
  return "none";
}

/** 容器状态 → 面板语气。判据集中在这里，视图与徽标不各写一份。 */
export function containerTone(container: Pick<ContainerView, "state" | "health" | "exitCode">): ContainerView["tone"] {
  if (container.state === "running") {
    if (container.health === "unhealthy") return "bad";
    if (container.health === "starting") return "warn";
    return "ok";
  }
  if (container.state === "exited") return (container.exitCode ?? 0) === 0 ? "ok" : "bad";
  if (container.state === "restarting") return "warn";
  return "warn";
}

export interface DockerView {
  available: boolean;
  /** 未接入的原因（面板直接展示）。 */
  reason: string | null;
  project: string | null;
  containers: ContainerView[];
}

export async function readContainers(): Promise<DockerView> {
  if (!isDockerConfigured()) {
    return {
      available: false,
      reason: "未挂载 Docker socket（ADMIN_DOCKER_SOCKET 未设置）。容器状态与操作在这一部署里不可用。",
      project: null,
      containers: [],
    };
  }
  const project = await resolveSelfProject();
  if (!project) {
    return {
      available: false,
      reason: "读不到本容器的 compose 项目标签（HOSTNAME 或 socket 不可用），为避免误列/误操作宿主机上的其它容器，这里不展示任何容器。",
      project: null,
      containers: [],
    };
  }

  try {
    const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    const list = await dockerJson<DockerContainerSummary[]>("GET", `/containers/json?all=1&filters=${filter}`);
    const selfId = (process.env.HOSTNAME ?? "").trim();

    const containers = await Promise.all(list.map(async (summary): Promise<ContainerView | null> => {
      const service = summary.Labels?.["com.docker.compose.service"];
      if (!service) return null; // 只认 compose 起的容器
      try {
        const info = await dockerJson<DockerContainerInspect>("GET", `/containers/${summary.Id}/json`);
        const state = info.State ?? {};
        return {
          service,
          name: (summary.Names?.[0] ?? info.Name ?? summary.Id.slice(0, 12)).replace(/^\//, ""),
          image: summary.Image ?? info.Config?.Image ?? "",
          state: state.Status ?? summary.State ?? "unknown",
          health: normalizeHealth(state),
          statusText: summary.Status ?? "",
          startedAt: state.StartedAt && !state.StartedAt.startsWith("0001-") ? state.StartedAt : null,
          exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
          restartCount: state.RestartCount ?? 0,
          ports: formatPorts(info.NetworkSettings),
          isSelf: summary.Id.startsWith(selfId) && selfId.length > 0,
          tone: containerTone({ state: state.Status ?? "unknown", health: normalizeHealth(state), exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null }),
          completion: state.Status === "exited" && (state.ExitCode ?? 0) === 0,
        };
      } catch {
        // 单个容器 inspect 失败不该让整页消失：用列表里的粗粒度信息顶上。
        return {
          service,
          name: (summary.Names?.[0] ?? summary.Id.slice(0, 12)).replace(/^\//, ""),
          image: summary.Image ?? "",
          state: summary.State ?? "unknown",
          health: "none",
          statusText: summary.Status ?? "",
          startedAt: null,
          exitCode: null,
          restartCount: 0,
          ports: [],
          isSelf: summary.Id.startsWith(selfId) && selfId.length > 0,
          tone: containerTone({ state: summary.State ?? "unknown", health: "none", exitCode: null }),
          completion: summary.State === "exited",
        };
      }
    }));

    const ordered = containers
      .filter((item): item is ContainerView => item !== null)
      .sort((a, b) => a.service.localeCompare(b.service));
    return { available: true, reason: null, project, containers: ordered };
  } catch (error) {
    return {
      available: false,
      reason: `Docker API 读取失败：${error instanceof Error ? error.message : String(error)}`,
      project,
      containers: [],
    };
  }
}

/** 找到某个 compose 服务对应的容器 id；不在本项目里就是 null（不问就拒）。 */
async function resolveServiceContainer(service: string): Promise<{ id: string; isSelf: boolean } | null> {
  const view = await readContainers();
  if (!view.available) return null;
  const found = view.containers.find((container) => container.service === service);
  if (!found) return null;
  // readContainers 里已经只包含本项目的容器；这里再取一次完整 id。
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${service}`] }));
  try {
    const list = await dockerJson<DockerContainerSummary[]>("GET", `/containers/json?all=1&filters=${filter}`);
    const own = list.find((item) => item.Labels?.["com.docker.compose.project"] === view.project);
    if (!own) return null;
    return { id: own.Id, isSelf: found.isSelf };
  } catch {
    return null;
  }
}

export class InfraActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InfraActionError";
    this.code = code;
  }
}

/** 允许的容器动作。白名单在服务层与路由层各收一次。 */
export type ContainerAction = "start" | "stop" | "restart";

export async function runContainerAction(service: string, action: ContainerAction): Promise<{ service: string; action: ContainerAction }> {
  if (!(action === "start" || action === "stop" || action === "restart")) {
    throw new InfraActionError("invalid_action", "不支持的操作");
  }
  if (!isDockerConfigured()) {
    throw new InfraActionError("docker_unavailable", "这个部署没有接入 Docker（未挂载 socket）");
  }
  const target = await resolveServiceContainer(service);
  if (!target) {
    throw new InfraActionError("unknown_service", `不是本项目里的服务：${service}`);
  }
  // 重启比 start/stop 慢（默认 10s 优雅期），给足超时；stop/start 也留 15s。
  const response = await dockerRequest("POST", `/containers/${target.id}/${action}?t=10`, { timeoutMs: 20_000 });
  if (response.status < 200 || response.status >= 300) {
    throw new InfraActionError("docker_error", `Docker 返回 ${response.status}`);
  }
  // 跨租户的运维动作不进 workspace 审计表：这条服务日志就是事后唯一记录。
  logger.info({ scope: "admin-infra", service, action, isSelf: target.isSelf }, `运维面板对容器执行了 ${action}`);
  return { service, action };
}

/* ── 日志（多路复用流的拆帧 + 兜底）────────────────────────────────────── */

/**
 * 拆 Docker 日志流。
 *
 * 非 TTY 容器的日志是**多路复用**的：每帧 8 字节头（streamType + 3 空 + 4 字节大端长度）
 * 再加负载。TTY 容器直接是裸文本——两种都得认，所以先验证帧头是否合理
 * （streamType ≤ 2 且长度不越界），不合理就整段当文本返回。
 */
export function demuxDockerLogs(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const type = buffer[0];
  const firstSize = buffer.length >= 8 ? buffer.readUInt32BE(4) : Number.NaN;
  const looksMultiplexed = type <= 2 && Number.isFinite(firstSize) && firstSize <= buffer.length - 8;
  if (!looksMultiplexed) return buffer.toString("utf8");

  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    parts.push(buffer.subarray(start, end).toString("utf8"));
    offset = end;
    if (size === 0) break;
  }
  return parts.join("");
}

/** 剥掉 ANSI 转义序列：dev 下容器标准输出是 pino-pretty 的彩色文本，
 *  面板里显示成 `[35mreqId[39m` 只会是噪音。 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export interface ContainerLogs {
  service: string;
  /** 已按行切分（去掉尾部空行），最多 tail 行。 */
  lines: string[];
  truncated: boolean;
}

export async function readContainerLogs(service: string, tail = 200): Promise<ContainerLogs> {
  if (!isDockerConfigured()) {
    throw new InfraActionError("docker_unavailable", "这个部署没有接入 Docker（未挂载 socket）");
  }
  const target = await resolveServiceContainer(service);
  if (!target) {
    throw new InfraActionError("unknown_service", `不是本项目里的服务：${service}`);
  }
  const limit = Math.max(10, Math.min(500, Math.floor(tail)));
  const response = await dockerRequest(
    "GET",
    `/containers/${target.id}/logs?stdout=1&stderr=1&timestamps=0&tail=${limit}`,
    { timeoutMs: 6000 },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new InfraActionError("docker_error", `Docker 返回 ${response.status}`);
  }
  const text = stripAnsi(demuxDockerLogs(response.body));
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { service, lines: lines.slice(-limit), truncated: lines.length > limit };
}

/* ── 单容器资源用量 ───────────────────────────────────────────────────── */

export interface ContainerStats {
  service: string;
  /** CPU 百分比（相对单核的 100% × 核数）。 */
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}

interface DockerStatsRaw {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
}

/** docker stats 的 CPU% 口径（与 `docker stats` 命令一致）：两次采样差比 × 核数。 */
export function computeCpuPercent(raw: DockerStatsRaw): number | null {
  const cpuTotal = raw.cpu_stats?.cpu_usage?.total_usage;
  const preCpuTotal = raw.precpu_stats?.cpu_usage?.total_usage;
  const system = raw.cpu_stats?.system_cpu_usage;
  const preSystem = raw.precpu_stats?.system_cpu_usage;
  if (typeof cpuTotal !== "number" || typeof preCpuTotal !== "number"
    || typeof system !== "number" || typeof preSystem !== "number") return null;
  const cpuDelta = cpuTotal - preCpuTotal;
  const systemDelta = system - preSystem;
  if (systemDelta <= 0 || cpuDelta < 0) return null;
  const cores = raw.cpu_stats?.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

export async function readContainerStats(service: string): Promise<ContainerStats> {
  if (!isDockerConfigured()) {
    throw new InfraActionError("docker_unavailable", "这个部署没有接入 Docker（未挂载 socket）");
  }
  const target = await resolveServiceContainer(service);
  if (!target) {
    throw new InfraActionError("unknown_service", `不是本项目里的服务：${service}`);
  }
  // 不加 `one-shot=1`：它会让 precpu_stats 为空，CPU 差分成不了（恒为 null）。
  // 单次 stats 由 daemon 缓存的上一个采样点做差分，与 `docker stats --no-stream` 同口径。
  const raw = await dockerJson<DockerStatsRaw>("GET", `/containers/${target.id}/stats?stream=false`, { timeoutMs: 6000 });
  const usage = raw.memory_stats?.usage;
  const inactive = raw.memory_stats?.stats?.inactive_file ?? 0;
  return {
    service,
    cpuPercent: computeCpuPercent(raw),
    // 与 docker stats 同口径：usage 减去 inactive_file（页缓存不算占用）。
    memoryBytes: typeof usage === "number" ? Math.max(0, usage - inactive) : null,
    memoryLimitBytes: typeof raw.memory_stats?.limit === "number" ? raw.memory_stats.limit : null,
  };
}

/* ── Postgres ──────────────────────────────────────────────────────────── */

export interface DatabaseView {
  ok: boolean;
  error: string | null;
  version: string | null;
  startedAt: string | null;
  databaseSizeBytes: number | null;
  connections: { active: number; max: number } | null;
  largestTables: Array<{ name: string; bytes: number }>;
}

export async function readDatabaseView(): Promise<DatabaseView> {
  try {
    const base = (await db.execute(sql`
      SELECT
        current_setting('server_version') AS version,
        pg_postmaster_start_time() AS started_at,
        pg_database_size(current_database()) AS size_bytes,
        (SELECT count(*)::int FROM pg_stat_activity) AS active,
        current_setting('max_connections')::int AS max_connections
    `)) as unknown as Array<Record<string, unknown>>;
    const row = base[0] ?? {};

    const tables = (await db.execute(sql`
      SELECT relname AS name, pg_total_relation_size(relid) AS bytes
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 5
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      ok: true,
      error: null,
      version: typeof row.version === "string" ? row.version : null,
      startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
      databaseSizeBytes: Number.isFinite(Number(row.size_bytes)) ? Number(row.size_bytes) : null,
      connections: {
        active: Number(row.active ?? 0),
        max: Number(row.max_connections ?? 0),
      },
      largestTables: tables.map((table) => ({
        name: String(table.name ?? ""),
        bytes: Number(table.bytes ?? 0),
      })),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      version: null,
      startedAt: null,
      databaseSizeBytes: null,
      connections: null,
      largestTables: [],
    };
  }
}

/* ── 对象存储 ──────────────────────────────────────────────────────────── */

export interface StorageView {
  configured: boolean;
  endpoint: string | null;
  bucket: string | null;
  /** HeadBucket 的结果：能不能真的读写（凭证 + 桶都在）。 */
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

export async function readStorageView(): Promise<StorageView> {
  const endpoint = process.env.STORAGE_ENDPOINT?.trim() || process.env.S3_ENDPOINT?.trim() || null;
  const bucket = process.env.S3_BUCKET?.trim() || null;
  if (!isStorageConfigured()) {
    return { configured: false, endpoint, bucket, reachable: false, latencyMs: null, error: "对象存储配置不完整" };
  }
  const started = Date.now();
  try {
    await probeStorageBucket();
    return { configured: true, endpoint, bucket, reachable: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    return {
      configured: true,
      endpoint,
      bucket,
      reachable: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
