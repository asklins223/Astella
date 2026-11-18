import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CompanionModelStore } from '../companion-model-store'
import type { CompanionModelManifestV1 } from '@astella/shared/companion-model-contracts'

const MODEL_ID = 'companion-live2d-test-v1'

function manifest(files: { path: string; bytes: Buffer }[]): CompanionModelManifestV1 {
  return {
    version: 1,
    modelId: MODEL_ID,
    modelVersion: 'v1',
    entry: files[0]?.path ?? 'model.json',
    files: files.map((file) => ({
      path: file.path,
      contentType: file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      byteLength: file.bytes.byteLength,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
      download: { url: `https://storage.example.invalid/${file.path}`, authorization: 'session' as const },
    })),
  }
}

function storeFor(
  root: string,
  files: { path: string; bytes: Buffer }[],
  payloadFor: (path: string) => Buffer | null = (path) => files.find((file) => file.path === path)?.bytes ?? null,
) {
  return new CompanionModelStore(MODEL_ID, root, {
    fetchManifest: async () => manifest(files),
    openFile: async (file) => {
      const bytes = payloadFor(file.path)
      if (!bytes) return new Response(null, { status: 404 })
      return new Response(new Blob([bytes]))
    },
  })
}

describe('CompanionModelStore', () => {
  it('installs a model only after every file passes byte and hash verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'companion-model-'))
    const files = [
      { path: 'nested/model.json', bytes: Buffer.from('{"Version":3}') },
      { path: 'textures/tex.png', bytes: Buffer.from([1, 2, 3, 4]) },
    ]
    const store = storeFor(root, files)
    expect((await store.state()).status).toBe('absent')
    store.startDownload()
    await store.whenIdle()
    expect((await store.state()).status).toBe('ready')
    expect((await store.resolveReadableFile('nested/model.json'))?.contentType).toBe('application/json')
    expect(await store.resolveReadableFile('../escape.txt')).toBeNull()
    expect(await store.resolveReadableFile('not-installed.json')).toBeNull()
  })

  it('drops the whole install when one file fails verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'companion-model-'))
    const files = [
      { path: 'model.json', bytes: Buffer.from('{"Version":3}') },
      { path: 'bad.bin', bytes: Buffer.from([9, 9]) },
    ]
    const store = storeFor(root, files, (path) => path === 'bad.bin' ? Buffer.from([0, 0]) : files[0].bytes)
    store.startDownload()
    await store.whenIdle()
    const state = await store.state()
    expect(state.status).toBe('failed')
    expect(state.failure).toBe('integrity')
    expect(await store.resolveReadableFile('model.json')).toBeNull()
  })

  it('removes the cache when asked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'companion-model-'))
    const files = [{ path: 'model.json', bytes: Buffer.from('{"Version":3}') }]
    const store = storeFor(root, files)
    store.startDownload()
    await store.whenIdle()
    expect((await store.state()).status).toBe('ready')
    await store.remove()
    expect((await store.state()).status).toBe('absent')
  })

  it('sweeps an incomplete directory on boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'companion-model-'))
    const modelDir = join(root, MODEL_ID)
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'model.json.part'), 'half')
    const store = storeFor(root, [{ path: 'model.json', bytes: Buffer.from('x') }])
    await store.sweepPartialFiles()
    expect((await store.state()).status).toBe('absent')
    await expect(readFile(join(modelDir, 'model.json.part'))).rejects.toBeTruthy()
  })
})