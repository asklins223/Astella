/**
 * 伴星 Live2D 模型的**设备级通道**（2026-11-18）。
 *
 * 与识别模型的四条同族：模型在这台机器上，不在谁的名下——不要求工作区纪元，
 * 不经过网关。模型字节由主进程经已登录会话从对象存储取回，渲染层只拿状态。
 *
 * 下载是长任务：`download` 发起即返回，进度靠再次读状态拿。把 60 MB 的等待
 * 压在单次 invoke 里，用户切走界面就会把它一起带走。
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  DESKTOP_IPC_CHANNELS,
  requestMetaSchema,
  type RequestMetaV1,
} from '@astella/shared/desktop-ipc-contracts'
import { companionModelIdSchema, companionModelSnapshotV1Schema } from '@astella/shared/companion-model-contracts'
import type { InputSchema, ParsedMeta } from './desktop-ipc'
import { DesktopGatewayFailure } from '../gateway/desktop-gateway-failure'
import { companionModelMountUrl } from '../companion-model/companion-model-route'
import type { CompanionModelStore } from '../companion-model/companion-model-store'

export type CompanionModelChannelDeps = {
  channel: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ) => void
  assertEpochBoundaryExempt: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void
  activeWorkspaceEpoch: () => number
  companionModelStores?: ReadonlyMap<string, CompanionModelStore>
}

const companionModelInputSchema = z.strictObject({
  meta: requestMetaSchema,
  modelId: companionModelIdSchema,
})

export function registerCompanionModelChannels(deps: CompanionModelChannelDeps): void {
  const { channel, assertEpochBoundaryExempt, activeWorkspaceEpoch } = deps

  for (const [channelName, run] of [
    [DESKTOP_IPC_CHANNELS.companionModelState, null],
    [DESKTOP_IPC_CHANNELS.companionModelDownload, 'startDownload'],
    [DESKTOP_IPC_CHANNELS.companionModelCancel, 'cancel'],
    [DESKTOP_IPC_CHANNELS.companionModelRemove, 'remove'],
  ] as const) {
    channel(channelName, companionModelInputSchema, async (_event, window, input) => {
      assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch())
      const store = deps.companionModelStores?.get(input.modelId)
      if (!store) throw new DesktopGatewayFailure('configuration_error', 'never')
      if (run) await store[run]()
      let mountUrl: string
      try {
        mountUrl = companionModelMountUrl(window.webContents.getURL(), store.modelId, process.env.ELECTRON_RENDERER_URL)
      } catch {
        throw new DesktopGatewayFailure('configuration_error', 'never')
      }
      return companionModelSnapshotV1Schema.parse({
        version: 1,
        modelId: store.modelId,
        mountUrl,
        ...(await store.state()),
      })
    }, companionModelSnapshotV1Schema)
  }
}