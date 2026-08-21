/**
 * Fork interception: replace the shared client sessions service's `fork`
 * method so the official fork affordances route through this plugin.
 * @module dsh-session-fork/src/client/fork-intercept
 *
 * Why this seam holds (deepseek-harness@528c682e): both official entries —
 * the sidebar row menu (ui-workspace/src/client/index.ts:88-94) and the
 * turn-tail branch button (ui-conversation/src/client/apply.ts:419-425) —
 * call `ctx.sessions.fork(opts)` with a runtime property lookup at click
 * time, on the one shared service instance this plugin can reach through
 * the same root context. Replacing the property before the first click
 * intercepts every official fork call without touching official code.
 *
 * Stage 1 (issue #3, this commit): install a transparent pass-through
 * wrapper that proves the seam — same object, same signature, identical
 * behavior. The name dialog and the host-side `fork` RPC endpoint land in
 * the following commits.
 *
 * The wrapper is tagged with a well-known registry Symbol so an HMR
 * invalidate cycle (fresh module record, apply re-run) recognizes our own
 * wrapper instead of nesting a new layer per reload.
 */

/** Options of the official client `ctx.sessions.fork` (structural slice). */
export interface ForkOptions {
  sessionId: string
  atSeq?: number
  increaseTitle?: boolean
}

/** Structural slice of the shared client sessions service we patch. */
export interface SessionsServiceLike {
  fork(opts: ForkOptions): Promise<string>
  open(sessionId: string): void
}

/** Structural slice of the client root context: the cordis `get` face. */
export interface ClientRootCtxLike {
  get(name: 'sessions'): SessionsServiceLike
}

/** Registry Symbol tagging our installed wrapper (stable across bundles/reloads). */
const FORK_PATCH_TAG = Symbol.for('dsh-session-fork.client.fork-patch')

/**
 * Install the interception. The caller's `inject` declaration must include
 * `'sessions'` so this runs only once the shared service exists (boot time —
 * always before a user can click fork).
 * @param ctx - client root context.
 */
export function installForkIntercept(ctx: ClientRootCtxLike): void {
  const sessions = ctx.get('sessions')
  const original = sessions.fork as typeof sessions.fork & { [FORK_PATCH_TAG]?: boolean }
  // Already ours (an HMR invalidate re-ran the installer on a fresh module
  // record): re-patching would nest wrappers; the existing one keeps holding.
  if (original[FORK_PATCH_TAG] === true) return

  const wrapper = (opts: ForkOptions): Promise<string> => original.call(sessions, opts)
  ;(wrapper as typeof wrapper & { [FORK_PATCH_TAG]: boolean })[FORK_PATCH_TAG] = true
  sessions.fork = wrapper
}
