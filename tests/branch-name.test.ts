/**
 * Direct tests for the shared branch-name gate core.
 * @module dsh-session-fork/tests/branch-name.test
 */

import { describe, expect, test } from 'bun:test'
import { validateBranchName } from '../src/branch-name.js'

describe('validateBranchName (shared gate core)', () => {
  test('accepts plain names, spaces within, and an exactly-80-byte CJK name', () => {
    expect(validateBranchName('main')).toEqual({ ok: true })
    expect(validateBranchName('my branch')).toEqual({ ok: true })
    expect(validateBranchName(`${'汉'.repeat(26)}ab`)).toEqual({ ok: true })
  })

  test('rejects the empty string with the dedicated reason', () => {
    expect(validateBranchName('')).toEqual({ ok: false, reason: 'name must not be empty' })
  })

  test('rejects an over-budget name and names the byte ceiling', () => {
    const check = validateBranchName('汉'.repeat(27))
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('80')
  })

  test('rejects names the official normalizer would rewrite', () => {
    for (const dirty of ['a  b', 'a\tb', ' padded ', 'a\u200Bb', '\u202Eabc', '\u001B]0;x\u0007y']) {
      const check = validateBranchName(dirty)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toContain('whitespace')
    }
  })
})
