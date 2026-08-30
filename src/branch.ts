/**
 * Branch creation: seed a child session through the official agent path,
 * pin the branch name as the session title through the official
 * `session.rename` handler, and record the ref.
 * @module dsh-session-fork/src/branch
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
 * Boundary computation is vendored from the host fork handler (see
 * `src/vendor/fork.ts`). All dsh touchpoints are
 * injected through {@link BranchPorts}, so the logic is unit-testable
 * without cordis.
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildBranchNotice, branchNoticeLines } from './branch-events.js'
import type { BranchEventFacts } from './branch-events.js'
import type { BranchRecord } from './types.js'
import { anchoredBoundaryOf } from './vendor/fork.js'

/** Typed failure of a branch-creation operation. */
export class BranchForkError extends Error {
  /** Machine-readable failure code. */
  readonly code: 'source-not-found' | 'fork-unavailable' | 'rename-failed'

  constructor(code: BranchForkError['code'], message: string) {
    super(message)
    this.name = 'BranchForkError'
    this.code = code
  }
}

/**
 * Typed failure of a session-archive operation (the `rm` companion). The
 * official `workspace.archiveSession` handler rejects sessions that are
 * neither live nor persisted with `session-not-found`; the host adapter
 * maps that onto the `'missing'` outcome instead of throwing, so only
 * infrastructure failures (an unmounted gateway, storage errors) raise
 * this class.
 */
export class BranchArchiveError extends Error {
  /** Machine-readable failure code. */
  readonly code: 'archive-failed'

  constructor(message: string) {
    super(message)
    this.name = 'BranchArchiveError'
    this.code = 'archive-failed'
  }
}

/**
 * Outcome of archiving one session through the official handler:
 * `'archived'` when the session joined the archive set (idempotent — an
 * already-archived session archives again), `'missing'` when the session
 * exists neither live nor in persistence (the dangling-ref case: the ref
 * is removed without an archive step).
 */
export type ArchiveOutcome = 'archived' | 'missing'

/** The event fields fork-boundary logic needs from one session event. */
export interface SourceEvent {
  /** Position of the event in its session log (0-based, contiguous). */
  readonly seq: number
  /** Discriminator; `turn/*` and `command/*` matter here. */
  readonly type: string
  /** Event payload, read structurally (preset selection, command pairing). */
  readonly data?: unknown
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
 * - `renameSession` — the official `session.rename` handler through the
 *   injected `ctx.apiProxy` gateway, in process (same instance the web GUI's
 *   rename dialog drives). Called only after the registry gate
 *   (`assertValidName`) has proved the official normalizer holds the title
 *   to identity, so the rename is deterministic.
 */
export interface BranchPorts {
  readSession(sessionId: string): Promise<SourceSessionView | null>
  createChildFromSeed(
    childId: string,
    source: SourceSessionView,
    cut: number,
    forkNotice?: UserMessage,
  ): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
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
  /**
   * The source branch's registry name, used verbatim as the fork notice's
   * `from` (issue #28: the child must learn its lineage). When omitted —
   * forking an un-adopted session — the notice names the source session id,
   * which is always durable truth.
   */
  readonly parentName?: string
}

/** The durable result of one fork, plus the facts its notices were built from. */
export interface BranchForkOutcome {
  readonly record: BranchRecord
  /**
   * Fork facts exactly as rendered into the child's seed notice (and,
   * upstream, the parent's notification). Names are point-in-time registry
   * values captured before the record write (cf. `branch-events.ts`).
   */
  readonly facts: BranchEventFacts
}

/**
 * Build the seed-tail fork notice event: one `user/message` carrying the
 * AI-visible lineage statement, ready to append to the sliced seed (issue
 * #28). Pure construction; `seq` must be the next contiguous seed position
 * (`cut`) so `Session.create`'s continuity validation accepts the seed.
 * @param seq - the event's log position (== `cut`, the slice length).
 * @param time - event timestamp in epoch ms.
 * @param notice - the built fork notice message.
 */
export function forkSeedNoticeEvent(seq: number, time: number, notice: UserMessage): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time,
    data: notice,
    surfaceOp: 'append',
  } as SessionEvent<'user/message'>
}

