import { expect, it } from 'vitest'
import { isBoundedIpcShape } from '../ipc/ipc-shape-limit'

it('bounds IPC collections and cycles without limiting normal text or binary payloads', () => {
  expect(isBoundedIpcShape({ text: 'x'.repeat(1_000_000), binary: new Uint8Array(1_000_000) })).toBe(true)
  expect(isBoundedIpcShape({ items: Array(50_000).fill(null) })).toBe(false)
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  expect(isBoundedIpcShape(cyclic)).toBe(false)
})
