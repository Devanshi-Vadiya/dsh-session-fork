/**
 * Browser half of dsh-session-fork: the client plugin entry, materialized
 * by the dsh client module system from the package's `./client` export.
 *
 * P2 scaffolds the dual-face contract only — an empty apply and the inject
 * declaration. The branches graph tab (slot registration, RPC fetching,
 * vscode-style rendering) is P3's payload, so the browser half is inert
 * until then. Import discipline (see packages/client/AGENTS.md): the bundle
 * may only import values from the module-table baseline + this package's
 * dsh.client.external requests; type-only imports are erased.
 * @module dsh-session-fork/src/client
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Cordis services the client half depends on: the slot system ('slots',
 * registering the conversation-view tab), 'locale' (tab label dictionaries),
 * and 'connection' (RPC calls into the host channel). Informational until
 * P3 wires them into apply.
 */
export const inject = ['slots', 'locale', 'connection'] as const

/** Client plugin body: intentionally empty in P2 (scaffold only). */
export function apply(_ctx: Context): void {}
