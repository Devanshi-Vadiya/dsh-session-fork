/**
 * Branch creation: seed a child session through the official agent path and
 * record the ref.
 * @module dsh-fork/src/branch
 *
 * A single durable route mirrors the host web GUI's own fork
 * (api-proxy `session.fork`) for **every** source, live or cold: the seed
 * slice is written through `ctx.agents.create({ sessionId, seed, meta })`
 * with `meta.parentSession` + `seedLength`, and the child is attached to
 * the source's workspace. The kernel `SessionStore.fork` shortcut is
 * deliberately NOT used: sessions created through it are scoped to the
 * calling fiber (they are evicted from the store and broadcast
 * `session-removed` when the command's turn ends) and never join a
 * workspace, so their sidebar rows vanish. The `agents.create` path is the
 * only one that yields a durable, listed, resumable child — so it is the
 * only one.
 *
 * Boundary computation is shared by both kinds of source (see
 * {@link forkBoundaryOf}). All dsh touchpoints are injected through
 * {@link BranchPorts}, so the logic is unit-testable without cordis.
 */

import { randomUUID } from 'node:crypto'
import type { BranchRecord } from './types.js'

/** Typed failure of a branch-creation operation. */
export class BranchForkError extends Error {
  /** Machine-readable failure code. */
  readonly code: 'source-not-found' | 'fork-unavailable'

  constructor(code: BranchForkError['code'], message: string) {
    super(message)
    this.name = 'BranchForkError'
    this.code = code
  }
}

/** The event fields fork-boundary logic needs from one session event. */
export interface SourceEvent {
  /** Position of the event in its session log (0-based, contiguous). */
  readonly seq: number
  /** Discriminator; only `turn/start` / `turn/end` matter here. */
  readonly type: string
}

/** Read-only view of a source session, live or inspected from disk. */
export interface SourceSessionView {
  readonly id: string
  readonly events: readonly SourceEvent[]
  /** Creation header; `cwd` is inherited by the child. */
  readonly header: { readonly cwd?: string }
}

/**
 * Injected dsh capabilities. Production wires:
 * - `readSession` — api-proxy's `readSessionState`: `ctx.sessions.get(id)`
 *   first, then the persistence inspect path.
 * - `createChildFromSeed` — `ctx.agents.create({ sessionId, seed, meta })`
 *   with `meta.parentSession`/`seedLength` plus workspace attach, the exact
 *   path the web GUI's fork button takes. Used for live and cold sources
 *   alike.
 */
export interface BranchPorts {
  readSession(sessionId: string): Promise<SourceSessionView | null>
  createChildFromSeed(
    childId: string,
    source: SourceSessionView,
    cut: number,
  ): Promise<void>
}

/**
 * Locate the fork boundary in the source log, replicating the api-proxy
 * anchor semantics:
 *
 * - With `atSeq`: the first `turn/end` at or after that seq (an in-log anchor
 *   belongs to its whole turn). `null` means the containing turn has not
 *   completed yet.
 * - Without `atSeq`: the last completed `turn/end`; `null` means the session
 *   has no completed turn to fork from.
 *
 * The returned `cut` additionally extends through trailing standalone events
 * (`session/title`, injections) up to the next `turn/start`, so the seed
 * stays balanced, exactly like the host implementation.
 *
 * @returns `null` when no completed turn anchors the fork.
 */
export function forkBoundaryOf(
  events: readonly SourceEvent[],
  atSeq?: number,
): { turnEndSeq: number; cut: number } | null {
  const lastSeq = events.at(-1)?.seq ?? -1
  // Omitted and past-end anchors retain the last-completed-turn shortcut; an
  // in-log anchor belongs to the turn containing it and must never clip
  // backward to an earlier completed turn (api-proxy semantics).
  const anchored =
    atSeq === undefined || atSeq > lastSeq
      ? events.findLast(e => e.type === 'turn/end')
      : events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
  if (anchored === undefined) return null
  let cut = anchored.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  return { turnEndSeq: anchored.seq, cut }
}

/** Options for {@link createBranchFrom}. */
export interface CreateBranchOptions {
  /**
   * Optional in-log anchor: fork through the turn containing this event seq.
   * Omitted means the source's last completed turn.
   */
  readonly atSeq?: number
  /** Explicit child session id; defaults to `session-<uuid>`. */
  readonly childId?: string
}

/**
 * Fork `sourceSessionId` at a turn boundary and produce the branch record.
 *
 * The record's `forkOrigin.atSeq` is the **seq of the anchoring `turn/end`
 * event in the parent's log** (log coordinates, not surface positions). The
 * child header's `seedLength` counts the whole seed slice — which may extend
 * past `atSeq` through trailing standalone events up to the next
 * `turn/start` — so `seedLength >= atSeq + 1`; locate the fork message with
 * `atSeq`, replay the seed with `seedLength`.
 *
 * @returns the frozen {@link BranchRecord} for the new child branch.
 * @throws {@link BranchForkError} `source-not-found` / `fork-unavailable`.
 */
export async function createBranchFrom(
  sourceSessionId: string,
  name: string,
  ports: BranchPorts,
  options: CreateBranchOptions = {},
): Promise<BranchRecord> {
  const source = await ports.readSession(sourceSessionId)
  if (source === null) {
    throw new BranchForkError(
      'source-not-found',
      `no session named '${sourceSessionId}' exists`,
    )
  }
  const boundary = forkBoundaryOf(source.events, options.atSeq)
  if (boundary === null) {
    throw new BranchForkError(
      'fork-unavailable',
      options.atSeq !== undefined
        ? `session "${sourceSessionId}" has not completed the turn containing event ${String(options.atSeq)}`
        : `session "${sourceSessionId}" has no completed turn to fork from`,
    )
  }
  const childId = options.childId ?? `session-${randomUUID() as string}`
  // Single official route: agents.create with the seed prefix + workspace
  // attach, regardless of whether the source is live or on-disk. This is
  // exactly what the web GUI's fork does (api-proxy session.fork), and it
  // is the only path that produces a durable, workspace-listed child.
  await ports.createChildFromSeed(childId, source, boundary.cut)
  return Object.freeze({
    name,
    sessionId: childId,
    forkOrigin: Object.freeze({
      parentSessionId: source.id,
      atSeq: boundary.turnEndSeq,
    }),
    createdAt: new Date().toISOString(),
  })
}

/**
 * Adopt `sessionId` as a workspace's root branch (`forkOrigin: null`).
 * @throws {@link BranchForkError} `source-not-found` when the session does
 * not exist (live or on disk).
 */
export async function createRootBranch(
  sessionId: string,
  name: string,
  ports: Pick<BranchPorts, 'readSession'>,
): Promise<BranchRecord> {
  const source = await ports.readSession(sessionId)
  if (source === null) {
    throw new BranchForkError(
      'source-not-found',
      `no session named '${sessionId}' exists`,
    )
  }
  return Object.freeze({
    name,
    sessionId,
    forkOrigin: null,
    createdAt: new Date().toISOString(),
  })
}
