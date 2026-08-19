/**
 * Branch creation: fork a session through the kernel path and record the ref.
 * @module dsh-fork/src/branch
 *
 * Two durable routes mirror what the host's own api-proxy does for
 * `session.fork`:
 *
 * 1. **Live source** — the source session is live in `ctx.sessions` (the
 *    kernel `SessionStore`), so the fork goes through
 *    `SessionStore.fork(source, boundary, childId)` which seeds a live child
 *    from a stable prefix and stamps its header with `parentSession` +
 *    `seedLength`.
 * 2. **Cold source** — the source is only on disk; the same seed is written
 *    through a `ctx.agents.create({ sessionId, seed, meta })` child, exactly
 *    like the web GUI's fork of a non-live session.
 *
 * Both routes use the same boundary computation (see {@link forkBoundaryOf}).
 * All dsh touchpoints are injected through {@link BranchPorts}, so the logic
 * is unit-testable without cordis.
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
 * - `forkLive` — kernel `SessionStore.fork(sourceId, boundarySeq, childId)`;
 *   returns `false` when the source is not live in the store.
 * - `createChildFromSeed` — `ctx.agents.create({ sessionId, seed, meta })`
 *   with `meta.parentSession`/`seedLength`, for cold sources.
 */
export interface BranchPorts {
  readSession(sessionId: string): Promise<SourceSessionView | null>
  forkLive(
    sourceId: string,
    boundarySeq: number,
    childId: string,
  ): Promise<boolean> | boolean
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
  // Route 1: kernel SessionStore.fork on a live source. Passing the seq of
  // the last seed event (cut-1) as the inclusive boundary makes the kernel
  // slice exactly the prefix the cold path would persist, and its own
  // closed-turn check still anchors on the same turn/end.
  const forkedLive = await ports.forkLive(
    source.id,
    source.events[boundary.cut - 1]!.seq,
    childId,
  )
  if (!forkedLive) {
    // Route 2: cold source — write the seeded child durably (the
    // ctx.agents.create path); the store then holds it live as well.
    await ports.createChildFromSeed(childId, source, boundary.cut)
  }
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
