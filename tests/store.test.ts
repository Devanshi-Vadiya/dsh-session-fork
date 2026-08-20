/**
 * Tests for production persistence: the domain-store adaptation.
 * @module dsh-session-fork/tests/store.test
 */

import { describe, expect, test } from 'bun:test'
import { createDomainStore } from '../src/store.ts'
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

describe('createDomainStore', () => {
  test('adapts one workspace key to the registry seam', async () => {
    const domain = createFakeDomain()
    const store = createDomainStore(domain, '/work')
    expect(await store.load()).toBeNull()
    await store.save(stateOf([['main', 's1']]))
    expect((await store.load())?.branches['main']?.sessionId).toBe('s1')
  })
})
