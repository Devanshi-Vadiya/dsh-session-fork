/**
 * Tests for the /branch command family: parsing, rendering, and the
 * execution core over fake deps (no cordis, no dsh services).
 * @module dsh-fork/tests/command.test
 */

import { describe, expect, test } from 'bun:test'
import {
  BRANCH_USAGE,
  executeBranchAction,
  parseBranchAction,
} from '../src/command.js'
import type { BranchCommandDeps } from '../src/command.js'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

const LOG: readonly string[] = [
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
]

function sessionOf(id: string): SourceSessionView {
  const events: SourceEvent[] = LOG.map((type, seq) => ({ seq, type }))
  return { id, events, header: { cwd: '/w' } }
}

/** In-memory store with restart semantics. */
function memoryStore(): RegistryStore & { dump(): RegistryState | null } {
  let stored: RegistryState | null = null
  return {
    async load() {
      return stored === null ? null : (JSON.parse(JSON.stringify(stored)) as RegistryState)
    },
    async save(state: RegistryState) {
      stored = JSON.parse(JSON.stringify(state)) as RegistryState
    },
    dump() {
      return stored
    },
  }
}

interface Harness {
  readonly deps: BranchCommandDeps
  readonly store: ReturnType<typeof memoryStore>
  readonly children: string[]
  liveSource: boolean
}

function harness(): Harness {
  const store = memoryStore()
  const children: string[] = []
  const h: Harness = {
    store,
    children,
    liveSource: true,
    deps: {
      currentSessionId: 's-parent',
      store,
      sessionExists(id) {
        return id !== 's-gone'
      },
      ports: {
        async readSession(sessionId) {
          return sessionId === 's-parent' ? sessionOf('s-parent') : sessionId === 's-cold'
            ? sessionOf('s-cold')
            : null
        },
        forkLive(sourceId, boundarySeq, childId) {
          if (!h.liveSource) return false
          expect(boundarySeq).toBe(7)
          children.push(childId)
          return true
        },
        async createChildFromSeed(childId) {
          children.push(childId)
        },
      },
    },
  }
  return h
}

describe('parseBranchAction', () => {
  test('bare input lists', () => {
    expect(parseBranchAction('')).toEqual({ kind: 'list' })
    expect(parseBranchAction('  list ')).toEqual({ kind: 'list' })
    expect(parseBranchAction('list x').kind).toBe('usage')
  })

  test('single token creates', () => {
    expect(parseBranchAction('review')).toEqual({ kind: 'create', name: 'review' })
    expect(parseBranchAction('create review')).toEqual({ kind: 'create', name: 'review' })
    expect(parseBranchAction('create')).toEqual({
      kind: 'usage',
      problem: `'create' takes exactly one branch name`,
    })
  })

  test('rm requires a name; --yes marks confirmation', () => {
    expect(parseBranchAction('rm main')).toEqual({ kind: 'rm', name: 'main', confirmed: false })
    expect(parseBranchAction('rm main --yes')).toEqual({ kind: 'rm', name: 'main', confirmed: true })
    expect(parseBranchAction('rm').kind).toBe('usage')
    expect(parseBranchAction('rm main --force').kind).toBe('usage')
  })

  test('rename takes exactly two names', () => {
    expect(parseBranchAction('rename a b')).toEqual({ kind: 'rename', from: 'a', to: 'b' })
    expect(parseBranchAction('rename a').kind).toBe('usage')
  })

  test('help and unknown subcommands render usage', () => {
    expect(parseBranchAction('help')).toEqual({ kind: 'usage', problem: '' })
    expect(parseBranchAction('frob a b').kind).toBe('usage')
  })
})

describe('executeBranchAction', () => {
  test('create forks the current session and persists the ref', async () => {
    const h = harness()
    const result = await executeBranchAction(
      parseBranchAction('review'),
      h.deps,
    )
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('review')
      expect(result.text).toContain('(turn end)')
    }
    expect(h.children).toHaveLength(1)
    const state = h.store.dump()
    expect(state!.branches['review']!.forkOrigin).toEqual({
      parentSessionId: 's-parent',
      atSeq: 7,
    })
  })

  test('duplicate name is a clear error and registry is unchanged', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const result = await executeBranchAction(parseBranchAction('review'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('already exists')
    expect(Object.keys(h.store.dump()!.branches)).toEqual(['review'])
  })

  test('cold source still creates a branch', async () => {
    const h = harness()
    h.liveSource = false
    const result = await executeBranchAction(parseBranchAction('cold'), h.deps)
    expect(result.kind).toBe('success')
    expect(h.children).toHaveLength(1)
  })

  test('missing source session is a clear error', async () => {
    const h = harness()
    h.deps = { ...h.deps, currentSessionId: 'ghost' }
    const result = await executeBranchAction(parseBranchAction('x'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('ghost')
  })

  test('list marks dangling branches', async () => {
    const h = harness()
    // One live branch pointing at the parent, one pointing at s-gone.
    await executeBranchAction(parseBranchAction('live'), h.deps)
    await executeBranchAction(parseBranchAction('live2'), h.deps)
    const state = h.store.dump()!
    h.store.save({
      branches: {
        ...state.branches,
        gone: {
          name: 'gone',
          sessionId: 's-gone',
          forkOrigin: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('gone')
      expect(result.text).toContain('dangling')
      expect(result.text).not.toContain('live [dangling')
    }
  })

  test('empty registry lists a hint', async () => {
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('No branches')
  })

  test('rm without --yes refuses; with --yes removes only the ref', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const refused = await executeBranchAction(parseBranchAction('rm review'), h.deps)
    expect(refused.kind).toBe('error')
    if (refused.kind === 'error') {
      expect(refused.text).toContain('--yes')
      expect(refused.text).toContain('never deleted')
    }
    expect(h.store.dump()!.branches['review']).toBeDefined()
    const removed = await executeBranchAction(parseBranchAction('rm review --yes'), h.deps)
    expect(removed.kind).toBe('success')
    expect(h.store.dump()!.branches['review']).toBeUndefined()
  })

  test('rm of an unknown branch is a clear error', async () => {
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('rm ghost --yes'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('ghost')
  })

  test('rename guards duplicates and unknowns', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('a'), h.deps)
    await executeBranchAction(parseBranchAction('b'), h.deps)
    const dup = await executeBranchAction(parseBranchAction('rename a b'), h.deps)
    expect(dup.kind).toBe('error')
    const unknown = await executeBranchAction(parseBranchAction('rename x y'), h.deps)
    expect(unknown.kind).toBe('error')
    if (unknown.kind === 'error') expect(unknown.text).toContain('x')
    const ok = await executeBranchAction(parseBranchAction('rename a c'), h.deps)
    expect(ok.kind).toBe('success')
    const state = h.store.dump()!
    expect(state.branches['c']).toBeDefined()
    expect(state.branches['a']).toBeUndefined()
  })

  test('usage action renders the usage block', async () => {
    const h = harness()
    const result = await executeBranchAction(
      parseBranchAction('frob a'),
      h.deps,
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.text).toContain('unknown subcommand')
      expect(result.text).toContain(BRANCH_USAGE)
    }
  })
})
