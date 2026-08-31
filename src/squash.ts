/**
 * Pure squash logic: region selection, checkpoint extraction, merge
 * provenance, and error mapping. No cordis, no I/O — every dsh touchpoint is
 * a plain typed parameter, so each function is unit-testable with fake
 * session objects.
 *
 * The region-boundary wording mirrors the vendored
 * `validateSurfaceRegion` diagnostics (deepseek-harness
 * compaction-basic/src/region.ts:314-336) so a squash failure reads exactly
 * like the official compaction seam's; the user-facing error mapping mirrors
 * command-compact/src/index.ts:23-55.
 * @module dsh-session-fork/src/squash
 */

import {
  CompactionId,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildBranchEnvelope } from './branch-events.js'

/** Typed failure codes of the pure squash logic. */
export type SquashCoreErrorCode =
  | 'missing-seed-boundary'
  | 'empty-fork-range'
  | 'unbalanced-range'
  | 'checkpoint-not-found'

/** Typed failure of the pure squash logic; the command layer maps codes to user text. */
export class SquashCoreError extends Error {
  /** Machine-readable failure code. */
  readonly code: SquashCoreErrorCode

  constructor(code: SquashCoreErrorCode, message: string) {
    super(message)
    this.name = 'SquashCoreError'
    this.code = code
  }
}

/**
 * The inclusive post-fork compaction region, named by surface position:
 * every surface node whose log seq is after the child's seed boundary.
 */
export interface PostForkRange {
  /** Inclusive first surface-node seq of the region. */
  readonly start: number
  /** Inclusive last surface-node seq of the region. */
  readonly end: number
}

/**
 * Select the child's post-fork region — the surface tail after the
 * session's fork construction boundary — and pre-validate both edges as
 * balanced tool-pairing boundaries.
 *
 * The boundary is NOT "the last `session/end-seed`": upstream appends that
 * marker on EVERY seeded construction — fork AND cold resume (harness
 * session/src/index.ts:543-546; "a cold session is resumed on first
 * touch"). A tail scan lands on the resume marker the host writes moments
 * before `/squash` itself runs on a cold branch, making the post-boundary
 * surface empty (`empty-fork-range`), or — for a mid-history resume —
 * silently truncating the region to the post-resume tail. The anchor is
 * `header.seedLength`, the durable fork-lineage boundary: markers below it
 * were inherited with the seed, and the construction marker is the first
 * end-seed at/after it. One absorbed case exists: a seed slice that
 * already ends with an end-seed is not re-marked, so the trailing marker
 * at `events[seedLength - 1]` IS the boundary. (Index addressing is exact:
 * the kernel log is contiguous — `append` assigns `seq: log.length` and
 * the constructor rejects non-contiguous seeds — so array position and
 * seq coincide; only the JSONL storage projection coalesces chunk runs.)
 *
 * @param session - the child session being squashed.
 * @returns the inclusive region by surface position.
 * @throws {@link SquashCoreError} `missing-seed-boundary` (root session —
 * no fork lineage — or no construction marker), `empty-fork-range`
 * (nothing after the boundary), or `unbalanced-range` (an edge would
 * split a tool-call/result pair).
 */
export function postForkRange(session: Session): PostForkRange {
  const lineage = session.header.seedLength
  if (lineage === undefined) {
    throw new SquashCoreError(
      'missing-seed-boundary',
      'squash: the session has no seed boundary — only a forked child can be squashed',
    )
  }
  // The absorbed trailing seed marker: the constructor found the seed
  // already ending with one and skipped re-marking, so no construction
  // marker exists — any later end-seed is a cold-resume marker of this
  // session and must not win over the seed's own trailing edge.
  const absorbed = session.events[lineage - 1]
  let endSeed: number | undefined
  if (absorbed !== undefined && absorbed.type === 'session/end-seed') {
    endSeed = absorbed.seq
  } else {
    for (let index = lineage; index < session.events.length; index += 1) {
      const event = session.events[index]!
      if (event.type === 'session/end-seed') {
        endSeed = event.seq
        break
      }
    }
  }
  if (endSeed === undefined) {
    throw new SquashCoreError(
      'missing-seed-boundary',
      'squash: the session has no seed boundary — only a forked child can be squashed',
    )
  }
  const postFork = session.surface.nodes.filter(seq => seq > endSeed)
  const start = postFork[0]
  const end = postFork.at(-1)
  if (start === undefined || end === undefined) {
    throw new SquashCoreError(
      'empty-fork-range',
      'squash: the child has no post-fork surface region to compact',
    )
  }
  if (!toolPairingBalancedBefore(session, start)) {
    throw new SquashCoreError(
      'unbalanced-range',
      `squash: region start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`,
    )
  }
  if (!toolPairingBalancedAfter(session, end)) {
    throw new SquashCoreError(
      'unbalanced-range',
      `squash: region end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`,
    )
  }
  return { start, end }
}

