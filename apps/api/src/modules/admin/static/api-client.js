/* ============================================================
   运维面板 · 数据层
   ------------------------------------------------------------
   两部分：
   1. api() —— Bearer 鉴权的 JSON 请求。已验证的令牌保存在本标签页的
      sessionStorage，刷新后重新验证再恢复；锁定/失效时清除，不落 localStorage。
   2. openEventStream() —— 用 fetch + ReadableStream 消费 SSE。
      不用 EventSource：它不能带 Authorization 头，令牌只能塞 query
      string，那会把它留在访问日志与浏览器历史里。
   ============================================================ */

/**
 * 接口基址从模块自身的位置推出来（`<挂载前缀>/api-client.js` → `<挂载前缀>/api`）。
 * 面板整体挂在 `ADMIN_PANEL_PATH` 下，前端不写死 /admin/api，搬家不用改代码。
 */
const API_BASE = new URL("./api", import.meta.url).pathname;
const SESSION_KEY = `astella:admin-session:${API_BASE}`;

let token = null;

export function setToken(value) {
  token = value;
}

export function hasToken() {
  return Boolean(token);
}

/** Reading a remembered credential does not authenticate it; startup must verify it. */
export function readSessionToken() {
  try { return globalThis.sessionStorage.getItem(SESSION_KEY)?.trim() || null; }
  catch { return null; /* Storage may be disabled; ordinary sign-in still works. */ }
}

/** Called only after the deployment accepts the credential. */
export function rememberSessionToken() {
  if (!token) return;
  try { globalThis.sessionStorage.setItem(SESSION_KEY, token); }
  catch { /* Keep the current in-memory session usable when storage is unavailable. */ }
}

export function forgetSessionToken() {
  token = null;
  try { globalThis.sessionStorage.removeItem(SESSION_KEY); }
  catch { /* A storage failure must not prevent locking the current page. */ }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      // Bearer 而不是自定义头：省掉一次 CORS 预检，也让 curl/脚本写法一致。
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401 || response.status === 404) {
    // 404 也当"令牌不对"：面板未启用时所有端点都是 404，回退到闸是唯一合理动作。
    throw new ApiError("令牌无效，或该部署未启用运维面板。", { status: response.status, code: "unauthorized" });
  }
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    let code = "";
    try {
      const body = await response.json();
      if (body?.message) detail = body.message;
      if (body?.error) code = body.error;
    } catch {
      /* 响应体不是 JSON，保留默认说明 */
    }
    throw new ApiError(detail, { status: response.status, code });
  }
  return response.json();
}

/* ── SSE（fetch 流）────────────────────────────────────── */

/**
 * 打开实时事件流。
 *
 * 事件有两类：`log`（应用日志）与 `req`（请求完成一行）。
 *
 * 断线自动重连（指数退避，上限 15 秒）。**不用 Last-Event-ID**：缓冲是
 * 有界窗口，重连后调用方本来就该重新拉一次 recent 再按 seq 去重——两种
 * 补偿机制并存只会让"缺了哪一段"更难判断。
 *
 * @returns { close(): void }
 */
export function openEventStream({ onLog, onRequest, onState } = {}) {
  let closed = false;
  let controller = null;
  let retryDelay = 1000;
  let retryTimer = null;

  function scheduleReconnect() {
    if (closed) return;
    onState?.("reconnecting");
    retryTimer = setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, 15_000);
      connect();
    }, retryDelay);
  }

  async function connect() {
    if (closed) return;
    controller = new AbortController();
    let response;
    try {
      response = await fetch(`${API_BASE}/logs/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch {
      scheduleReconnect();
      return;
    }
    if (!response.ok || !response.body) {
      // 401 不重试：调用方会走锁定路径，重连没有意义。
      if (response.status === 401 || response.status === 404) {
        onState?.("unauthorized");
        return;
      }
      scheduleReconnect();
      return;
    }

    retryDelay = 1000;
    onState?.("connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；保留最后一段（可能不完整）。
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue; // 心跳注释
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const payload = JSON.parse(data);
            if (event === "log") onLog?.(payload);
            else if (event === "req") onRequest?.(payload);
          } catch {
            /* 半个 JSON 不可能出现在这里（帧已验证），但解析失败不该断流 */
          }
        }
      }
    } catch {
      /* 连接中断（网络/服务重启）走重连 */
    }
    if (!closed) scheduleReconnect();
  }

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      controller?.abort();
      onState?.("closed");
    },
  };
}
