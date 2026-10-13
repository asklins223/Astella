#!/usr/bin/env node
/**
 * 把桌面端的正式应用图标与**已批准的**本机 Live2D 运行资源同步到手机端 public。
 *
 * 为什么不把模型直接放进手机端目录并提交：`PROVENANCE.md` 登记的是
 * `redistributionAllowed:false` + `acceptanceRequired:true`，仓库里出现第二份副本
 * 就等于替作者多复制了一次作品。同步是**本机构建产物**（已在 .gitignore 里），
 * 单一事实源仍是桌面端那一份；许可说明随副本一起复制，让人看得见来由。
 *
 * 只做增量：按 size + mtime 判断，未变就跳过（全量 4.1MB，dev 每次都拷会拖慢启动）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(appRoot, '../../apps/desktop-client/src/renderer/public/assets/companion')
const target = resolve(appRoot, 'public/assets/companion')
const appIconSource = resolve(appRoot, '../desktop-client/build/icon.png')
const appIconTarget = resolve(appRoot, 'public/assets/brand/app-icon.png')

if (!existsSync(appIconSource)) {
  console.error(`[sync-companion-assets] 找不到正式应用图标：${appIconSource}`)
  process.exit(1)
}
const appIconStat = statSync(appIconSource)
const currentAppIconStat = existsSync(appIconTarget) ? statSync(appIconTarget) : null
if (!currentAppIconStat || currentAppIconStat.size !== appIconStat.size || Math.abs(currentAppIconStat.mtimeMs - appIconStat.mtimeMs) >= 1000) {
  mkdirSync(dirname(appIconTarget), { recursive: true })
  copyFileSync(appIconSource, appIconTarget)
  utimesSync(appIconTarget, appIconStat.atime, appIconStat.mtime)
  console.log(`[sync-companion-assets] 正式应用图标已同步 → ${appIconTarget}`)
} else {
  console.log('[sync-companion-assets] 正式应用图标未变')
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const required = [
  'vendor/pixi.min.js',
  'vendor/live2dcubismcore.min.js',
  'vendor/cubism4.min.js',
  'live2d-v3/whale/manifest.json',
  'live2d-v3/whale/c_0120.model3.json',
]

if (!existsSync(source)) {
  console.error(`[sync-companion-assets] 找不到桌面端伴星资源：${source}`)
  process.exit(1)
}
for (const file of required) {
  if (!existsSync(join(source, file))) {
    console.error(`[sync-companion-assets] 伴星资源不完整，缺 ${file}`)
    process.exit(1)
  }
}

let copied = 0
let skipped = 0
for (const path of walk(source)) {
  const to = join(target, relative(source, path))
  const from = statSync(path)
  const current = existsSync(to) ? statSync(to) : null
  if (current && current.size === from.size && Math.abs(current.mtimeMs - from.mtimeMs) < 1000) {
    skipped++
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(path, to)
  utimesSync(to, from.atime, from.mtime)
  copied++
}

console.log(`[sync-companion-assets] ${copied} 个文件更新，${skipped} 个未变 → ${target}`)

/**
 * 图形资源没到位时用的静帧。
 *
 * 它来自 `prototype/`（那一份已经在仓库里、被复核过的伴星立绘），同步到 public 而不是
 * 再提交一份副本——同一个二进制在库里出现两次，是会被追着问的事。
 */
const still = resolve(appRoot, 'prototype/mobile-companion-character.png')
const stillTarget = resolve(appRoot, 'public/assets/companion-static.png')
if (existsSync(still)) {
  const from = statSync(still)
  const current = existsSync(stillTarget) ? statSync(stillTarget) : null
  if (!current || current.size !== from.size) {
    mkdirSync(dirname(stillTarget), { recursive: true })
    copyFileSync(still, stillTarget)
    utimesSync(stillTarget, from.atime, from.mtime)
    console.log(`[sync-companion-assets] 静帧已同步 → ${stillTarget}`)
  } else {
    console.log('[sync-companion-assets] 静帧未变')
  }
} else {
  console.warn(`[sync-companion-assets] 没找到静帧（${still}）；图形资源失败时舞台只给星标占位`)
}
