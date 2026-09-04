/**
 * Upstream watch tests: pin the official client behavior the fork
 * interception depends on (issue #3).
 * @module dsh-session-fork/tests/upstream-watch
 *
 * The hijack replaces `ctx.sessions.fork` on the shared client service and
 * relies on BOTH official fork entries resolving that property by runtime
 * lookup at click time. If an upstream release captures the method into a
 * closure at apply time (`const fork = ctx.sessions.fork`), the patch
 * silently stops intercepting. These tests fail loudly on that drift by
 * pinning the literal call sites in the published client bundles.
 *
 * On failure: do NOT relax the assertion. Re-read the upstream sources
 * (deepseek-harness ui-workspace/src/client/index.ts — the sole remaining
 * official fork affordance as of 0.1.2-rc.1; ui-conversation dropped its
 * turn-tail branch button in that release), find the new call/resolution
 * shape, and re-anchor the interception accordingly before upgrading the
 * pin.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function clientBundle(packageName: string): string {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`)
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { exports?: Record<string, unknown> }
  const clientExport = pkgJson.exports?.['./client'] as { default?: string } | string | undefined
  const relative = typeof clientExport === 'string'
    ? clientExport
    : clientExport?.default
  if (relative === undefined) throw new Error(`${packageName} exposes no ./client export`)
  // The subpath is not an exported key; anchor at the manifest and join.
  const path = join(dirname(pkgJsonPath), relative)
  if (!existsSync(path)) throw new Error(`${packageName} client bundle missing at ${path}`)
  return readFileSync(path, 'utf8')
}

describe('upstream watch: official fork call sites', () => {
  test('ui-workspace still resolves sessions.fork by runtime property lookup', () => {
    const bundle = clientBundle('@deepseek-ai/dsh-client-ui-workspace')
    // The sidebar row menu's forkSession body (0.1.2-rc.1 shape: the apply
    // closure destructures `const sessions = ctx.get('sessions')` once and
    // reads `.fork` off that same service object at click time — same
    // interception target as the old `ctx.sessions.fork(` literal). A
    // closure capture (`const fork = sessions.fork`) would remove this
    // literal.
    expect(bundle).toContain('sessions.fork({')
    // The intercepted options must keep flowing (increaseTitle included).
    expect(bundle).toContain('increaseTitle: true')
  })

  test('ui-conversation no longer ships a fork entry (turn-tail branch button removed upstream)', () => {
    const bundle = clientBundle('@deepseek-ai/dsh-client-ui-conversation')
    // 0.1.2-rc.1 removed the turn-tail branch button (`forkAt` with atSeq)
    // from ui-conversation entirely — the sidebar fork in ui-workspace is
    // the only official fork affordance left. Pin that absence so a future
    // re-introduction fails loudly here: on failure, re-read the upstream
    // ui-conversation client source, find the new call/resolution shape,
    // and re-anchor the pin (and, if the call captures the method instead
    // of property-looking it up, the interception itself).
    expect(bundle).not.toContain('sessions.fork')
    expect(bundle).not.toContain('atSeq')
  })
})