/**
 * Fork `sourceSessionId` at a turn boundary and produce the branch record.
 *
 * The record's `forkOrigin.atSeq` is the **seq of the anchoring `turn/end`
 * event in the parent's log** (log coordinates, not surface positions). The
 * child header's `seedLength` counts the whole seed slice — the inherited
 * events **plus the fork notice event appended at the tail** (issue #28) —
 * so `seedLength >= atSeq + 2`; locate the fork message with `atSeq`, replay
 * the seed with `seedLength`.
 *
 * @returns the frozen {@link BranchRecord} for the new child plus the fork
 * {@link BranchEventFacts} its notices were built from.
 * @throws {@link BranchForkError} `source-not-found` / `fork-unavailable`.
 */
export async function createBranchFrom(
  sourceSessionId: string,
  name: string,
  ports: BranchPorts,
  options: CreateBranchOptions = {},
): Promise<BranchForkOutcome> {
  const source = await ports.readSession(sourceSessionId)
  if (source === null) {
    throw new BranchForkError(
      'source-not-found',
      `no session named '${sourceSessionId}' exists`,
    )
  }
  const boundary = anchoredBoundaryOf(source.events, options.atSeq)
  if (boundary === null) {
    throw new BranchForkError(
      'fork-unavailable',
      options.atSeq !== undefined
        ? `session "${sourceSessionId}" has not completed the turn containing event ${String(options.atSeq)}`
        : `session "${sourceSessionId}" has no completed turn to fork from`,
    )
  }
  const childId = options.childId ?? `session-${randomUUID() as string}`
  // Issue #28: the turn number of the anchoring `turn/end` names the fork
  // point in the units every reader already uses (turns, not log seqs).
  const anchorTurn = (source.events[boundary.boundarySeq]?.data as { turn?: number } | undefined)?.turn
  const facts: BranchEventFacts = {
    kind: 'fork',
    from: options.parentName ?? source.id,
    to: name,
    ...(anchorTurn === undefined ? {} : { atTurn: anchorTurn }),
    fromSessionId: source.id,
  }
  const forkNotice = buildBranchNotice(facts, branchNoticeLines.forkChild(facts))
  // Single official route: agents.create with the seed prefix + workspace
  // attach, regardless of whether the source is live or on-disk. This is
  // exactly what the web GUI's fork does (api-proxy session.fork), and it
  // is the only path that produces a durable, workspace-listed child. The
  // seed carries the fork notice as its final event (issue #28): atomic
  // with creation, always at the inherit/own-history boundary, inherited
  // verbatim by any grandchild fork.
  await ports.createChildFromSeed(childId, source, boundary.cut, forkNotice)
  // Issue #7: the branch name becomes the child's pinned title through the
  // official session.rename handler. The registry gate already proved the
  // official normalizer holds this name to identity, so this rename is
  // deterministic; a failure here is an internal anomaly that must surface
  // (the child stays listed like any anonymous fork, without a ref).
  await ports.renameSession(childId, name)
  const record: BranchRecord = Object.freeze({
    name,
    sessionId: childId,
    forkOrigin: Object.freeze({
      parentSessionId: source.id,
      atSeq: boundary.boundarySeq,
    }),
    createdAt: new Date().toISOString(),
  })
  return { record, facts }
}

/**
 * Adopt `sessionId` as a workspace's root branch (`forkOrigin: null`), and
 * pin the branch name as the session's title through the official
 * `session.rename` handler (same deterministic gate as
 * {@link createBranchFrom}).
 * @throws {@link BranchForkError} `source-not-found` when the session does
 * not exist (live or on disk), `rename-failed` when the rename is rejected.
 */
export async function createRootBranch(
  sessionId: string,
  name: string,
  ports: Pick<BranchPorts, 'readSession' | 'renameSession'>,
): Promise<BranchRecord> {
  const source = await ports.readSession(sessionId)
  if (source === null) {
    throw new BranchForkError(
      'source-not-found',
      `no session named '${sessionId}' exists`,
    )
  }
  await ports.renameSession(sessionId, name)
  return Object.freeze({
    name,
    sessionId,
    forkOrigin: null,
    createdAt: new Date().toISOString(),
  })
}
