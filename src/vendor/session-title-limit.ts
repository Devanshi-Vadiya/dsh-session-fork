/**
 * VENDORED FROM: deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
 * (copied 2026-08-21)
 *
 * - packages/bundle/base/cordis.patch.yml:39-44 — the web deployment's
 *   `session-title` composition. Its `maxTitleBytes: 80` is the UTF-8 byte
 *   budget the mounted SessionTitleService enforces on every accepted title,
 *   `session.rename` included — so it is the byte ceiling a branch name must
 *   fit to survive that rename byte-for-byte unmodified.
 *
 * The limit is not importable as code: upstream ships it only inside the
 * deployment's YAML composition, and the running service keeps its resolved
 * config private (no public accessor). This module vendors the VALUE per the
 * dsh-session-fork vendor-replication standard; the YAML file format itself
 * is not replicated. When the upstream composition changes the budget,
 * update the constant here by hand and adjust the pinned expectations in
 * tests/vendor.test.ts.
 * @module dsh-session-fork/src/vendor/session-title-limit
 */

// [fork:adapt] value vendored from the upstream YAML composition
export const upstreamMaxTitleBytes = 80
