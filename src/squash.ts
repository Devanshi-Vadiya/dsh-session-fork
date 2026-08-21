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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

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
 * constructor seed boundary — and pre-validate both edges as balanced
 * tool-pairing boundaries.
 * @param session - the child session being squashed.
 * @returns the inclusive region by surface position.
 * @throws {@link SquashCoreError} `missing-seed-boundary` (no
 * `session/end-seed` event), `empty-fork-range` (nothing after the seed), or
 * `unbalanced-range` (an edge would split a tool-call/result pair).
 */
export function postForkRange(session: Session): PostForkRange {
  let endSeed: number | undefined
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === 'session/end-seed') {
      endSeed = event.seq
      break
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

/** Merge provenance recorded on the parent-appended checkpoint's source. */
export interface MergeProvenance {
  /** The child branch's session id. */
  readonly childSessionId: Session['id']
  /** The registry's fork anchor: the parent log seq of the anchoring turn end. */
  readonly atSeq: number
  /** The compacted region by surface position. */
  readonly shadowedRange: { readonly start: number; readonly end: number }
  /** The shadowed surface-node seqs, in surface order. */
  readonly shadowedSeqs: readonly number[]
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
  readonly atSeq: number
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
}

/**
 * Build the message appended into the parent branch: the child checkpoint's
 * content (the conclusion itself), re-sourced with the compaction identity
 * plus the fork-merge provenance. The official session-event vocabulary is
 * closed to downstream plugins, so no custom merge event is emitted — the
 * provenance rides this message's plugin source.
 * @param checkpointMessage - the child's checkpoint message from {@link extractCheckpointMessage}.
 * @param provenance - fork and compaction facts to record on the source.
 * @returns the parent-ready user message.
 */
export function buildMergeCheckpoint(
  checkpointMessage: UserMessage,
  provenance: MergeProvenance,
): UserMessage {
  const source: MergeCheckpointSource = {
    kind: 'plugin',
    plugin: 'compact',
    compactionId: provenance.compactionId,
    ...(provenance.sourceCommandId === undefined ? {} : { sourceCommandId: provenance.sourceCommandId }),
    childSessionId: provenance.childSessionId,
    atSeq: provenance.atSeq,
    shadowedRange: provenance.shadowedRange,
    shadowedSeqs: [...provenance.shadowedSeqs],
  }
  return createUserMessage({
    content: checkpointMessage.content,
    source,
  })
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
      // rebase mode.
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
