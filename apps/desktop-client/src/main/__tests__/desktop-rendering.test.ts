import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App, IpcMain, IpcMainInvokeEvent } from 'electron'
import { DesktopRenderingPreferences, registerDesktopRenderingHealthMonitor, registerDesktopRenderingIpc } from '../desktop-rendering'
import { DESKTOP_RENDERING_GET_CHANNEL, DESKTOP_RENDERING_SET_CHANNEL, DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL } from '../../shared/desktop-rendering'

let directory: string
let path: string
const appendSwitch = vi.fn()
const app = { commandLine: { appendSwitch } }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'astella-rendering-test-'))
  path = join(directory, 'rendering.json')
  appendSwitch.mockClear()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('device rendering preferences', () => {
  it('keeps Chromium defaults on a healthy device', () => {
    expect(new DesktopRenderingPreferences(path, app, 'darwin').getState()).toEqual({
      supported: true, configuredMode: 'default', activeMode: 'default', restartRequired: false,
      automaticFallbackReason: null,
    })
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('persists a selection but applies the GPU switch only on the next launch', () => {
    const current = new DesktopRenderingPreferences(path, app, 'darwin')
    expect(current.setMode('compatible')).toEqual({
      supported: true, configuredMode: 'compatible', activeMode: 'default', restartRequired: true,
      automaticFallbackReason: null,
    })
    expect(appendSwitch).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, mode: 'compatible' })
    expect(new DesktopRenderingPreferences(path, app, 'darwin').getState().restartRequired).toBe(false)
    expect(appendSwitch.mock.calls).toEqual([['disable-skia-graphite']])
  })

  it('supports reverting a pending change and returning to defaults after restart', () => {
    const current = new DesktopRenderingPreferences(path, app, 'darwin')
    current.setMode('compatible')
    expect(current.setMode('default').restartRequired).toBe(false)
    current.setMode('compatible')
    const next = new DesktopRenderingPreferences(path, app, 'darwin')
    expect(next.setMode('default').activeMode).toBe('compatible')
    expect(next.getState().restartRequired).toBe(true)
    appendSwitch.mockClear()
    expect(new DesktopRenderingPreferences(path, app, 'darwin').getState().activeMode).toBe('default')
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it.each(['broken json', '{"version":2,"mode":"compatible"}', '{"version":1,"mode":"disable-gpu"}'])('can start with an invalid preference: %s', content => {
    writeFileSync(path, content)
    expect(new DesktopRenderingPreferences(path, app, 'darwin').getState().activeMode).toBe('default')
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('does not change GPU settings on %s', platform => {
    writeFileSync(path, '{"version":1,"mode":"compatible"}')
    const prefs = new DesktopRenderingPreferences(path, app, platform)
    expect(prefs.getState()).toMatchObject({ supported: false, activeMode: 'default', restartRequired: false })
    expect(() => prefs.setMode('compatible')).toThrow()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('rejects untrusted IPC values without changing the preference', () => {
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    for (const value of [null, {}, true, 'disable-gpu', 'compatible\n--no-sandbox']) {
      expect(() => prefs.setMode(value)).toThrow()
    }
    expect(prefs.getState().configuredMode).toBe('default')
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('does not acknowledge a preference when the atomic write fails', () => {
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    mkdirSync(path)
    expect(() => prefs.setMode('compatible')).toThrow()
    expect(prefs.getState()).toMatchObject({ configuredMode: 'default', restartRequired: false })
  })

  it('allows the app main frame but rejects subframes and foreign windows', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, mode?: unknown) => unknown>()
    const handle = vi.fn<IpcMain['handle']>((channel, listener) => { handlers.set(channel, listener) })
    const isAppWindow = vi.fn(() => true)
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    registerDesktopRenderingIpc({ handle }, prefs, isAppWindow)
    const frame = {}
    const event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const read = handlers.get(DESKTOP_RENDERING_GET_CHANNEL)!
    const write = handlers.get(DESKTOP_RENDERING_SET_CHANNEL)!
    const report = handlers.get(DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL)!
    expect(read(event)).toEqual(prefs.getState())
    expect(write(event, 'compatible')).toMatchObject({ configuredMode: 'compatible', restartRequired: true })
    for (const senderFrame of [{}, null]) {
      const child = { ...event, senderFrame } as IpcMainInvokeEvent
      expect(() => read(child)).toThrow(/main frame/)
      expect(() => write(child, 'default')).toThrow(/main frame/)
      expect(() => report(child, 'webgl-context-lost')).toThrow(/main frame/)
    }
    isAppWindow.mockReturnValue(false)
    expect(() => read(event)).toThrow(/main frame/)
    expect(() => write(event, 'default')).toThrow(/main frame/)
    expect(() => report(event, 'webgl-context-lost')).toThrow(/main frame/)
    expect(prefs.getState().configuredMode).toBe('compatible')
  })

  it('automatically persists a graphics failure and applies the fallback on the next launch', () => {
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    const changed = vi.fn(() => expect(JSON.parse(readFileSync(path, 'utf8')).mode).toBe('compatible'))
    prefs.subscribe(changed)
    expect(prefs.recordGraphicsFailure('webgl-context-lost')).toMatchObject({
      configuredMode: 'compatible', activeMode: 'default', restartRequired: true,
      automaticFallbackReason: 'webgl-context-lost',
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(appendSwitch).not.toHaveBeenCalled()
    prefs.recordGraphicsFailure('gpu-process-failed')
    expect(changed).toHaveBeenCalledOnce()
    const restarted = new DesktopRenderingPreferences(path, app, 'darwin')
    expect(restarted.getState()).toMatchObject({ activeMode: 'compatible', restartRequired: false, automaticFallbackReason: 'webgl-context-lost' })
    expect(appendSwitch).toHaveBeenCalledWith('disable-skia-graphite')
    restarted.setMode('default')
    expect(restarted.getState().automaticFallbackReason).toBeNull()
    restarted.recordGraphicsFailure('gpu-process-failed')
    expect(restarted.getState().configuredMode).toBe('default')
    expect(new DesktopRenderingPreferences(path, app, 'darwin').getState().activeMode).toBe('default')
  })

  it('does not overwrite a pending manual selection or create unsupported-platform preferences', () => {
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    prefs.setMode('compatible')
    expect(prefs.recordGraphicsFailure('gpu-process-failed').automaticFallbackReason).toBeNull()
    const unsupported = new DesktopRenderingPreferences(join(directory, 'unsupported.json'), app, 'win32')
    expect(unsupported.recordGraphicsFailure('webgl-context-lost').configuredMode).toBe('default')
    expect(() => prefs.recordGraphicsFailure('slow-frame')).toThrow()
  })

  it('never publishes an automatic fallback when persistence fails and can retry later', () => {
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    const changed = vi.fn()
    const unsubscribe = prefs.subscribe(changed)
    mkdirSync(path)
    expect(() => prefs.recordGraphicsFailure('gpu-process-failed')).toThrow()
    expect(changed).not.toHaveBeenCalled()
    expect(prefs.getState()).toMatchObject({ configuredMode: 'default', automaticFallbackReason: null })
    rmSync(path, { recursive: true })
    prefs.recordGraphicsFailure('gpu-process-failed')
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
    prefs.setMode('default')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('only accepts renderer context-loss reports from the trusted main document', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, reason?: unknown) => unknown>()
    const handle = vi.fn<IpcMain['handle']>((channel, listener) => { handlers.set(channel, listener) })
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    registerDesktopRenderingIpc({ handle }, prefs, () => true)
    const frame = {}
    const event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const report = handlers.get(DESKTOP_RENDERING_REPORT_FAILURE_CHANNEL)!
    for (const reason of ['gpu-process-failed', 'slow-frame', null, {}]) expect(() => report(event, reason)).toThrow()
    expect(report(event, 'webgl-context-lost')).toMatchObject({ configuredMode: 'compatible', automaticFallbackReason: 'webgl-context-lost' })
  })
})

describe('automatic GPU health monitoring', () => {
  it.each(['crashed', 'abnormal-exit', 'oom', 'launch-failed'])('detects a GPU %s before app readiness', reason => {
    const emitter = new EventEmitter()
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    const trace = vi.fn()
    registerDesktopRenderingHealthMonitor(emitter as unknown as App, prefs, trace)
    emitter.emit('child-process-gone', {}, { type: 'GPU', reason, exitCode: 1 })
    expect(prefs.getState()).toMatchObject({ configuredMode: 'compatible', automaticFallbackReason: 'gpu-process-failed' })
    expect(trace).toHaveBeenCalledWith('rendering-auto-fallback saved; applies-next-launch')
  })

  it('ignores orderly exit, intentional termination, integrity problems, other processes and shutdown', () => {
    const emitter = new EventEmitter()
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    const stop = registerDesktopRenderingHealthMonitor(emitter as unknown as App, prefs, vi.fn())
    for (const reason of ['clean-exit', 'killed', 'memory-eviction', 'integrity-failure']) {
      emitter.emit('child-process-gone', {}, { type: 'GPU', reason, exitCode: 0 })
    }
    emitter.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    // A cancelled quit must not disable monitoring for the still-running app.
    emitter.emit('before-quit', {})
    expect(prefs.getState().configuredMode).toBe('default')
    emitter.emit('will-quit', {})
    emitter.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(prefs.getState().configuredMode).toBe('default')
    stop()
    expect(emitter.listenerCount('child-process-gone')).toBe(0)
  })

  it('keeps the process alive and records a failed save instead of acknowledging success', () => {
    const emitter = new EventEmitter()
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    const trace = vi.fn()
    registerDesktopRenderingHealthMonitor(emitter as unknown as App, prefs, trace)
    mkdirSync(path)
    expect(() => emitter.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })).not.toThrow()
    expect(trace).toHaveBeenCalledWith('rendering-auto-fallback save-failed')
    expect(prefs.getState().configuredMode).toBe('default')
    rmSync(path, { recursive: true })
    emitter.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(prefs.getState().configuredMode).toBe('compatible')
  })

  it('continues detecting failures after a quit request is cancelled', () => {
    const emitter = new EventEmitter()
    const prefs = new DesktopRenderingPreferences(path, app, 'darwin')
    registerDesktopRenderingHealthMonitor(emitter as unknown as App, prefs, vi.fn())
    emitter.emit('before-quit', {})
    emitter.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(prefs.getState().configuredMode).toBe('compatible')
  })
})
