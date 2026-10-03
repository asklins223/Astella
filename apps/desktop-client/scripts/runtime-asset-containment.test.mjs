import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const publicRoot = resolve(appRoot, 'src/renderer/public')
const runtimeRoot = resolve(publicRoot, 'assets/learning-room/v1')
const rendererOut = resolve(appRoot, 'out/renderer')
// 2026-10-04 Owner 裁决删除 mao / 小彩 后，运行时只剩大肥鱼一个形态。
// `window-live2d-contract.ts` 的 WINDOW_LIVE2D_MODEL_REGISTRY 是唯一真话。
const activeLive2dModels = [
  {
    sourceRoot: resolve(appRoot, 'src/renderer/public/assets/companion/live2d-v3/whale'),
    outRoot: resolve(rendererOut, 'assets/companion/live2d-v3/whale'),
    modelFile: 'c_0120.model3.json',
  },
]
// 已删除的两个形态：源树与打包产物里都不得再出现，连目录带文件。
const removedLive2dPackages = [
  'assets/companion/live2d-v1/',
  'assets/companion/live2d-v2/',
]
const rejectedRuntimeMedia = [
  'graph-entry-fog-v1.mp4',
  'validation-ink-bloom-v1.mp4',
  'companion-wake-v1.webm',
  'companion-confirm-v1.webm',
  // 旧书房底板：2026-10-01 整条删除后，这几个文件名连同所在目录都不得回到运行时。
  'room-day.webp',
  'room-night.webp',
  'study-seat-day-v2.png',
  'study-seat-night-v2.png',
  'review-seat-day-v1.png',
  'review-seat-night-v1.png',
  'search-reference-day-v1.png',
  'search-reference-night-v1.png',
  'search-foreground-day-v1.png',
  'entry-door-closed-day-v1.png',
  'companion-orb.webp',
]
// 2026-10-01：旧 3D 学习房归档包（`assets/3d/`）整条删除，public 树不再有任何需要
// 排除的目录。这份清单**故意留空**；若日后又要排除什么，加回来。
const releaseExcludedOutPrefixes = []

function listFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

