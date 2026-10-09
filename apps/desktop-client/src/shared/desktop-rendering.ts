/** Device-local rendering preference; applied by main before Chromium starts. */
export const DESKTOP_RENDERING_GET_CHANNEL = 'desktop-rendering:get'
export const DESKTOP_RENDERING_SET_CHANNEL = 'desktop-rendering:set'
export const DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL = 'desktop-rendering:report-failure'
export const DESKTOP_RENDERING_STATE_CHANNEL = 'desktop-rendering:state-changed'

export type DesktopRenderingMode = 'default' | 'compatible'
export type DesktopRenderingFailure = 'gpu-process-failed' | 'webgl-context-lost'

export interface DesktopRenderingState {
  readonly supported: boolean
  readonly configuredMode: DesktopRenderingMode
  readonly activeMode: DesktopRenderingMode
  readonly restartRequired: boolean
  /** A concrete graphics failure saved compatible mode for the next launch. */
  readonly automaticFallbackReason: DesktopRenderingFailure | null
}

export interface DesktopRenderingApi {
  getState(): Promise<DesktopRenderingState>
  setMode(mode: DesktopRenderingMode): Promise<DesktopRenderingState>
  reportGraphicsFailure(reason: 'webgl-context-lost'): Promise<DesktopRenderingState>
  onStateChanged(listener: (state: DesktopRenderingState) => void): () => void
}

export function isDesktopRenderingMode(value: unknown): value is DesktopRenderingMode {
  return value === 'default' || value === 'compatible'
}

export function isDesktopRenderingFailure(value: unknown): value is DesktopRenderingFailure {
  return value === 'gpu-process-failed' || value === 'webgl-context-lost'
}

export function isDesktopRenderingState(value: unknown): value is DesktopRenderingState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return typeof state.supported === 'boolean' && isDesktopRenderingMode(state.configuredMode)
    && isDesktopRenderingMode(state.activeMode) && typeof state.restartRequired === 'boolean'
    && (state.automaticFallbackReason === null || isDesktopRenderingFailure(state.automaticFallbackReason))
}