/**
 * Extract the compaction checkpoint message from a just-compacted child
 * surface: the last surface `user/message` node whose source satisfies
 * `isCompactCheckpointSource`.
 * @param session - the child session, compacted moments before this call.
 * @returns the checkpoint user message, content and source intact.
 * @throws {@link SquashCoreError} `checkpoint-not-found` when the surface
 * carries no compaction checkpoint.
 */
export function extractCheckpointMessage(session: Session): UserMessage {
  const events = session.events
  // Scan from the surface tail: the squash compaction just landed one
  // checkpoint node, so the newest match is the right one — a stale
  // checkpoint in the inherited prefix must never win.
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]!
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    const message = session.deriveEventMessage(event)
    if (message !== null && message.role === 'user' && isCompactCheckpointSource(message.source)) {
      // A user/message node derives to a user-role message; the role guard
      // above is the runtime proof, so the cast only pins the subtype.
      return message as UserMessage
    }
  }
  throw new SquashCoreError(
    'checkpoint-not-found',
    'squash: the child surface has no compaction checkpoint — squash requires a completed compaction',
  )
}

/**
 * Merge provenance recorded on the target-appended checkpoint's source.
 *
 * Note: `atSeq` (the fork anchor in the target's log) was removed in the
 * issue #21 refactor. Under the new "any two registered branches" semantics
 * a single seq number can no longer point at a turn: for non-direct-parent
 * targets the relevant boundary is the leaving fork edge of a third
 * ancestor, not a seq in the target log. AI never read the field and no
 * in-tree consumer depended on it, so it is gone rather than refilled.
 */
export interface MergeProvenance {
  /** The child (source) branch's session id. */
  readonly childSessionId: Session['id']
  /** The compacted region by surface position in the source log. */
  readonly shadowedRange: { readonly start: number; readonly end: number }
  /** The shadowed surface-node seqs, in surface order. */
  readonly shadowedSeqs: readonly number[]
  /**
   * The compacted region in TURN coordinates, for the model-facing envelope
   * preamble (`covering its turns A–B`). `shadowedRange` is surface-seq
   * coordinates and must never reach the preamble — the two coordinate
   * systems diverge whenever non-surface events (chunks, boundaries) sit
   * inside the region. Absent when no shadowed event carries a turn number.
   */
  readonly turnRange?: { readonly start: number; readonly end: number }
  /** The child compaction's durable transaction identity. */
  readonly compactionId: CompactionId
  /** The /squash command that initiated the compaction, when present. */
  readonly sourceCommandId?: CommandId
}

/**
 * The merge checkpoint's message source: the official compaction checkpoint
 * shape extended with the merge provenance fields. `MessageSourceMap` is
 * merge-extensible and `isCompactCheckpointSource` ignores unknown fields,
 * so consumers keep recognizing this node as a compaction checkpoint while
 * the fork merge facts stay durably attached.
 */
export interface MergeCheckpointSource {
  readonly kind: 'plugin'
  readonly plugin: string
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
  readonly childSessionId: Session['id']
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
}

/**
 * Registry-resolved branch names for the merge envelope, resolved by the
 * command layer BEFORE building (names are point-in-time facts, exactly like
 * commit messages).
 */
export interface MergeBranchNames {
  /** Name of the child branch being squashed (the `from` of the event). */
  readonly child: string
  /** Name of the target branch the checkpoint is merged into (the `to`). */
  readonly target: string
}