describe('runtime asset containment', () => {
  it('keeps all rejected media out of runtime source and renderer out', () => {
    const boundaryFiles = [...listFiles(runtimeRoot), ...listFiles(rendererOut)]
    for (const rejectedName of rejectedRuntimeMedia) {
      expect(boundaryFiles.some((file) => file.endsWith(`/${rejectedName}`))).toBe(false)
    }
  })

  it('keeps the retired study pack out while the lighthouse room plate stays', () => {
    // 正控制：灯塔底板**确实**在运行时树里。所以下面那条「旧书房不在」不是空转断言——
    // 夹具读错目录时它会先在正控制这一条上红，而不是让否定断言永远通过。
    const runtimeFiles = listFiles(runtimeRoot).map((file) => relative(runtimeRoot, file).split(sep).join('/'))
    expect(runtimeFiles).toContain('posters/home-v2/lighthouse/lighthouse-day-poster-v1.png')
    expect(runtimeFiles).toContain('posters/home-v2/lighthouse/lighthouse-night-poster-v1.png')
    expect(runtimeFiles).toContain('layers/home-v2/lighthouse/lighthouse-day-d0-v1.png')
    expect(runtimeFiles.filter((file) => file.startsWith('layers/home-v2/lighthouse/'))).toHaveLength(39)

    for (const retired of [
      'posters/room-day.webp',
      'posters/study-seat-day-v2.png',
      'posters/review-seat-day-v1.png',
      'posters/search-reference-day-v1.png',
    ]) {
      expect(runtimeFiles).not.toContain(retired)
    }
    for (const retiredDir of ['objects', 'textures', 'motion', 'masks', 'audio', 'captions', 'foreground', 'graph', 'login-entry']) {
      expect(runtimeFiles.some((file) => file.startsWith(`${retiredDir}/`))).toBe(false)
    }
  })

  it('ships the restored task scene originals unchanged in renderer out', () => {
    const manifest = JSON.parse(readFileSync(resolve(runtimeRoot, 'manifest.json'), 'utf8'))
    const paths = new Set(Object.values(manifest.taskPosters).flatMap((pair) => [pair.day.path, pair.night.path]))
    // 六族任务场景 12 张 + 2026-10-03 登记的制卡工坊 2 张 = 14。改这张数的时候，
    // 记得它是"登记了几族"，不是"目录里放了几张"。
    expect(paths.size).toBe(14)
    expect(paths.has('posters/task-scenes/card-making-atelier-day-v1.png')).toBe(true)
    expect(paths.has('posters/task-scenes/card-making-atelier-night-v1.png')).toBe(true)
    expect(paths.has('posters/task-scenes/candidate-card-table-day-v2.png')).toBe(true)
    for (const path of paths) {
      const source = readFileSync(resolve(runtimeRoot, path))
      const shipped = readFileSync(resolve(rendererOut, 'assets/learning-room/v1', path))
      expect(source.length).toBeGreaterThan(0)
      expect(shipped.equals(source)).toBe(true)
    }
  })

  it('keeps migration archives out while shipping the bundled Live2D runtimes', () => {
    const outFiles = listFiles(rendererOut).map((file) => relative(rendererOut, file).split(sep).join('/'))
    for (const prefix of releaseExcludedOutPrefixes) {
      expect(outFiles.some((file) => file.startsWith(prefix))).toBe(false)
    }
    // 2026-09-16 裁决移除 orb：它不得再进入 runtime 产物。
    expect(outFiles).not.toContain('assets/learning-room/v1/objects/companion-orb.webp')
    // 在役模型的源资产必须都在。
    for (const model of activeLive2dModels) {
      expect(existsSync(resolve(model.sourceRoot, model.modelFile))).toBe(true)
    }
    expect(outFiles).toContain('assets/companion/live2d-v3/whale/c_0120.model3.json')
    expect(outFiles).toContain('assets/companion/vendor/pixi.min.js')
  })

  it('keeps the retired Mao and Seethrough packages out of source and renderer out', () => {
    // 两边都按 `assets/...` 相对路径比对，前缀才通用。
    for (const boundary of [publicRoot, rendererOut]) {
      const present = listFiles(boundary).map((file) => relative(boundary, file).split(sep).join('/'))
      for (const removed of removedLive2dPackages) {
        expect(
          present.filter((file) => file.startsWith(removed)),
          `${removed} 仍在 ${boundary} 里`,
        ).toEqual([])
      }
    }
  })

  it('keeps every active Live2D model reference present in source', () => {
    for (const model of activeLive2dModels) {
      const sourceModel = JSON.parse(readFileSync(resolve(model.sourceRoot, model.modelFile), 'utf8'))
      expect(sourceModel.Version).toBe(3)

      const references = [
        sourceModel.FileReferences.Moc,
        ...sourceModel.FileReferences.Textures,
        ...(sourceModel.FileReferences.Physics ? [sourceModel.FileReferences.Physics] : []),
        ...(sourceModel.FileReferences.Pose ? [sourceModel.FileReferences.Pose] : []),
        ...(sourceModel.FileReferences.DisplayInfo ? [sourceModel.FileReferences.DisplayInfo] : []),
        ...(sourceModel.FileReferences.Expressions ?? []).map((expression) => expression.File),
        ...Object.values(sourceModel.FileReferences.Motions ?? {}).flat().map((motion) => motion.File),
      ]
      expect(references.filter((reference) => !existsSync(resolve(model.sourceRoot, reference)))).toEqual([])
    }
  })

  it('keeps the bundled whale runtime identical between source and renderer out', () => {
    const whale = activeLive2dModels[0]
    const sourceModel = JSON.parse(readFileSync(resolve(whale.sourceRoot, whale.modelFile), 'utf8'))
    const outputModel = JSON.parse(readFileSync(resolve(whale.outRoot, whale.modelFile), 'utf8'))
    expect(outputModel).toEqual(sourceModel)

    const references = [
      sourceModel.FileReferences.Moc,
      ...sourceModel.FileReferences.Textures,
      ...(sourceModel.FileReferences.Physics ? [sourceModel.FileReferences.Physics] : []),
      ...(sourceModel.FileReferences.Pose ? [sourceModel.FileReferences.Pose] : []),
      ...(sourceModel.FileReferences.DisplayInfo ? [sourceModel.FileReferences.DisplayInfo] : []),
      ...(sourceModel.FileReferences.Expressions ?? []).map((expression) => expression.File),
      ...Object.values(sourceModel.FileReferences.Motions ?? {}).flat().map((motion) => motion.File),
    ]
    expect(references.filter((reference) => !existsSync(resolve(whale.sourceRoot, reference)))).toEqual([])
    expect(references.filter((reference) => !existsSync(resolve(whale.outRoot, reference)))).toEqual([])
  })

  it('declares the whale runtime groups the driver relies on', () => {
    const whaleRoot = activeLive2dModels[0].sourceRoot
    const whale = JSON.parse(readFileSync(resolve(whaleRoot, 'c_0120.model3.json'), 'utf8'))
    expect(whale.Groups).toEqual(expect.arrayContaining([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]))
    expect(Object.keys(whale.FileReferences.Motions)).toContain('Idle')
    // 情绪表现走 pixi-live2d 的表情接口：注册表里的别名必须都能在 model3.json 找到。
    const names = (whale.FileReferences.Expressions ?? []).map((expression) => expression.Name)
    for (const alias of ['happy', 'starstruck', 'heart-eyes', 'surprised', 'blush', 'mischievous', 'question', 'dizzy', 'angry', 'sad', 'cry']) {
      expect(names).toContain(alias)
    }
  })
})
