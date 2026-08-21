/**
 * Client-side graph model: map the host's `graph` RPC payload onto the
 * vendored vscode SCM history shapes.
 * @module dsh-session-fork/src/client/graph-model
 *
 * Pure and DOM-free, so the mapping is unit-testable without React; the
 * view component only adds layout (toISCMHistoryItemViewModelArray) and
 * rendering on top.
 */

import type { ISCMHistoryItem, ISCMHistoryItemRef } from './vendor/vscode/types.js'

/** Host RPC channel this plugin owns (mirror of the host-side constant). */
export const RPC_CHANNEL = '/dsh-session-fork'

/**
 * Structural slice of dsh's client-side `RpcResult<T>` as the view consumes
 * it (success value or a displayable error message; never thrown here).
 */
export type GraphRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Wire shape of one graph node served by the host's `graph` endpoint. */
export interface GraphNodeDto {
  readonly id: string
  readonly parentIds: readonly string[]
  readonly subject: string
  readonly refs?: readonly { readonly id: string; readonly name: string }[] | undefined
}

/** Wire shape of the `graph` endpoint value. */
export interface GraphPayloadDto {
  readonly nodes: readonly GraphNodeDto[]
  readonly head: string | null
}

/** Result of the mapping: vscode history items plus the HEAD ref. */
export interface GraphHistoryModel {
  readonly items: readonly ISCMHistoryItem[]
  readonly headRef: ISCMHistoryItemRef | undefined
}

/** Ref id of the synthesized HEAD marker row reference. */
const HEAD_REF_ID = 'HEAD'

/**
 * Map one graph payload onto the vscode history model. The host already
 * orders nodes newest-first; the mapping is shape-only (id, parentIds,
 * subject, branch-name references, HEAD marker via `currentHistoryItemRef`).
 */
export function toGraphHistoryModel(payload: GraphPayloadDto): GraphHistoryModel {
  const items: ISCMHistoryItem[] = payload.nodes.map(node => ({
    id: node.id,
    parentIds: [...node.parentIds],
    subject: node.subject,
    message: node.subject,
    ...(node.refs === undefined || node.refs.length === 0
      ? {}
      : { references: node.refs.map(ref => ({ id: ref.id, name: ref.name, revision: node.id })) }),
  }))
  return {
    items,
    headRef: payload.head === null
      ? undefined
      : { id: HEAD_REF_ID, name: HEAD_REF_ID, revision: payload.head },
  }
}
