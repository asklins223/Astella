/* ============================================================
   运维面板 · 格式化
   ------------------------------------------------------------
   所有给「人」看的数字都从这里出去：口径写在函数里，视图层不再各写一份。

   两条贯穿全文件的判断：
   1. **占位符「—」不是读数**。null / NaN 一律返回「—」，由调用方决定
      要不要降低它的视觉权重（不是读数就不该用读数的字号）。
   2. **单位跟着量级走**。耗时在毫秒级说毫秒，速率在 <1 时保留两位小数——
      「198ms」与「<1 秒」信息量差着一个量级，口径必须贴住数据本身。
   ============================================================ */

export function formatRate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (n === 0) return "0 次/分";
  if (n < 1) return `${n.toFixed(2)} 次/分`;
  if (n < 10) return `${n.toFixed(1)} 次/分`;
  return `${Math.round(n)} 次/分`;
}

/** 速率但省掉单位（KPI 大字里单位单独排）。 */
export function formatRateValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (n === 0) return "0";
  if (n < 1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return String(Math.round(n));
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const s = Math.max(0, Number(seconds));
  if (s < 1) return "<1 秒";
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时`;
}

/** 延迟读数：绝大多数在几十~几百毫秒，套「<1 秒」会把全部信息丢掉。 */
export function formatLatency(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const n = Number(seconds);
  if (n < 1) return `${Math.round(n * 1000)} ms`;
  return formatDuration(n);
}

/** 毫秒数（访问日志的 durationMs 已经是毫秒）。 */
export function formatMs(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(Number(milliseconds))) return "—";
  const n = Number(milliseconds);
  if (n < 1000) return `${n.toFixed(n < 10 ? 1 : 0)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return "—";
  const n = Number(bytes);
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return "—";
  const n = Number(ratio);
  return `${(n * 100).toFixed(n >= 0.9995 || n === 0 ? 0 : 2)}%`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString("zh-CN");
}

export function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN");
}

export function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatClock(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 相对时间：运维读「3 分钟前」比读时间戳快，超过一天退回时间戳。 */
export function formatAgo(iso, now = Date.now()) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return formatDateTime(iso);
}

/** 按图表的 unit 口径把数值说成人话。 */
export function formatByUnit(value, unit) {
  switch (unit) {
    case "rate": return formatRate(value);
    case "duration": return formatLatency(value);
    case "bytes": return formatBytes(value);
    default: return formatCount(value);
  }
}

/** 长数字压成紧凑形（KPI 大字旁的小注）：12345 → 1.2万。 */
export function formatCompact(value) {
  return formatNumber(value);
}
