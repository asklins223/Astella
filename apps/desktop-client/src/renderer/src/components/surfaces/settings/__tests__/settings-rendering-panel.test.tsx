// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRenderingState } from '../../../../../../shared/desktop-rendering'
import { SettingsRenderingGroup } from '../settings-rendering-panel'

const initial: DesktopRenderingState = { supported: true, configuredMode: 'default', activeMode: 'default', restartRequired: false, suggestedFallbackReason: null }
const getState = vi.fn()
const setMode = vi.fn()
const dismissFallbackSuggestion = vi.fn()
const unsubscribe = vi.fn()
let stateListener: (state: DesktopRenderingState) => void
const onStateChanged = vi.fn(listener => { stateListener = listener; return unsubscribe })
beforeEach(() => {
  getState.mockReset().mockResolvedValue(initial)
  setMode.mockReset()
  dismissFallbackSuggestion.mockReset()
  unsubscribe.mockClear()
  Object.defineProperty(window, 'astellaDesktop', {
    configurable: true,
    value: { platform: 'darwin', rendering: { getState, setMode, dismissFallbackSuggestion, onStateChanged } },
  })
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
    await screen.findByText('当前使用默认渲染。')
  })

  it('offers the fallback after a graphics failure without switching anything', async () => {
    render(<SettingsRenderingGroup />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    act(() => stateListener({ ...initial, suggestedFallbackReason: 'gpu-process-failed' }))
    expect(screen.getByText('图形进程在这台 Mac 上异常退出过')).toBeTruthy()
    // 只是问一句：不该同时冒出「已保存」这种已经改过设置的话。
    expect(screen.queryByText('已保存，下次启动生效')).toBeNull()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    setMode.mockResolvedValue({ ...initial, configuredMode: 'compatible', restartRequired: true })
    fireEvent.click(screen.getByRole('button', { name: '改用兼容渲染' }))
    await screen.findByText('已保存，下次启动生效')
    expect(setMode).toHaveBeenCalledWith('compatible')
  })

  it('dismisses the offer without touching the preference', async () => {
    render(<SettingsRenderingGroup />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    act(() => stateListener({ ...initial, suggestedFallbackReason: 'webgl-context-lost' }))
    dismissFallbackSuggestion.mockResolvedValue({ ...initial, suggestedFallbackReason: null })
    fireEvent.click(screen.getByRole('button', { name: '不用了' }))
    await waitFor(() => expect(dismissFallbackSuggestion).toHaveBeenCalledOnce())
    expect(setMode).not.toHaveBeenCalled()
    expect(screen.queryByText(/伴星画布的 WebGL 上下文丢失过/)).toBeNull()
  })

  it('does not let a stale initial read hide a newly detected graphics failure', async () => {
    let finishRead: (state: DesktopRenderingState) => void = () => {}
    getState.mockReturnValue(new Promise<DesktopRenderingState>(resolve => { finishRead = resolve }))
    render(<SettingsRenderingGroup />)
    act(() => stateListener({ ...initial, suggestedFallbackReason: 'webgl-context-lost' }))
    await act(async () => finishRead(initial))
    expect(screen.getByText(/伴星画布的 WebGL 上下文丢失过/)).toBeTruthy()
  })

  it('keeps an answer already given while the switch waits for a restart', async () => {
    render(<SettingsRenderingGroup />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    act(() => stateListener({ ...initial, configuredMode: 'compatible', restartRequired: true }))
    expect(screen.getByText('已保存，下次启动生效')).toBeTruthy()
    // 已经选了兼容渲染，就不该再出现一次询问。
    act(() => stateListener({ ...initial, configuredMode: 'compatible', restartRequired: true, suggestedFallbackReason: 'gpu-process-failed' }))
    expect(screen.queryByText('图形进程在这台 Mac 上异常退出过')).toBeNull()
    expect(unsubscribe).not.toHaveBeenCalled()
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
