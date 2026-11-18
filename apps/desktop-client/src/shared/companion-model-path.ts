import { resolve } from 'node:path'
import { platformUserDataDirectory } from './voice-asr-model-path'

/**
 * 伴星模型目录的落点（2026-11-18），与本机识别模型同一套规则：
 * 显式指定的目录 > `app.getPath('userData')`（只有主进程有）> 按平台算出来的默认值。
 *
 * 主进程的下载仓库与开发服务器的同源路由都要答**同一个问题**——两边各拼一次路径，
 * 就会出现「主进程说下好了、页面读不到」这种只在开发里复现的错位。
 */
export interface CompanionModelDirectoryInput {
  readonly env?: NodeJS.ProcessEnv
  readonly userDataDir?: string
}

export function companionModelDirectory(input: CompanionModelDirectoryInput = {}): string {
  const env = input.env ?? process.env
  const override = env.ASTELLA_COMPANION_MODEL_DIR?.trim()
  if (override) return resolve(override)
  return resolve(input.userDataDir ?? platformUserDataDirectory(env), 'companion-models')
}