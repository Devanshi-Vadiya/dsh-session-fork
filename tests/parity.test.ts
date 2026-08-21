/**
 * Parity test: the vendored TextEncoder copy of the official title
 * normalizer must be observably identical to the npm package the mounted
 * SessionTitleService uses. The Host rename path runs the official code
 * while our gate (branch-name.ts) runs the vendored copy — the issue #7
 * identity invariant ("gate ≡ rename normalization") rests on this parity.
 * @module dsh-session-fork/tests/parity.test
 */

import { describe, expect, test } from 'bun:test'
import {
  normalizeSessionTitle as officialNormalize,
  truncateTitleUtf8 as officialTruncate,
} from '@deepseek-ai/dsh-session-title'
import {
  normalizeSessionTitle as vendoredNormalize,
  truncateTitleUtf8 as vendoredTruncate,
} from '../src/vendor/session-title-normalize.js'
import { upstreamMaxTitleBytes } from '../src/vendor/session-title-limit.js'

/** Corpus: every class of input the gate distinguishes, plus nasties. */
const CORPUS: readonly string[] = [
  '',
  'main',
  'feature-x',
  'my branch',
  'X (1)',
  ' padded ',
  'a  b',
  'a\tb',
  'a\nb',
  'a\u200Bb',
  '\u202Eabc',
  '\u2066ltr\u2069',
  '\uFEFFlead',
  '\u001B]0;title\u0007x',
  '\u001B[31mred\u001B[0m',
  '\u0000\u007F\u009B1m',
  '汉'.repeat(26) + 'ab', // exactly 80 UTF-8 bytes
  '汉'.repeat(27), // 81 bytes: over budget
  'naïve mixed 汉字 with émoji 🌸',
  '🎉'.repeat(40), // 4-byte code points at the budget edge
]

describe('vendored normalizer parity with the official package', () => {
  test('normalizeSessionTitle agrees for every corpus entry at the deployed budget', () => {
    for (const input of CORPUS) {
      expect(vendoredNormalize(input, upstreamMaxTitleBytes))
        .toBe(officialNormalize(input, upstreamMaxTitleBytes))
    }
  })

  test('truncateTitleUtf8 agrees across small budgets (loop actually runs)', () => {
    for (const input of CORPUS) {
      for (const maxBytes of [1, 3, 7, 12, 40, 80]) {
        expect(vendoredTruncate(input, maxBytes))
          .toBe(officialTruncate(input, maxBytes))
      }
    }
  })

  test('identity gate verdicts agree (gate ≡ official rewrite decision)', () => {
    // The gate admits a name iff the official normalizer returns it
    // unchanged — verify the vendored copy draws that line identically.
    for (const input of CORPUS) {
      const vendoredIdentity = vendoredNormalize(input, upstreamMaxTitleBytes) === input
      const officialIdentity = officialNormalize(input, upstreamMaxTitleBytes) === input
      expect(vendoredIdentity).toBe(officialIdentity)
    }
  })
})
