/**
 * Tests for branch creation: boundary anchoring, live/cold fork routes,
 * root adoption, and missing-source errors.
 * @module dsh-fork/tests/branch.test
 */

import { describe, expect, test } from 'bun:test'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import {
  BranchForkError,
  createBranchFrom,
  createRootBranch,
  forkBoundaryOf,
} from '../src/branch.js'
import type { BranchPorts } from '../src/branch.js'

interface Call {
  readonly kind: 'forkLive' | 'createChildFromSeed'
  readonly sourceId: string
  readonly boundarySeq: number
  readonly cut: number
  readonly childId: string
}

/** Build a fake source log from a compact event-type list. */
function sessionOf(id: string, types: readonly string[]): SourceSessionView {
  const events: SourceEvent[] = types.map((type, seq) => ({ seq, type }))
  return { id, events, header: {} }
}

/**
 * Fake ports with a scriptable liveness answer; records every fork call.
 */
function portsOf(
  sessions: readonly SourceSessionView[],
  liveIds: readonly string[] = [],
): BranchPorts & { calls: readonly Call[] } {
  const calls: Call[] = []
  const live = new Set(liveIds)
  return {
    calls,
    async readSession(sessionId) {
      return sessions.find(s => s.id === sessionId) ?? null
    },
    forkLive(sourceId, boundarySeq, childId) {
      calls.push({ kind: 'forkLive', sourceId, boundarySeq, cut: -1, childId })
      return live.has(sourceId)
    },
    async createChildFromSeed(childId, source, cut) {
      calls.push({
        kind: 'createChildFromSeed',
        sourceId: source.id,
        boundarySeq: -1,
        cut,
        childId,
      })
    },
  }
}

describe('forkBoundaryOf', () => {
  const log = [
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
    'session/title',
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
  ]

  test('no anchor: last completed turn/end', () => {
    expect(forkBoundaryOf(sessionOf('s', log).events)).toEqual({ turnEndSeq: 8, cut: 9 })
  })

  test('cut extends through trailing standalone events to the next turn/start', () => {
    const withTail = [...log, 'session/title', 'session/title']
    expect(forkBoundaryOf(sessionOf('s', withTail).events)).toEqual({
      turnEndSeq: 8,
      cut: 11,
    })
  })

  test('in-log anchor resolves to the turn/end containing it', () => {
    // atSeq 1 lives inside the first turn; its turn/end is seq 3.
    expect(forkBoundaryOf(sessionOf('s', log).events, 1)).toEqual({ turnEndSeq: 3, cut: 5 })
  })

  test('anchor exactly on a turn/end uses that turn', () => {
    expect(forkBoundaryOf(sessionOf('s', log).events, 3)).toEqual({ turnEndSeq: 3, cut: 5 })
  })

  test('anchor inside an open (last) turn fails', () => {
    const openLog = [...log, 'turn/start', 'message/user']
    expect(forkBoundaryOf(sessionOf('s', openLog).events, 10)).toBeNull()
  })

  test('no completed turn at all fails', () => {
    expect(forkBoundaryOf(sessionOf('s', ['turn/start', 'message/user']).events)).toBeNull()
    expect(forkBoundaryOf(sessionOf('s', []).events)).toBeNull()
  })

  test('past-end anchor falls back to the last completed turn', () => {
    expect(forkBoundaryOf(sessionOf('s', log).events, 999)).toEqual({ turnEndSeq: 8, cut: 9 })
  })
})

describe('createBranchFrom', () => {
  const log = [
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
    'session/title',
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
  ]

  test('live source forks through the kernel route', async () => {
    const ports = portsOf([sessionOf('parent', log)], ['parent'])
    const record = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    expect(record).toEqual({
      name: 'review',
      sessionId: 'child-1',
      forkOrigin: { parentSessionId: 'parent', atSeq: 8 },
      createdAt: record.createdAt,
    })
    expect(record.forkOrigin!.atSeq).toBe(8)
    expect(Object.isFrozen(record)).toBe(true)
    // Kernel boundary is the seq of the last seed event (cut-1).
    expect(ports.calls).toEqual([
      { kind: 'forkLive', sourceId: 'parent', boundarySeq: 8, cut: -1, childId: 'child-1' },
    ])
  })

  test('cold source creates a seeded child and records the same origin', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const record = await createBranchFrom('parent', 'review', ports, { childId: 'child-2' })
    expect(record.forkOrigin).toEqual({ parentSessionId: 'parent', atSeq: 8 })
    // The live route is probed first, reports "not live", and the seeded
    // creation path takes over with the full cut.
    expect(ports.calls).toEqual([
      { kind: 'forkLive', sourceId: 'parent', boundarySeq: 8, cut: -1, childId: 'child-2' },
      {
        kind: 'createChildFromSeed',
        sourceId: 'parent',
        boundarySeq: -1,
        cut: 9,
        childId: 'child-2',
      },
    ])
  })

  test('atSeq lands on the containing turn/end in the record', async () => {
    const ports = portsOf([sessionOf('parent', log)], ['parent'])
    const record = await createBranchFrom('parent', 'early', ports, {
      atSeq: 1,
      childId: 'child-3',
    })
    expect(record.forkOrigin!.atSeq).toBe(3)
    // Seed extends through the trailing session/title up to the next
    // turn/start (cut 5), so the kernel boundary is seq 4, not 3.
    expect(ports.calls[0]!.boundarySeq).toBe(4)
  })

  test('missing source fails with typed error', async () => {
    const ports = portsOf([])
    try {
      await createBranchFrom('ghost', 'x', ports)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BranchForkError)
      expect((error as BranchForkError).code).toBe('source-not-found')
    }
  })

  test('session with no completed turn fails with fork-unavailable', async () => {
    const ports = portsOf([sessionOf('parent', ['turn/start', 'message/user'])])
    try {
      await createBranchFrom('parent', 'x', ports)
      expect.unreachable()
    } catch (error) {
      expect((error as BranchForkError).code).toBe('fork-unavailable')
    }
  })

  test('generates a session-<uuid> child id when omitted', async () => {
    const ports = portsOf([sessionOf('parent', log)], ['parent'])
    const record = await createBranchFrom('parent', 'auto', ports)
    expect(record.sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
  })
})

describe('createRootBranch', () => {
  test('adopts an existing session with forkOrigin null', async () => {
    const ports = portsOf([sessionOf('s1', ['turn/end'])])
    const record = await createRootBranch('s1', 'main', ports)
    expect(record).toEqual({
      name: 'main',
      sessionId: 's1',
      forkOrigin: null,
      createdAt: record.createdAt,
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('missing session fails with typed error', async () => {
    const ports = portsOf([])
    try {
      await createRootBranch('ghost', 'main', ports)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BranchForkError)
      expect((error as BranchForkError).code).toBe('source-not-found')
    }
  })
})
