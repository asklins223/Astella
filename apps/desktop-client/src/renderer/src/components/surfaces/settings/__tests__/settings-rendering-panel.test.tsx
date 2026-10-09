// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRenderingState } from '../../../../../../shared/desktop-rendering'
import { SettingsRenderingGroup } from '../settings-rendering-panel'

const initial: DesktopRenderingState = { supported: true, configuredMode: 'default', activeMode: 'default', restartRequired: false, automaticFallbackReason: null }
const getState = vi.fn()
const setMode = vi.fn()
const unsubscribe = vi.fn()
let stateListener: (state: DesktopRenderingState) => void
const onStateChanged = vi.fn(listener => { stateListener = listener; return unsubscribe })
beforeEach(() => {
  getState.mockReset().mockResolvedValue(initial)
  setMode.mockReset()
  unsubscribe.mockClear()
  Object.defineProperty(window, 'astellaDesktop', { configurable: true, value: { platform: 'darwin', rendering: { getState, setMode, onStateChanged } } })
})
afterEach(cleanup)

describe('rendering compatibility settings', () => {
  it('shows a saved change as pending until the app restarts', async () => {
    setMode.mockResolvedValue({ ...initial, configuredMode: 'compatible', restartRequired: true })
    render(<SettingsRenderingGroup />)
    const toggle = screen.getByRole('switch', { name: '渲染兼容模式' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    await screen.findByText('已保存，下次启动生效')
    expect(setMode).toHaveBeenCalledWith('compatible')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/请先保存正在编辑的笔记/)).toBeTruthy()
  })

  it('leaves the switch unchanged on save failure and lets the user retry', async () => {
    setMode.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({ ...initial, configuredMode: 'compatible', restartRequired: true })
    render(<SettingsRenderingGroup />)
    const toggle = screen.getByRole('switch')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('已保存，下次启动生效')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('已保存，下次启动生效')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('can recover from a failed device read', async () => {
    getState.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(initial)
    render(<SettingsRenderingGroup />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('当前使用默认渲染，检测到图形故障时会自动启用兼容模式。')
  })

  it('updates an open settings page when an automatic fallback is saved', async () => {
    const { unmount } = render(<SettingsRenderingGroup />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    act(() => stateListener({ ...initial, configuredMode: 'compatible', restartRequired: true, automaticFallbackReason: 'gpu-process-failed' }))
    expect(screen.getByText('已检测到图形异常，下次启动自动使用兼容模式')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(setMode).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('does not let a stale initial read hide a newly detected graphics failure', async () => {
    let finishRead: (state: DesktopRenderingState) => void = () => {}
    getState.mockReturnValue(new Promise<DesktopRenderingState>(resolve => { finishRead = resolve }))
    render(<SettingsRenderingGroup />)
    act(() => stateListener({ ...initial, configuredMode: 'compatible', restartRequired: true, automaticFallbackReason: 'webgl-context-lost' }))
    await act(async () => finishRead(initial))
    expect(screen.getByText('已检测到图形异常，下次启动自动使用兼容模式')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('explains an automatically activated backend after restarting', async () => {
    getState.mockResolvedValue({ ...initial, configuredMode: 'compatible', activeMode: 'compatible', automaticFallbackReason: 'webgl-context-lost' })
    render(<SettingsRenderingGroup />)
    await screen.findByText(/已因图形异常自动启用兼容模式/)
  })

  it('reflects the active compatible backend after restarting', async () => {
    getState.mockResolvedValue({ ...initial, configuredMode: 'compatible', activeMode: 'compatible' })
    setMode.mockResolvedValue({ ...initial, activeMode: 'compatible', restartRequired: true })
    render(<SettingsRenderingGroup />)
    await screen.findByText(/当前正在使用兼容模式/)
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByText('已保存，下次启动生效')
    expect(setMode).toHaveBeenCalledWith('default')
  })

  it('is not offered on a platform without this backend fallback', () => {
    Object.defineProperty(window, 'astellaDesktop', { configurable: true, value: { platform: 'win32', rendering: { getState, setMode } } })
    render(<SettingsRenderingGroup />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
