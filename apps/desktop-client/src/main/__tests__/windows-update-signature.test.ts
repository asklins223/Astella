import { expect, it } from 'vitest'
import { sameTrustedWindowsSigner } from '../update/windows-update-signature'

it('requires two valid Authenticode signatures using the same public key and algorithm', () => {
  const valid = { status: 'Valid', algorithm: '1.2.840.113549.1.1.1', publicKey: 'PUBLICKEY' }
  expect(sameTrustedWindowsSigner(valid, { ...valid })).toBe(true)
  expect(sameTrustedWindowsSigner(valid, { ...valid, publicKey: 'OTHERKEY' })).toBe(false)
  expect(sameTrustedWindowsSigner(valid, { ...valid, status: 'UnknownError' })).toBe(false)
  expect(sameTrustedWindowsSigner({ status: 'NotSigned' }, valid)).toBe(false)
  expect(sameTrustedWindowsSigner(valid, { ...valid, algorithm: 'other' })).toBe(false)
})
