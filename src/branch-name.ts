/**
 * Branch-name validation core, shared by both plugin halves.
 * @module dsh-session-fork/src/branch-name
 *
 * One source of truth for the issue #7 identity gate. A branch name is the
 * registry's record key AND the exact title written onto the session
 * through the official `session.rename` handler — which accepts input by
 * *normalizing* it. A name the official pipeline would rewrite would
 * produce a session title that differs from the registry key, so the gate
 * is the official normalizer held to identity: a name passes only when the
 * pipeline returns it byte-for-byte unchanged, making the later rename
 * deterministic.
 *
 * Consumers: the Host registry wraps it to throw (`assertValidName` in
 * registry.ts); the browser fork-name dialog calls it directly to reject a
 * bad name before any fork RPC leaves the page. This module therefore
 * depends only on vendored, environment-neutral code (no Node APIs) so the
 * identical source bundles into the client.
 */

import { normalizeSessionTitle, truncateTitleUtf8 } from './vendor/session-title-normalize.js'
import { upstreamMaxTitleBytes } from './vendor/session-title-limit.js'

/** Result of {@link validateBranchName}: pass, or fail with a user-facing reason. */
export type BranchNameCheck = { ok: true } | { ok: false; reason: string }

/**
 * Validate a prospective branch name against the official title pipeline.
 *
 * The empty check stays ours: the empty string survives normalization as
 * itself, so identity alone would admit it (the official handler rejects
 * empty titles, but the gate must fail fast before any fork side effect).
 *
 * @param name - candidate branch name.
 * @returns `{ ok: true }`, or `{ ok: false, reason }` fit for direct
 *   display in the fork-name dialog's error row.
 */
export function validateBranchName(name: string): BranchNameCheck {
  if (name.length === 0) {
    return { ok: false, reason: 'name must not be empty' }
  }
  if (truncateTitleUtf8(name, upstreamMaxTitleBytes) !== name) {
    return {
      ok: false,
      reason: `exceeds ${String(upstreamMaxTitleBytes)} UTF-8 bytes (the official session-title budget)`,
    }
  }
  if (normalizeSessionTitle(name, upstreamMaxTitleBytes) !== name) {
    return {
      ok: false,
      reason: 'must not contain leading/trailing or doubled whitespace, control characters, or invisible characters',
    }
  }
  return { ok: true }
}
