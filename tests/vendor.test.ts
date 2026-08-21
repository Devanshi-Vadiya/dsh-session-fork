/**
 * Tests for the vendored fork helpers: the seed-balance invariant (orphan
 * `command/run` must never enter a seed), the ensureSession resume kernel,
 * and vendor-replication marker integrity.
 * @module dsh-session-fork/tests/vendor.test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SourceEvent } from '../src/branch.js'
import { anchoredBoundaryOf, getOrResumeAgent } from '../src/vendor/fork.js'
import type { GetOrResumeDeps, ReadSessionState } from '../src/vendor/fork.js'

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

  test('exactly two [fork:surgery] markers', () => {
    expect(markers('surgery')).toBe(2)
  })

  test('exactly four [fork:adapt] markers', () => {
    expect(markers('adapt')).toBe(4)
  })

  test('records the upstream commit SHAs', () => {
    // The three original helpers keep their 99f6f02f citations; the later
    // getOrResumeAgent kernel records the checkout's current 528c682e.
    expect(source).toContain('99f6f02fecdb7dff40c3fbc9470f5907c29f74ca')
    expect(source).toContain('528c682e061696f5a160f363f236ecbf53cbd006')
  })
})

describe('vendored session-title limit integrity', () => {
  const source = readFileSync(new URL('../src/vendor/session-title-limit.ts', import.meta.url), 'utf8')
  // Only inline code-comment markers count; the file-header policy blurb
  // mentions the markers by name and must not.
  const markers = (kind: string): number =>
    source.match(new RegExp(`^\\s*// \\[fork:${kind}\\]`, 'gm'))?.length ?? 0

  test('exactly one [fork:adapt] marker and no surgery', () => {
    expect(markers('adapt')).toBe(1)
    expect(markers('surgery')).toBe(0)
  })

  test('records the upstream commit SHA and the exact YAML source', () => {
    expect(source).toContain('99f6f02fecdb7dff40c3fbc9470f5907c29f74ca')
    expect(source).toContain('packages/bundle/base/cordis.patch.yml:39-44')
  })

  test('pins the vendored byte budget to upstream maxTitleBytes', () => {
    // The deployed SessionTitleService enforces this exact budget on
    // session.rename; the registry gate must stay in lockstep with it.
    expect(source).toMatch(/export const upstreamMaxTitleBytes = 80\n/)
  })
})

describe('vendored session-title normalize integrity', () => {
  const source = readFileSync(new URL('../src/vendor/session-title-normalize.ts', import.meta.url), 'utf8')
  const markers = (kind: string): number =>
    source.match(new RegExp(`^\\s*// \\[fork:${kind}\\]`, 'gm'))?.length ?? 0

  test('exactly one [fork:adapt] marker (Buffer → TextEncoder) and no surgery', () => {
    expect(markers('adapt')).toBe(1)
    expect(markers('surgery')).toBe(0)
  })

  test('records the upstream commit SHA and the exact source file', () => {
    expect(source).toContain('528c682e061696f5a160f363f236ecbf53cbd006')
    expect(source).toContain('packages/session/session-title/src/normalize.ts')
  })
})

describe('vendored compact engine marker integrity', () => {
  const source = readFileSync(new URL('../src/vendor/compact.ts', import.meta.url), 'utf8')
  const markers = (kind: string): number =>
    source.match(new RegExp(`^\\s*// \\[fork:${kind}\\]`, 'gm'))?.length ?? 0

  test('records the upstream commit SHA', () => {
    expect(source).toContain('528c682e061696f5a160f363f236ecbf53cbd006')
  })

  test('exactly two [fork:surgery] markers (explicit region + full-surface input)', () => {
    expect(markers('surgery')).toBe(2)
  })

  test('exactly seven [fork:adapt] markers', () => {
    expect(markers('adapt')).toBe(7)
  })
})

describe('vendored getOrResumeAgent kernel', () => {
  const parentSessionId = 'session-parent' as Session['id']

  /** Minimal agent fake. */
  function fakeAgent(id: string): Agent {
    return { id, session: { id } } as unknown as Agent
  }

  /** Minimal persisted state fake; the kernel only feeds it to resolveSessionPreset. */
  function storedParent(): ReadSessionState {
    return { header: { id: parentSessionId } as unknown as SessionHeader, events: [] }
  }

  test('a live agent short-circuits before any resume', async () => {
    const live = fakeAgent('live-parent')
    let resumeCalls = 0
    const deps: GetOrResumeDeps = {
      get: () => live,
      readState: async () => storedParent(),
      composeSetup: async () => ({ setup: async () => { } }),
      resume: async () => {
        resumeCalls += 1
        return { agent: fakeAgent('resumed') }
      },
    }
    await expect(getOrResumeAgent(deps, parentSessionId)).resolves.toBe(live)
    expect(resumeCalls).toBe(0)
  })

  test('concurrent calls for the same cold parent share one resume (memo dedup)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const resumed = fakeAgent('resumed-parent')
    let resumeCalls = 0
    const deps: GetOrResumeDeps = {
      get: () => undefined,
      readState: async () => storedParent(),
      composeSetup: async () => ({ setup: async () => { } }),
      resume: async () => {
        resumeCalls += 1
        await gate
        return { agent: resumed }
      },
    }
    const first = getOrResumeAgent(deps, parentSessionId)
    const second = getOrResumeAgent(deps, parentSessionId)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(resumeCalls).toBe(1)
    expect(a).toBe(resumed)
    expect(b).toBe(resumed)
  })

  test('recovery catch: a failing resume returns the concurrently published live agent', async () => {
    let live: Agent | undefined
    const winner = fakeAgent('other-path-winner')
    const deps: GetOrResumeDeps = {
      get: () => live,
      readState: async () => storedParent(),
      composeSetup: async () => ({ setup: async () => { } }),
      resume: async () => {
        // Another Host entry path published the same identity while this
        // resume crossed an asynchronous persistence step.
        live = winner
        throw new Error('already registered')
      },
    }
    await expect(getOrResumeAgent(deps, parentSessionId)).resolves.toBe(winner)
  })

  test('without a recovered live agent the resume failure propagates', async () => {
    const deps: GetOrResumeDeps = {
      get: () => undefined,
      readState: async () => storedParent(),
      composeSetup: async () => ({ setup: async () => { } }),
      resume: async () => {
        throw new Error('already registered')
      },
    }
    await expect(getOrResumeAgent(deps, parentSessionId)).rejects.toThrow('already registered')
  })

  test('a missing parent throws instead of creating a session (no create branch)', async () => {
    let resumeCalls = 0
    const deps: GetOrResumeDeps = {
      get: () => undefined,
      readState: async () => null,
      composeSetup: async () => ({ setup: async () => { } }),
      resume: async () => {
        resumeCalls += 1
        return { agent: fakeAgent('resumed') }
      },
    }
    await expect(getOrResumeAgent(deps, parentSessionId)).rejects.toThrow(/not found/)
    expect(resumeCalls).toBe(0)
  })
})
