/**
 * Tests for the browser-half fork interception seam (stage 1: transparent
 * pass-through patch).
 * @module dsh-session-fork/tests/client-patch.test
 */

import { describe, expect, test } from 'bun:test'
import { installForkIntercept, type SessionsServiceLike } from '../src/client/fork-intercept.js'

/** Fake sessions service recording calls and receiver identity. */
function fakeSessions(): SessionsServiceLike & {
  readonly calls: { thisArg: unknown; opts: unknown[] }[]
} {
  const calls: { thisArg: unknown; opts: unknown[] }[] = []
  const service: SessionsServiceLike = {
    fork(...opts: [{ sessionId: string }]): Promise<string> {
      calls.push({ thisArg: this, opts })
      return Promise.resolve(`child-of-${opts[0]!.sessionId}`)
    },
    open() { },
  }
  return Object.assign(service, { calls })
}

describe('client fork patch (transparent stage)', () => {
  test('forwards calls verbatim and preserves the official receiver', async () => {
    const sessions = fakeSessions()
    const before = sessions.fork
    installForkIntercept({ get: () => sessions })

    expect(sessions.fork).not.toBe(before) // property was replaced
    await expect(sessions.fork({ sessionId: 's1', increaseTitle: true }))
      .resolves.toBe('child-of-s1')
    expect(sessions.calls).toEqual([
      { thisArg: sessions, opts: [{ sessionId: 's1', increaseTitle: true }] },
    ]) // `this` stayed the official service instance
  })

  test('re-install (HMR invalidate) does not nest wrappers', async () => {
    const sessions = fakeSessions()
    installForkIntercept({ get: () => sessions })
    const afterFirst = sessions.fork
    installForkIntercept({ get: () => sessions })

    expect(sessions.fork).toBe(afterFirst) // second install is a no-op
    await expect(sessions.fork({ sessionId: 's2' })).resolves.toBe('child-of-s2')
    expect(sessions.calls.length).toBe(1) // exactly one underlying call
  })
})
