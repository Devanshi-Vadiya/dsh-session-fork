/**
 * Tests for the cross-branch merge-region authority: LCA cases, coordinate
 * mapping, balance gates, and registry-cycle safety — all against fake
 * sessions and hand-built registry states, no cordis.
 * @module dsh-session-fork/tests/merge-region.test
 */

import { describe, expect, test } from 'bun:test'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { mergeRegion } from '../src/merge-region.js'
import type { RegistryState } from '../src/types.js'

/** One raw fake log event; its array index becomes its seq. */
interface FakeEvent {
  type: string
  data?: unknown
}

/** Build a fake Session over raw events and a surface node list. */
function fakeSession(
  id: string,
  rawEvents: readonly FakeEvent[],
  surfaceSeqs: readonly number[],
  inheritedEventCount = 0,
): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  return {
    id,
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface: { nodes: [...surfaceSeqs], replaceGeneration: 1 },
    header: { isSeeded: true, inheritedEventCount },
    inheritedEventCount,
  } as unknown as Session
}

/** Hand-build one registry record's state: name → (sessionId, parent, atSeq). */
function registry(
  edges: readonly { name: string; sessionId: string; parent?: string; atSeq?: number }[],
): RegistryState {
  const branches: Record<string, { name: string; sessionId: string; forkOrigin: { parentSessionId: string; atSeq: number } | null }> = {}
  for (const edge of edges) {
    branches[edge.name] = {
      name: edge.name,
      sessionId: edge.sessionId,
      forkOrigin: edge.parent === undefined || edge.atSeq === undefined
        ? null
        : { parentSessionId: edge.parent, atSeq: edge.atSeq },
    }
  }
  return { branches } as unknown as RegistryState
}

describe('mergeRegion: LCA cases', () => {
  test('direct parent: seed boundary, exactly the old post-fork logic', () => {
    // main(s-a) ← review(s-r); review forked at atSeq 0, seed ends at seq 1.
    const state = registry([
      { name: 'main', sessionId: 's-a' },
      { name: 'review', sessionId: 's-r', parent: 's-a', atSeq: 0 },
    ])
    const source = fakeSession('s-r', [
      { type: 'user/message' },        // 0: inherited from main
      { type: 'session/end-seed' },    // 1: seed boundary
      { type: 'user/message' },        // 2: review's own
      { type: 'user/message' },        // 3: review's own
    ], [0, 2, 3], 1)
    const region = mergeRegion(state, source, 's-a')
    expect(region).toMatchObject({ start: 2, end: 3, relation: 'direct-parent', lcaSessionId: 's-a' })
  })

  test('deeper ancestor: boundary is the fork edge leaving the target', () => {
    // main(s-a) ← dev(s-d, forked at atSeq 1) ← review(s-r, forked at seq 4).
    // review's log: [0,1]=main content via dev, [2]=dev's own, [4]=end-seed, [5,6]=review's own.
    const state = registry([
      { name: 'main', sessionId: 's-a' },
      { name: 'dev', sessionId: 's-d', parent: 's-a', atSeq: 1 },
      { name: 'review', sessionId: 's-r', parent: 's-d', atSeq: 4 },
    ])
    const source = fakeSession('s-r', [
      { type: 'user/message' },        // 0: main's content (inherited twice)
      { type: 'user/message' },        // 1: main's content — boundary is AFTER this
      { type: 'user/message' },        // 2: dev's own work
      { type: 'session/end-seed' },    // 3: marker
      { type: 'user/message' },        // 4 (inside seed)
      { type: 'user/message' },        // 5: review's own
      { type: 'user/message' },        // 6: review's own
    ], [0, 1, 2, 5, 6])
    // Region = everything after main's fork edge (atSeq 1): dev's + review's work.
    expect(mergeRegion(state, source, 's-a')).toMatchObject({
      start: 2, end: 6, relation: 'ancestor', lcaSessionId: 's-a',
    })
  })

  test('distant relatives: boundary is the source fork edge off the shared ancestor', () => {
    // shared(s-c) ← left(s-l, atSeq 1) and shared(s-c) ← right(s-r2, atSeq 2).
    // Transfer right → left: region = right's content after leaving shared (atSeq 2).
    const state = registry([
      { name: 'shared', sessionId: 's-c' },
      { name: 'left', sessionId: 's-l', parent: 's-c', atSeq: 1 },
      { name: 'right', sessionId: 's-r2', parent: 's-c', atSeq: 2 },
    ])
    const source = fakeSession('s-r2', [
      { type: 'user/message' },        // 0: shared prefix
      { type: 'user/message' },        // 1: shared prefix (left also has this)
      { type: 'user/message' },        // 2: shared prefix — boundary is AFTER this
      { type: 'user/message' },        // 3: right's own
      { type: 'user/message' },        // 4: right's own
    ], [0, 1, 2, 3, 4])
    expect(mergeRegion(state, source, 's-l')).toMatchObject({
      start: 3, end: 4, relation: 'relative', lcaSessionId: 's-c',
    })
  })

  test('source is the ancestor of the target: region is what the target lacks', () => {
    // main(s-a) ← review(s-r, forked at atSeq 2). Transfer main → review.
    const state = registry([
      { name: 'main', sessionId: 's-a' },
      { name: 'review', sessionId: 's-r', parent: 's-a', atSeq: 2 },
    ])
    const source = fakeSession('s-a', [
      { type: 'user/message' },        // 0
      { type: 'user/message' },        // 1
      { type: 'user/message' },        // 2: review forked after this
      { type: 'user/message' },        // 3: main's work review never saw
      { type: 'user/message' },        // 4
    ], [0, 1, 2, 3, 4])
    expect(mergeRegion(state, source, 's-r')).toMatchObject({
      start: 3, end: 4, relation: 'source-ancestor', lcaSessionId: 's-a',
    })
  })

  test('no kinship: the whole conversation transfers', () => {
    const state = registry([
      { name: 'alpha', sessionId: 's-1' },
      { name: 'beta', sessionId: 's-2' },
    ])
    const source = fakeSession('s-2', [
      { type: 'user/message' },
      { type: 'user/message' },
    ], [0, 1])
    expect(mergeRegion(state, source, 's-1')).toMatchObject({
      start: 0, end: 1, relation: 'unrelated',
    })
    expect(mergeRegion(state, source, 's-1')).not.toHaveProperty('lcaSessionId')
  })

  test('an unregistered source lineage degrades to unrelated, not a crash', () => {
    // Target chain exists, source has no record at all.
    const state = registry([
      { name: 'main', sessionId: 's-a' },
      { name: 'dev', sessionId: 's-d', parent: 's-a', atSeq: 0 },
    ])
    const source = fakeSession('s-stranger', [{ type: 'user/message' }], [0])
    expect(mergeRegion(state, source, 's-a')).toMatchObject({
      start: 0, end: 0, relation: 'unrelated',
    })
  })
})

