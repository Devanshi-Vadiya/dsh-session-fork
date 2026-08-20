/**
 * Tests for the dsh-session-fork branch registry: pure transforms, typed errors,
 * dangling marking, and persistence round-trips (memory + real file).
 * @module dsh-session-fork/tests/registry.test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BranchRegistryError,
  assertBranchNameFree,
  createBranch,
  createFileStore,
  emptyState,
  getBranch,
  listBranches,
  loadRegistry,
  removeBranch,
  renameBranch,
  saveRegistry,
  setBranchSession,
} from '../src/registry.ts'
import type { RegistryState, RegistryStore } from '../src/types.ts'

/** In-memory fake storage with the restart semantics of a real medium. */
function createMemoryStore(): RegistryStore & { dump(): RegistryState | null } {
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

function rootBranch(name: string, sessionId: string): Parameters<typeof createBranch>[1] {
  return { name, sessionId, forkOrigin: null, createdAt: '2026-01-01T00:00:00.000Z' }
}

describe('createBranch', () => {
  test('adds a record and freezes the new state', () => {
    const state = createBranch(emptyState(), rootBranch('main', 's1'))
    expect(Object.keys(state.branches)).toEqual(['main'])
    expect(state.branches['main']!.sessionId).toBe('s1')
    expect(state.branches['main']!.forkOrigin).toBeNull()
    expect(Object.isFrozen(state.branches)).toBe(true)
    expect(Object.isFrozen(state.branches['main'])).toBe(true)
  })

  test('keeps fork origin with parent session id and seq', () => {
    const state = createBranch(emptyState(), {
      name: 'review',
      sessionId: 's2',
      forkOrigin: { parentSessionId: 's1', atSeq: 42 },
    })
    expect(state.branches['review']!.forkOrigin).toEqual({ parentSessionId: 's1', atSeq: 42 })
  })

  test('duplicate name fails with typed error and no state change', () => {
    const state = createBranch(emptyState(), rootBranch('main', 's1'))
    expect(() => createBranch(state, rootBranch('main', 's2'))).toThrow(BranchRegistryError)
    try {
      createBranch(state, rootBranch('main', 's2'))
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('duplicate-name')
    }
    expect(Object.keys(state.branches)).toEqual(['main'])
  })

  test.each(['', ' padded', 'pad ', 'a\nb'])('invalid name %p fails', (name) => {
    try {
      createBranch(emptyState(), rootBranch(name, 's1'))
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('invalid-name')
    }
  })
})

describe('assertBranchNameFree', () => {
  test('accepts a fresh valid name without registering anything', () => {
    const state = createBranch(emptyState(), rootBranch('main', 's1'))
    expect(() => assertBranchNameFree(state, 'dev')).not.toThrow()
    expect(Object.keys(state.branches)).toEqual(['main'])
  })

  test('duplicate name fails with duplicate-name', () => {
    const state = createBranch(emptyState(), rootBranch('main', 's1'))
    try {
      assertBranchNameFree(state, 'main')
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('duplicate-name')
    }
  })

  test.each(['', ' padded', 'a\nb'])('invalid name %p fails with invalid-name', (name) => {
    try {
      assertBranchNameFree(emptyState(), name)
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('invalid-name')
    }
  })
})

describe('getBranch', () => {
  test('returns the record', () => {
    const state = createBranch(emptyState(), rootBranch('main', 's1'))
    expect(getBranch(state, 'main').name).toBe('main')
  })

  test('unknown branch fails with typed error', () => {
    try {
      getBranch(emptyState(), 'nope')
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('unknown-branch')
    }
  })
})

describe('renameBranch', () => {
  test('moves the record under the new name', () => {
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = renameBranch(state, 'main', 'trunk')
    expect(Object.keys(state.branches)).toEqual(['trunk'])
    expect(getBranch(state, 'trunk').sessionId).toBe('s1')
  })

  test('renaming onto an existing name fails', () => {
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = createBranch(state, rootBranch('dev', 's2'))
    try {
      renameBranch(state, 'main', 'dev')
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('duplicate-name')
    }
  })

  test('renaming an unknown branch fails', () => {
    try {
      renameBranch(emptyState(), 'ghost', 'trunk')
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('unknown-branch')
    }
  })
})

describe('removeBranch', () => {
  test('deletes only the named branch', () => {
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = createBranch(state, rootBranch('dev', 's2'))
    state = removeBranch(state, 'main')
    expect(Object.keys(state.branches)).toEqual(['dev'])
  })

  test('unknown branch fails', () => {
    try {
      removeBranch(emptyState(), 'ghost')
      expect.unreachable()
    } catch (error) {
      expect((error as BranchRegistryError).code).toBe('unknown-branch')
    }
  })
})

describe('setBranchSession', () => {
  test('repoints the ref', () => {
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = setBranchSession(state, 'main', 's9')
    expect(getBranch(state, 'main').sessionId).toBe('s9')
  })
})

describe('listBranches', () => {
  test('marks dangling refs when the session file does not exist', async () => {
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = createBranch(state, rootBranch('gone', 's-deleted'))
    const listings = await listBranches(state, (id) => id !== 's-deleted')
    expect(listings.map((l) => [l.record.name, l.dangling])).toEqual([
      ['gone', true],
      ['main', false],
    ])
  })

  test('returns listings sorted by name', async () => {
    let state = createBranch(emptyState(), rootBranch('zeta', 's1'))
    state = createBranch(state, rootBranch('alpha', 's1'))
    const listings = await listBranches(state, () => true)
    expect(listings.map((l) => l.record.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('persistence', () => {
  test('memory store round-trips a full registry', async () => {
    const store = createMemoryStore()
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = createBranch(state, {
      name: 'review',
      sessionId: 's2',
      forkOrigin: { parentSessionId: 's1', atSeq: 7 },
    })
    await saveRegistry(store, state)
    const restored = await loadRegistry(store)
    expect(restored.branches['review']!.forkOrigin).toEqual({
      parentSessionId: 's1',
      atSeq: 7,
    })
  })

  test('load of a never-written store yields an empty state', async () => {
    const state = await loadRegistry(createMemoryStore())
    expect(Object.keys(state.branches)).toEqual([])
  })

  test('file store survives a restart via a real file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-session-fork-test-'))
    afterAll(() => {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    })
    const path = join(dir, 'nested', 'branches.json')
    let state = createBranch(emptyState(), rootBranch('main', 's1'))
    state = createBranch(state, {
      name: 'review',
      sessionId: 's2',
      forkOrigin: { parentSessionId: 's1', atSeq: 42 },
    })
    const first = createFileStore(path)
    await saveRegistry(first, state)
    // The medium is a real readable JSON file with atomic rename semantics:
    // no leftover temp files next to it.
    const raw = JSON.parse(await readFile(path, 'utf8')) as RegistryState
    expect(raw.branches['main']!.sessionId).toBe('s1')
    // A "restart" is a brand-new store instance over the same path.
    const second = createFileStore(path)
    const restored = await loadRegistry(second)
    expect(restored).toEqual(state)
    const relisted = await listBranches(restored, () => true)
    expect(relisted).toHaveLength(2)
  })
})
