/**
 * Tests for production persistence: the domain-store adaptation and the
 * one-time legacy-domain migration ([rename-migration], `dsh_fork` →
 * `dsh_session_fork`).
 * @module dsh-session-fork/tests/store.test
 */

import { describe, expect, test } from 'bun:test'
import { createDomainStore, migrateLegacyDomain } from '../src/store.ts'
import type { DomainLike } from '../src/store.ts'
import type { BranchRecord, RegistryState } from '../src/types.ts'

function rootBranch(name: string, sessionId: string): BranchRecord {
  return { name, sessionId, forkOrigin: null, createdAt: '2026-01-01T00:00:00.000Z' }
}

function stateOf(entries: Array<[string, string]>): RegistryState {
  return {
    branches: Object.fromEntries(entries.map(([name, sessionId]) => [name, rootBranch(name, sessionId)])),
  }
}

/** In-memory fake of one open storage domain, shaped like `ctx.storageDomain.open(spec)`. */
function createFakeDomain(
  initial: Record<string, RegistryState> = {},
): DomainLike & { dump(): Record<string, RegistryState> } {
  const records = new Map(Object.entries(initial))
  return {
    table(name: 'branches') {
      return {
        get: (key) => records.get(key),
        put: async (key, value) => { records.set(key, value) },
        entries: () => records.entries(),
        get size() { return records.size },
      }
    },
    close: async () => {},
    dump: () => Object.fromEntries(records),
  }
}

describe('migrateLegacyDomain', () => {
  const oldState = stateOf([['main', 's1'], ['review', 's2']])

  test('old data + empty target → all workspace records are copied', async () => {
    const target = createFakeDomain()
    const legacy = createFakeDomain({ '/work': oldState })
    const migrated = await migrateLegacyDomain(target, async () => legacy)
    expect(migrated).toBe(1)
    expect(target.dump()).toEqual({ '/work': oldState })
    // The legacy medium is kept as a backup and stays untouched.
    expect(legacy.dump()).toEqual({ '/work': oldState })
  })

  test('both have data → nothing is copied and the legacy domain is never opened', async () => {
    const newState = stateOf([['trunk', 's9']])
    const target = createFakeDomain({ '/work': newState })
    const legacy = createFakeDomain({ '/work': oldState })
    let opened = false
    const migrated = await migrateLegacyDomain(target, async () => {
      opened = true
      return legacy
    })
    expect(migrated).toBe(0)
    expect(opened).toBe(false)
    expect(target.dump()).toEqual({ '/work': newState })
    expect(legacy.dump()).toEqual({ '/work': oldState })
  })

  test('an empty legacy domain migrates nothing', async () => {
    const target = createFakeDomain()
    const legacy = createFakeDomain()
    expect(await migrateLegacyDomain(target, async () => legacy)).toBe(0)
    expect(target.dump()).toEqual({})
  })

  test('closes the legacy domain even when a copy fails', async () => {
    let closed = false
    const legacy: DomainLike = {
      table: () => ({
        get: () => undefined,
        put: async () => {},
        entries: () => new Map<string, RegistryState>([['/work', oldState]]).entries(),
        size: 1,
      }),
      close: async () => { closed = true },
    }
    const failingTarget: DomainLike = {
      table: () => ({
        get: () => undefined,
        put: async () => { throw new Error('backend down') },
        entries: () => new Map<string, RegistryState>().entries(),
        size: 0,
      }),
      close: async () => {},
    }
    await expect(migrateLegacyDomain(failingTarget, async () => legacy)).rejects.toThrow('backend down')
    expect(closed).toBe(true)
  })
})

describe('createDomainStore', () => {
  test('adapts one workspace key to the registry seam', async () => {
    const domain = createFakeDomain()
    const store = createDomainStore(domain, '/work')
    expect(await store.load()).toBeNull()
    await store.save(stateOf([['main', 's1']]))
    expect((await store.load())?.branches['main']?.sessionId).toBe('s1')
  })
})