describe('mergeRegion: gates and guards', () => {
  const parentState = registry([
    { name: 'main', sessionId: 's-a' },
    { name: 'review', sessionId: 's-r', parent: 's-a', atSeq: 1 },
  ])

  test('empty region: the source has no content past the fork boundary', () => {
    const source = fakeSession('s-r', [
      { type: 'user/message' },        // 0: inherited
      { type: 'session/end-seed' },    // 1: seed boundary
    ], [0])
    const result = mergeRegion(parentState, source, 's-a')
    expect(result).toMatchObject({ kind: 'error', code: 'empty-region' })
  })

  test('same session id throws defensively', () => {
    const source = fakeSession('s-r', [{ type: 'user/message' }], [0])
    expect(() => mergeRegion(parentState, source, 's-r')).toThrow(/same session/)
  })

  test('a registry cycle terminates and degrades to unrelated', () => {
    const cyclic = registry([
      { name: 'loop-a', sessionId: 's-x', parent: 's-y', atSeq: 0 },
      { name: 'loop-b', sessionId: 's-y', parent: 's-x', atSeq: 0 },
      { name: 'main', sessionId: 's-a' },
    ])
    const source = fakeSession('s-x', [{ type: 'user/message' }, { type: 'user/message' }], [0, 1])
    // The cycle breaks the ancestry walk; s-x and s-a share nothing.
    expect(mergeRegion(cyclic, source, 's-a')).toMatchObject({ relation: 'unrelated' })
  })

  test('direct parent with no seed marker maps the squash error, not a throw', () => {
    const source = fakeSession('s-r', [{ type: 'user/message' }], [0])
    const result = mergeRegion(parentState, source, 's-a')
    expect(result).toMatchObject({ kind: 'error', code: 'missing-seed-boundary' })
  })
})
