import { describe, expect, test } from 'bun:test'
import {
  BRANCH_VOCABULARY,
  BRANCH_VOCABULARY_ORDER,
  BRANCH_VOCABULARY_SECTION,
  GOVERNANCE_ADVISORY,
  GOVERNANCE_ADVISORY_ORDER,
  GOVERNANCE_ADVISORY_SECTION,
} from '../src/prompt.js'

/**
 * The ambient static sections (issue #28 phase 1; issue #48). These tests
 * pin the load-bearing properties of texts that ship in EVERY prompt
 * assembly of every session: the vocabulary terms they must state, the
 * token budget they must respect, and the registration facts the host
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
      'send_message_by_branch',
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

describe('governance adoption section', () => {
  test('the section name is plugin-prefixed (global registry collision guard)', () => {
    expect(GOVERNANCE_ADVISORY_SECTION).toBe('dsh-session-fork:governance')
  })

  test('the order rides after the identity section, below TOOLS_SDK', () => {
    // identity 2960 < ours < TOOLS_SDK 5000 — adoption advice reads once
    // the reader knows what a branch is and which branch it is on.
    expect(GOVERNANCE_ADVISORY_ORDER).toBeGreaterThan(2960)
    expect(GOVERNANCE_ADVISORY_ORDER).toBeLessThan(5000)
    expect(GOVERNANCE_ADVISORY_ORDER).toBe(2970)
  })

  test('states both adoption paths and their carriers', () => {
    for (const term of ['GOVERNANCE.md', 'AGENTS.md', 'symlink', 'worktree']) {
      expect(GOVERNANCE_ADVISORY).toContain(term)
    }
  })

  test('carries the anti-nag contract (issue #48)', () => {
    expect(GOVERNANCE_ADVISORY).toContain('at most once')
    expect(GOVERNANCE_ADVISORY).toContain('refusal settles')
  })

  test('carries no template variables (static section)', () => {
    expect(GOVERNANCE_ADVISORY).not.toMatch(/\{\{[a-z][a-z0-9_]*\}\}/)
  })

  test('stays within the every-assembly token budget', () => {
    expect(GOVERNANCE_ADVISORY.length).toBeLessThanOrEqual(1000)
  })
})
