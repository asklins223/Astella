/**
 * 接口来源。
 *
 * 默认**同源**：开发时由 vite 的 dev proxy 转发（见 `vite.config.ts` 那份路径表），
 * 部署时把构建产物与 API 放同一个 origin，也仍然是同源。只有真的要连另一台后端时
 * 才设 `VITE_API_ORIGIN`——那时服务端必须把这一格来源加进 `CORS_ORIGIN`，
 * 那一项留空等于「不发 CORS 头」，浏览器会直接挡掉（2026-10-12 在 dev 栈实测到）。
 */
export const apiOrigin: string = (() => {
  const configured = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/+$/, '')
  if (configured) return configured
  // 测试跑在 Node 里（没有 location）：给一个明确的落点，而不是让 import 阶段就抛。
  return typeof window === 'undefined' ? 'http://127.0.0.1:4000' : window.location.origin
})()

/**
 * 会话签发时写进 `sessions.client_kind` 的身份。
 * 服务端据此拒绝手机端的笔记正文写入——判据跟着**凭据**走，不是跟着请求头走，
 * 所以拿着这个 token 直接调接口也改不了笔记。
 */
export const CLIENT_KIND = 'mobile' as const

/** 伴星这一族事件的 SSE 事件名只有一个，浏览器端要按这个名字听。 */
export const COMPANION_SSE_EVENT = 'companion'
