import { describe, expect, test } from 'bun:test'
import {
  BRANCH_VOCABULARY,
  BRANCH_VOCABULARY_ORDER,
  BRANCH_VOCABULARY_SECTION,
} from '../src/prompt.js'

/**
 * The ambient vocabulary section (issue #28, phase 1). These tests pin
 * the load-bearing properties of a text that ships in EVERY prompt
 * assembly of every session: the vocabulary terms it must state, the
 * token budget it must respect, and the registration facts the host
 * wiring in src/index.ts relies on.
 */
describe('branch vocabulary section', () => {
  test('the section name is plugin-prefixed (global registry collision guard)', () => {
    expect(BRANCH_VOCABULARY_SECTION).toBe('dsh-session-fork:vocabulary')
  })

  test('the order rides the tool-section ladder tail, below TOOLS_SDK', () => {
    // TOOL_REPORT 2900 < ours < TOOLS_SDK 5000 — the worldview rides
    // with the tool sections it explains. Bare number by design: the
    // central getSectionOrder() names are harness-internal.
    expect(BRANCH_VOCABULARY_ORDER).toBeGreaterThan(2900)
    expect(BRANCH_VOCABULARY_ORDER).toBeLessThan(5000)
    expect(BRANCH_VOCABULARY_ORDER).toBe(2950)
  })

  test('states every branch operation and the surfaces that show them', () => {
    for (const term of [
      'branch',
      'fork',
      'squash_into',
      'rebased_into',
      'branch tab',
      'registry',
      'archives',
    ]) {
      expect(BRANCH_VOCABULARY).toContain(term)
    }
  })

  test('teaches how to read the plugin-authored notices and envelopes', () => {
    expect(BRANCH_VOCABULARY).toContain('fork/adopt/rename')
    expect(BRANCH_VOCABULARY).toContain('<branch-squash>')
    expect(BRANCH_VOCABULARY).toContain('established background')
  })

  test('carries no template variables (static stage of issue #28)', () => {
    expect(BRANCH_VOCABULARY).not.toMatch(/\{\{[a-z][a-z0-9_]*\}\}/)
  })

  test('stays within the every-assembly token budget', () => {
    // ~1000 characters: the section ships with every model request of
    // every session on the host, so the budget is part of the contract.
    expect(BRANCH_VOCABULARY.length).toBeLessThanOrEqual(1000)
  })
})
