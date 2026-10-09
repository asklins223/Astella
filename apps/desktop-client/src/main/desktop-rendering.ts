import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { App, Details, Event, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_RENDERING_GET_CHANNEL,
  DESKTOP_RENDERING_SET_CHANNEL,
  DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL,
  DESKTOP_RENDERING_DISMISS_SUGGESTION_CHANNEL,
  isDesktopRenderingFailure,
  isDesktopRenderingMode,
  type DesktopRenderingFailure,
  type DesktopRenderingMode,
  type DesktopRenderingState,
} from '../shared/desktop-rendering'

/**
 * macOS users reported whole-window flashing on scroll, resolved by an OS
 * update. That implicates the OS/GPU path but does not identify a driver bug.
 * Keep Chromium's defaults, with a manually selected fallback on macOS (also
 * offered after a concrete graphics failure). Electron 43 / Chromium 150 uses
 * GraphiteDawnMetal by default; --disable-skia-graphite selects GaneshGL via
 * ANGLE Metal instead. GPU compositing, rasterization and Live2D WebGL remain
 * accelerated.
 *
 * A graphics failure only earns a suggestion. Switching the backend on a process
 * exit is a guess, and the fallback is not measurably cheaper — on this M4 the
 * two backends came out within noise of each other — so it never flips itself on.
 *
 * This must be constructed before app.whenReady(), not when settings opens.
 */
export class DesktopRenderingPreferences {
  private configuredMode: DesktopRenderingMode = 'default'
  private readonly activeMode: DesktopRenderingMode
  private readonly supported: boolean
  private suggestedFallbackReason: DesktopRenderingFailure | null = null
  private readonly listeners = new Set<(state: DesktopRenderingState) => void>()

  constructor(
    private readonly path: string,
    app: { readonly commandLine: Pick<App['commandLine'], 'appendSwitch'> },
    platform: NodeJS.Platform = process.platform,
  ) {
    this.supported = platform === 'darwin'
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof value === 'object' && value !== null
        && 'version' in value && value.version === 1
        && 'mode' in value && isDesktopRenderingMode(value.mode)) {
        this.configuredMode = value.mode
        if ('suggestedFallbackReason' in value
          && isDesktopRenderingFailure(value.suggestedFallbackReason)) {
          this.suggestedFallbackReason = value.suggestedFallbackReason
        }
      }
    } catch {
      // Missing or damaged preferences must never prevent app startup.
    }
    this.activeMode = this.supported ? this.configuredMode : 'default'
    if (this.activeMode === 'compatible') {
      app.commandLine.appendSwitch('disable-skia-graphite')
    }
  }

  getState(): DesktopRenderingState {
    return {
      supported: this.supported,
      configuredMode: this.configuredMode,
      activeMode: this.activeMode,
      restartRequired: this.supported && this.configuredMode !== this.activeMode,
      suggestedFallbackReason: this.suggestedFallbackReason,
    }
  }

  setMode(mode: unknown): DesktopRenderingState {
    if (!this.supported || !isDesktopRenderingMode(mode)) {
      throw new Error('Unsupported rendering mode')
    }
    // Choosing either way answers the suggestion, so it must not linger behind.
    if (mode === this.configuredMode) {
      return this.suggestedFallbackReason === null ? this.getState() : this.persist(mode, null)
    }
    return this.persist(mode, null)
  }

  recordGraphicsFailure(reason: unknown): DesktopRenderingState {
    if (!isDesktopRenderingFailure(reason)) throw new Error('Unsupported graphics failure')
    // Nothing to offer while the fallback is already running or already pending,
    // and a suggestion already on disk should not be overwritten by a later cause.
    if (!this.supported || this.configuredMode === 'compatible' || this.suggestedFallbackReason !== null) {
      return this.getState()
    }
    return this.persist(this.configuredMode, reason)
  }

  dismissFallbackSuggestion(): DesktopRenderingState {
    if (this.suggestedFallbackReason === null) return this.getState()
    return this.persist(this.configuredMode, null)
  }

  subscribe(listener: (state: DesktopRenderingState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private persist(mode: DesktopRenderingMode, reason: DesktopRenderingFailure | null): DesktopRenderingState {
    // Publish only after the preference reached disk. A failed write must not
    // show a saved switch, and a torn write must not replace the last preference.
    mkdirSync(dirname(this.path), { recursive: true })
    const pending = `${this.path}.tmp`
    writeFileSync(pending, `${JSON.stringify({ version: 1, mode,
      ...(reason ? { suggestedFallbackReason: reason } : {}),
    })}\n`, { mode: 0o600 })
    renameSync(pending, this.path)
    this.configuredMode = mode
    this.suggestedFallbackReason = reason
    const state = this.getState()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* A notification failure cannot undo a saved preference. */ }
    }
    return state
  }
}

/** Register before ready, so GPU failures during startup are captured too. */
export function registerDesktopRenderingHealthMonitor(
  app: Pick<App, 'on' | 'removeListener'>,
  preferences: DesktopRenderingPreferences,
  trace: (message: string) => void,
): () => void {
  let quitting = false
  const onQuit = () => { quitting = true }
  const onProcessGone = (_event: Event, details: Details) => {
    if (details.type !== 'GPU' || quitting) return
    trace(`gpu-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    if (!['crashed', 'abnormal-exit', 'oom', 'launch-failed'].includes(details.reason)) return
    try {
      const previous = preferences.getState()
      const current = preferences.recordGraphicsFailure('gpu-process-failed')
      if (previous.suggestedFallbackReason !== current.suggestedFallbackReason) trace('rendering-fallback-suggested; user decides')
    } catch {
      trace('rendering-fallback-suggestion save-failed')
    }
  }
  app.on('child-process-gone', onProcessGone)
  // before-quit can be cancelled by an unsaved document; will-quit is later.
  app.on('will-quit', onQuit)
  return () => {
    app.removeListener('child-process-gone', onProcessGone)
    app.removeListener('will-quit', onQuit)
  }
}

/** Only the app's main document may read or write the device preference. */
export function registerDesktopRenderingIpc(
  ipc: Pick<IpcMain, 'handle'>,
  preferences: DesktopRenderingPreferences,
  isAppWindow: (event: IpcMainInvokeEvent) => boolean,
): void {
  const authorize = (event: IpcMainInvokeEvent) => {
    if (!isAppWindow(event) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Rendering preferences require the app main frame')
    }
  }
  ipc.handle(DESKTOP_RENDERING_GET_CHANNEL, event => {
    authorize(event)
    return preferences.getState()
  })
  ipc.handle(DESKTOP_RENDERING_SET_CHANNEL, (event, mode: unknown) => {
    authorize(event)
    return preferences.setMode(mode)
  })
  ipc.handle(DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL, (event, reason: unknown) => {
    authorize(event)
    // Native GPU process failures must originate in main, not renderer input.
    if (reason !== 'webgl-context-lost') throw new Error('Unsupported renderer graphics failure')
    return preferences.recordGraphicsFailure(reason)
  })
  ipc.handle(DESKTOP_RENDERING_DISMISS_SUGGESTION_CHANNEL, (event) => {
    authorize(event)
    return preferences.dismissFallbackSuggestion()
  })
}
