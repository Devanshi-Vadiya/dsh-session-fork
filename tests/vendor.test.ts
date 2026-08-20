/**
 * Tests for the vendored fork helpers: the seed-balance invariant (orphan
 * `command/run` must never enter a seed) and vendor-replication marker
 * integrity.
 * @module dsh-session-fork/tests/vendor.test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SourceEvent } from '../src/branch.js'
import { anchoredBoundaryOf } from '../src/vendor/fork.js'

/** Build a fake event; `data` defaults to nothing. */
function ev(seq: number, type: string, data?: unknown): SourceEvent {
  return data === undefined ? { seq, type } : { seq, type, data }
}

describe('vendored seed-balance invariant', () => {
  // A session mid-command: turn 1 completed, then our own /branch command's
  // `command/run` (its `command/done` is only appended after the handler
  // returns — i.e. after the fork already happened).
  const midCommand = [
    ev(0, 'turn/start'),
    ev(1, 'message/user'),
    ev(2, 'message/assistant'),
    ev(3, 'turn/end'),
    ev(4, 'command/run', { commandId: 'cmd-1', name: 'branch' }),
  ]

  test('fork during a command: seed excludes the orphan command/run', () => {
    // Regression lock: the cut backs up to before the unpaired run instead
    // of extending through it, or the child renders the command as still
    // executing forever.
    expect(anchoredBoundaryOf(midCommand)).toEqual({ boundarySeq: 3, cut: 4 })
  })

  test('a paired command/run stays inside the seed', () => {
    const balanced = [
      ev(0, 'turn/start'),
      ev(1, 'message/user'),
      ev(2, 'turn/end'),
      ev(3, 'command/run', { commandId: 'cmd-earlier' }),
      ev(4, 'command/done', { commandId: 'cmd-earlier', kind: 'success' }),
      ev(5, 'command/run', { commandId: 'cmd-open' }),
    ]
    expect(anchoredBoundaryOf(balanced)).toEqual({ boundarySeq: 2, cut: 5 })
  })

  test('backed-up cut still lands on the anchoring turn end (record seq untouched)', () => {
    expect(anchoredBoundaryOf(midCommand)?.boundarySeq).toBe(3)
  })

  test('no orphan tail: plain cut extension is unchanged', () => {
    const plain = [
      ev(0, 'turn/start'),
      ev(1, 'turn/end'),
      ev(2, 'session/title'),
    ]
    expect(anchoredBoundaryOf(plain)).toEqual({ boundarySeq: 1, cut: 3 })
  })

  test('interleaved commands pair by id: runA runB doneA doneB is not an orphan', () => {
    // The done for B arrives before A's own done — done-id set scanning
    // still pairs correctly here, but the pairing must be per-id, so this
    // case locks the balanced outcome for the stack sweep.
    const interleaved = [
      ev(0, 'turn/start'),
      ev(1, 'turn/end'),
      ev(2, 'command/run', { commandId: 'cmd-A' }),
      ev(3, 'command/run', { commandId: 'cmd-B' }),
      ev(4, 'command/done', { commandId: 'cmd-A', kind: 'success' }),
      ev(5, 'command/done', { commandId: 'cmd-B', kind: 'success' }),
    ]
    expect(anchoredBoundaryOf(interleaved)).toEqual({ boundarySeq: 1, cut: 6 })
  })

  test('interleaved with a missing done: cut backs up to before the orphan run', () => {
    const missingDoneA = [
      ev(0, 'turn/start'),
      ev(1, 'turn/end'),
      ev(2, 'command/run', { commandId: 'cmd-A' }),
      ev(3, 'command/run', { commandId: 'cmd-B' }),
      ev(4, 'command/done', { commandId: 'cmd-B', kind: 'success' }),
    ]
    expect(anchoredBoundaryOf(missingDoneA)).toEqual({ boundarySeq: 1, cut: 2 })
  })

  test('same id reopened after a paired close is still an orphan', () => {
    // doneA pairs with the most recent runA (LIFO per id), so the second
    // runA stays unpaired and the cut must land before it.
    const reopened = [
      ev(0, 'turn/start'),
      ev(1, 'turn/end'),
      ev(2, 'command/run', { commandId: 'cmd-A' }),
      ev(3, 'command/done', { commandId: 'cmd-A', kind: 'success' }),
      ev(4, 'command/run', { commandId: 'cmd-A' }),
    ]
    expect(anchoredBoundaryOf(reopened)).toEqual({ boundarySeq: 1, cut: 4 })
  })
})

describe('vendor marker integrity', () => {
  const source = readFileSync(new URL('../src/vendor/fork.ts', import.meta.url), 'utf8')
  // Only inline code-comment markers count; the file-header policy blurb
  // mentions the markers by name and must not.
  const markers = (kind: string): number =>
    source.match(new RegExp(`^\\s*// \\[fork:${kind}\\]`, 'gm'))?.length ?? 0

  test('exactly one [fork:surgery] marker', () => {
    expect(markers('surgery')).toBe(1)
  })

  test('exactly two [fork:adapt] markers', () => {
    expect(markers('adapt')).toBe(2)
  })

  test('records the upstream commit SHA', () => {
    expect(source).toContain('99f6f02fecdb7dff40c3fbc9470f5907c29f74ca')
  })
})
