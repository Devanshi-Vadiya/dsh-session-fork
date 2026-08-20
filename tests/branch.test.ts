/**
 * Tests for branch creation: boundary anchoring, the single seeded-child
 * fork route (live and cold sources alike), root adoption, and
 * missing-source errors.
 * @module dsh-session-fork/tests/branch.test
 */

import { describe, expect, test } from 'bun:test'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import {
  BranchForkError,
  createBranchFrom,
  createRootBranch,
} from '../src/branch.js'
import type { BranchPorts } from '../src/branch.js'
import { anchoredBoundaryOf } from '../src/vendor/fork.js'

interface Call {
  readonly kind: 'createChildFromSeed'
  readonly sourceId: string
  readonly cut: number
  readonly childId: string
}

/** Build a fake source log from a compact event-type list. */
function sessionOf(id: string, types: readonly string[]): SourceSessionView {
  const events: SourceEvent[] = types.map((type, seq) => ({ seq, type }))
  return { id, events, header: {} }
}

/**
 * Fake ports recording every child-creation call. There is exactly one
 * production route — the seeded `agents.create` path — for live and cold
 * sources alike, so the fake needs no liveness scripting.
 */
function portsOf(sessions: readonly SourceSessionView[]): BranchPorts & { calls: readonly Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async readSession(sessionId) {
      return sessions.find(s => s.id === sessionId) ?? null
    },
    async createChildFromSeed(childId, source, cut) {
      calls.push({
        kind: 'createChildFromSeed',
        sourceId: source.id,
        cut,
        childId,
      })
    },
  }
}

describe('anchoredBoundaryOf', () => {
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
    expect(anchoredBoundaryOf(sessionOf('s', log).events)).toEqual({ boundarySeq: 8, cut: 9 })
  })

  test('cut extends through trailing standalone events to the next turn/start', () => {
    const withTail = [...log, 'session/title', 'session/title']
    expect(anchoredBoundaryOf(sessionOf('s', withTail).events)).toEqual({
      boundarySeq: 8,
      cut: 11,
    })
  })

  test('in-log anchor resolves to the turn/end containing it', () => {
    // atSeq 1 lives inside the first turn; its turn/end is seq 3.
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 1)).toEqual({ boundarySeq: 3, cut: 5 })
  })

  test('anchor exactly on a turn/end uses that turn', () => {
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 3)).toEqual({ boundarySeq: 3, cut: 5 })
  })

  test('anchor inside an open (last) turn fails', () => {
    const openLog = [...log, 'turn/start', 'message/user']
    expect(anchoredBoundaryOf(sessionOf('s', openLog).events, 10)).toBeNull()
  })

  test('no completed turn at all fails', () => {
    expect(anchoredBoundaryOf(sessionOf('s', ['turn/start', 'message/user']).events)).toBeNull()
    expect(anchoredBoundaryOf(sessionOf('s', []).events)).toBeNull()
  })

  test('past-end anchor falls back to the last completed turn', () => {
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 999)).toEqual({ boundarySeq: 8, cut: 9 })
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

  test('live and cold sources take the single seeded-child route', async () => {
    // Regression lock: a branch never goes through the kernel
    // SessionStore.fork shortcut. Every child — from a live source read via
    // ctx.sessions or a cold one read via persistence — is produced by one
    // createChildFromSeed call (production: agents.create + workspace
    // attach, exactly like the web GUI's fork).
    const ports = portsOf([sessionOf('parent', log)])
    const live = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    const cold = await createBranchFrom('parent', 'review-2', ports, { childId: 'child-2' })
    expect(live.forkOrigin).toEqual({ parentSessionId: 'parent', atSeq: 8 })
    expect(cold.forkOrigin).toEqual({ parentSessionId: 'parent', atSeq: 8 })
    expect(ports.calls).toEqual([
      { kind: 'createChildFromSeed', sourceId: 'parent', cut: 9, childId: 'child-1' },
      { kind: 'createChildFromSeed', sourceId: 'parent', cut: 9, childId: 'child-2' },
    ])
  })

  test('record is frozen and carries the anchoring turn/end', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const record = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    expect(record).toEqual({
      name: 'review',
      sessionId: 'child-1',
      forkOrigin: { parentSessionId: 'parent', atSeq: 8 },
      createdAt: record.createdAt,
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('atSeq lands on the containing turn/end in the record', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const record = await createBranchFrom('parent', 'early', ports, {
      atSeq: 1,
      childId: 'child-3',
    })
    expect(record.forkOrigin!.atSeq).toBe(3)
    // Seed extends through the trailing session/title up to the next
    // turn/start, so the seeded slice is cut 5 events long.
    expect(ports.calls[0]!.cut).toBe(5)
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
    const ports = portsOf([sessionOf('parent', log)])
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