/**
 * Derive the inclusive turn range covered by shadowed surface nodes: the min
 * and max `turn` over the events that carry one (`assistant/message`,
 * `tool/result`; `user/message` data is the message itself and has no turn
 * field). Used to state the squash region in the model-facing preamble in
 * turn coordinates rather than surface seqs.
 * @param session - the child session that owns the shadowed seqs.
 * @param seqs - shadowed surface-node seqs, in any order.
 * @returns the inclusive turn range, or undefined when no seq carries a turn.
 */
export function turnRangeOf(
  session: Session,
  seqs: readonly number[],
): { readonly start: number; readonly end: number } | undefined {
  let start = Infinity
  let end = -Infinity
  for (const seq of seqs) {
    const data = session.events[seq]?.data as { turn?: unknown } | undefined
    if (typeof data?.turn === 'number') {
      start = Math.min(start, data.turn)
      end = Math.max(end, data.turn)
    }
  }
  return start === Infinity ? undefined : { start, end }
}

/**
 * Build the message appended into the parent branch: the child checkpoint's
 * payload (the conclusion itself, tags and all — nested `<compacted-summary>`
 * tags inside `<branch-squash>` are honest about the material's origin)
 * wrapped in the shared branch-event envelope, with the compaction identity
 * plus the fork-merge provenance riding the source. The official
 * session-event vocabulary is closed to downstream plugins, so no custom
 * merge event is emitted — the provenance rides this message's plugin source.
 *
 * Guard compatibility: `isCompactCheckpointSource` requires
 * `plugin === 'compact'` (dsh-compaction lib/types/checkpoint.js), so
 * `extraSource` overrides the envelope's `plugin: 'dsh-session-fork'` back to
 * `'compact'` — the merged node stays a recognized compaction checkpoint for
 * every official consumer.
 *
 * Coordinates: `facts.range` carries `shadowedRange` in source surface
 * positions (the source log's own coordinate system). Source/target logs are
 * independent coordinate spaces — consumers reading the source back must use
 * `shadowedRange` only against the source's events, never against the target's.
 * @param checkpointMessage - the child's checkpoint message from {@link extractCheckpointMessage}.
 * @param provenance - fork and compaction facts to record on the source.
 * @param branchNames - registry-resolved child and target branch names.
 * @returns the parent-ready user message.
 */
export function buildMergeCheckpoint(
  checkpointMessage: UserMessage,
  provenance: MergeProvenance,
  branchNames: MergeBranchNames,
): UserMessage {
  const payload = checkpointMessage.content
    .map(block => block.type === 'text' ? block.text : `(opaque ${block.type} block)`)
    .join('\n')
  return buildBranchEnvelope(
    {
      kind: 'squash',
      from: branchNames.child,
      to: branchNames.target,
      ...provenance.turnRange === undefined ? {} : { range: { ...provenance.turnRange } },
      fromSessionId: provenance.childSessionId,
    },
    payload,
    undefined,
    {
      plugin: 'compact',
      compactionId: provenance.compactionId,
      ...(provenance.sourceCommandId === undefined ? {} : { sourceCommandId: provenance.sourceCommandId }),
      childSessionId: provenance.childSessionId,
      shadowedRange: provenance.shadowedRange,
      shadowedSeqs: [...provenance.shadowedSeqs],
    },
  )
}

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Convert one expected manual-compaction failure class into concise,
 * human-only squash wording. Mirrors the official `/compact` command's
 * phrasing (command-compact/src/index.ts:23-55) with the squash subject.
 * @param code - the stable ManualCompactionError failure class.
 * @returns the user-facing error text.
 */
export function squashErrorText(code: ManualCompactionErrorCode): string {
  switch (code) {
    case 'busy':
      return 'Squash is unavailable because this process has an active compaction, or the agent is not idle.'
    case 'cancelled':
      return 'Squash cancelled.'
    case 'changed':
      return 'The history selected for squash changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.'
    case 'summary':
      // TODO(v0.1.x): surface the error.message hint here instead of the
      // generic wording — a summary that would not shrink should suggest
      // rebased-into mode.
      return 'Squash could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.'
    case 'commit':
      return 'Squash did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.'
    case 'persistence':
      return 'Squash finished, but the session could not be saved.'
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default:
      return assertNever(code)
  }
}
