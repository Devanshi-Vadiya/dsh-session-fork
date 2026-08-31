import { describe, expect, test } from 'bun:test'
import {
  BRANCH_IDENTITY_ORDER,
  BRANCH_IDENTITY_SECTION,
  branchIdentityLine,
  branchIdentityProvider,
  createBranchIdentity,
  identityTrackingStore,
} from '../src/branch-identity.js'
import type { DomainLike } from '../src/store.js'
import type { BranchRecord, RegistryState, RegistryStore } from '../src/types.js'

/**
 * The ambient identity section (issue #28, phase 2). These tests pin the
 * one-line statements the provider emits, the sync cache's three refresh
 * points (save mirror, warm enumeration, miss fallback), and the
 * degradation contracts: no agent subject, no branch, no workspace — no
 * line, deterministically.
 */

const record = (name: string, sessionId: string, parentSessionId: string | null): BranchRecord => ({
  name,
  sessionId,
  forkOrigin: parentSessionId === null
    ? null
    : { parentSessionId, atSeq: 10 },
  createdAt: '2026-08-31T00:00:00.000Z',
})

const stateOf = (branches: BranchRecord[]): RegistryState => ({ branches: Object.fromEntries(branches.map(b => [b.name, b])) })

/** Fake domain whose `branches` table serves the given workspace records. */
const domainOf = (records: ReadonlyMap<string, RegistryState>): DomainLike => {
  const store = new Map(records)
  return {
    table() {
      return {
        get: (key: string) => store.get(key),
        async put(key: string, value: RegistryState) { store.set(key, value) },
        entries: () => store.entries(),
        size: store.size,
      }
    },
    async close() {},
  }
}

const agentContext = (sessionId: string, cwd: string): object => ({
  agent: { session: { id: sessionId, header: { cwd } } },
})

describe('branchIdentityLine', () => {
  test('a root branch states the workspace-root fact', () => {
    expect(branchIdentityLine([{ name: 'main', parentName: null }]))
      .toBe('You are on branch "main" — the root branch of this workspace.')
  })

  test('a fork branch names its parent', () => {
    expect(branchIdentityLine([{ name: 'feat/x', parentName: 'main' }]))
      .toBe('You are on branch "feat/x", forked from branch "main".')
  })

  test('several names on one session are listed honestly', () => {
    expect(branchIdentityLine([{ name: 'a', parentName: null }, { name: 'b', parentName: 'main' }]))
      .toBe('You are on branches "a", "b" — one session carrying two names.')
  })

  test('no branch renders nothing', () => {
    expect(branchIdentityLine([])).toBe('')
  })
})

describe('branch identity cache', () => {
  test('updateFromSave mirrors a save into the sync read plane', async () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    expect(identity.lineFor('/ws', 's-1')).toBe('')
    identity.updateFromSave('/ws', stateOf([record('main', 's-1', null)]))
    expect(identity.lineFor('/ws', 's-1'))
      .toBe('You are on branch "main" — the root branch of this workspace.')
  })

  test('parent names resolve within the saved state', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    identity.updateFromSave('/ws', stateOf([
      record('main', 's-1', null),
      record('feat/x', 's-2', 's-1'),
    ]))
    expect(identity.lineFor('/ws', 's-2')).toBe('You are on branch "feat/x", forked from branch "main".')
  })

  test('refresh enumerates every workspace of the domain table', async () => {
    const identity = createBranchIdentity(domainOf(new Map([
      ['/a', stateOf([record('main', 's-1', null)])],
      ['/b', stateOf([record('develop', 's-9', null)])],
    ])))
    await identity.refresh()
    expect(identity.lineFor('/a', 's-1')).toContain('"main"')
    expect(identity.lineFor('/b', 's-9')).toContain('"develop"')
    expect(identity.lineFor('/a', 's-9')).toBe('')
  })

  test('a cache miss degrades to no line, then the fallback refresh lands', async () => {
    const identity = createBranchIdentity(domainOf(new Map([
      ['/ws', stateOf([record('main', 's-1', null)])],
    ])))
    expect(identity.lineFor('/ws', 's-1')).toBe('')
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(identity.lineFor('/ws', 's-1')).toContain('"main"')
  })
})

describe('identityTrackingStore', () => {
  test('save mirrors the state after the durable write resolves', async () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    const saved: RegistryState[] = []
    const base: RegistryStore = {
      async load() { return null },
      async save(state) { saved.push(state) },
    }
    const tracked = identityTrackingStore(base, '/ws', identity)
    const state = stateOf([record('main', 's-1', null)])
    await tracked.save(state)
    expect(saved).toEqual([state])
    expect(identity.lineFor('/ws', 's-1')).toContain('"main"')
  })

  test('load stays a pure delegation', async () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    const state = stateOf([record('main', 's-1', null)])
    const base: RegistryStore = {
      async load() { return state },
      async save() {},
    }
    await expect(identityTrackingStore(base, '/ws', identity).load()).resolves.toBe(state)
  })
})

describe('branchIdentityProvider', () => {
  test('resolves the assembling agent through the structural slice', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    identity.updateFromSave('/ws', stateOf([record('main', 's-1', null)]))
    const provider = branchIdentityProvider(identity)
    expect(provider(agentContext('s-1', '/ws') as never)).toContain('"main"')
  })

  test('no agent subject degrades to no line', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    identity.updateFromSave('', stateOf([record('main', 's-1', null)]))
    expect(branchIdentityProvider(identity)({} as never)).toBe('')
  })

  test('a session without a session id degrades to no line', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    expect(branchIdentityProvider(identity)({ agent: { session: { header: { cwd: '/ws' } } } } as never)).toBe('')
  })

  test('a branch-less session (subagent, un-adopted) degrades to no line', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    identity.updateFromSave('/ws', stateOf([record('main', 's-1', null)]))
    expect(branchIdentityProvider(identity)(agentContext('s-other', '/ws') as never)).toBe('')
  })

  test('an agent without cwd addresses the empty-string workspace', () => {
    const identity = createBranchIdentity(domainOf(new Map()))
    identity.updateFromSave('', stateOf([record('main', 's-1', null)]))
    expect(branchIdentityProvider(identity)(agentContext('s-1', '') as never)).toContain('"main"')
  })
})

describe('branch identity section registration facts', () => {
  test('the section name is plugin-prefixed and distinct from the vocabulary', () => {
    expect(BRANCH_IDENTITY_SECTION).toBe('dsh-session-fork:identity')
    expect(BRANCH_IDENTITY_SECTION).not.toBe('dsh-session-fork:vocabulary')
  })

  test('the order rides directly after the vocabulary section', () => {
    expect(BRANCH_IDENTITY_ORDER).toBe(2960)
    expect(BRANCH_IDENTITY_ORDER).toBeGreaterThan(2950)
    expect(BRANCH_IDENTITY_ORDER).toBeLessThan(5000)
  })
})
