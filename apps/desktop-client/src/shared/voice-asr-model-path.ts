import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * 语音识别模型目录的落点（2026-10）。
 *
 * ## 为什么这值得单独一个文件
 *
 * 因为**主进程与 Vite 开发服务器都要答同一个问题**，而这两边算不出同一个答案：
 * 开发时页面在 `http://localhost:5173`，模型必须由开发服务器从**同一个 origin** 提供
 * （跨源读不了自定义 scheme），于是开发服务器也得知道模型在哪；而它拿不到
 * `app.getPath('userData')`——那是 Electron 主进程才有的东西。
 *
 * 所以规则写在这里，两边都走它：显式指定的目录 > `app.getPath('userData')`（只有主进程
 * 有）> 按平台算出来的 userData 默认值。两边同一条规则，就不会再出现"主进程说装好了、
 * worker 读不到"这种只在开发里复现的错位。
 */

/**
 * Electron 的 userData 默认目录。抄的是 Chromium 的那套规则：Windows 用
 * `%APPDATA%`，macOS 用 `~/Library/Application Support`，其余用 `$XDG_CONFIG_HOME`
 * 或 `~/.config`，最后都拼上应用名。
 *
 * **只有开发模式走这条**。打包后的主进程给的是 `app.getPath('userData')`，那是权威答案。
 */
export function platformUserDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  appName = 'astella-desktop-client'
): string {
  if (platform === 'win32') return resolve(env.APPDATA ?? resolve(home, 'AppData', 'Roaming'), appName)
  if (platform === 'darwin') return resolve(home, 'Library', 'Application Support', appName)
  return resolve(env.XDG_CONFIG_HOME ?? resolve(home, '.config'), appName)
}

export interface VoiceAsrModelDirectoryInput {
  readonly env?: NodeJS.ProcessEnv
  /** 主进程给 `app.getPath('userData')`；开发服务器没有它，于是走平台默认值。 */
  readonly userDataDir?: string
}

export function voiceAsrModelDirectory(input: VoiceAsrModelDirectoryInput = {}): string {
  const env = input.env ?? process.env
  // 显式指定优先：想把模型放在共享盘上的部署走这一条。
  const override = env.ASTELLA_VOICE_ASR_DIR?.trim()
  if (override) return resolve(override)
  return resolve(input.userDataDir ?? platformUserDataDirectory(env), 'voice-models')
}
