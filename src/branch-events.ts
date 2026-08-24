/**
 * Branch event envelopes: the single, shared way every branch operation
 * (fork, squash, rebase) renders an AI-visible provenance message.
 *
 * Design contract (agreed 2026-08-22 before the enhance-fork / enhance-squash
 * / implement-rebase workstreams forked off):
 *
 * - Every branch event is ONE `user/message`. The `source` carries
 *   machine-readable provenance (`branchEvent`) plus a UI-facing
 *   `form`/`summary`; the model never sees those fields, so the content text
 *   is ALWAYS self-describing.
 * - Two shapes exist:
 *   - `buildBranchNotice` — a one-line account of something that happened
 *     (fork notifications, both directions). No payload, no tags.
 *   - `buildBranchEnvelope` — an English preamble plus an XML-style
 *     `<branch-<kind>>` tag pair wrapping a payload (squash summary, rebase
 *     transcript pages), mirroring the official compaction checkpoint shape
 *     (compaction-basic/src/summarizer.ts: `CHECKPOINT_PREAMBLE` +
 *     `<compacted-summary>` tags). The tags delimit material that
 *     ORIGINATED ON ANOTHER BRANCH, for the model and the human reader alike.
 * - This module owns the wording; the three workstreams own the transport
 *   (seed embedding, inbox injection, maintenance-window append). Keeping
 *   the text here keeps the three branches merge-conflict-free.
 *
 * - 2026-08-22 extension: both builders accept `extraSource` — caller-owned
 *   fields spread onto the message `source` AFTER `branchEvent` (e.g.
 *   MergeCheckpointSource's childSessionId/atSeq/shadowedRange/...).
 *   Optional: existing callers and wire shapes are unchanged.
 * Pure text construction, no cordis, no I/O — unit-testable with plain
 * assertions, mirroring the purity discipline of `squash.ts`.
 * @module dsh-session-fork/src/branch-events
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** The branch operations that emit AI-visible provenance messages. */
export type BranchEventKind = 'fork' | 'squash' | 'rebase'

/**
 * The facts a branch event states. Every field names durable truth at write
 * time — the builders render them verbatim, so callers must resolve branch
 * names from the registry BEFORE building (names are point-in-time, exactly
 * like commit messages).
 */
export interface BranchEventFacts {
  /** Which operation this event records. */
  readonly kind: BranchEventKind
  /** Name of the branch the material came FROM (the child for squash/rebase, the parent for fork). */
  readonly from: string
  /** Name of the branch this message is written INTO. */
  readonly to: string
  /** Fork point: the parent's turn number at which `from` diverged. Present on every event once known. */
  readonly atTurn?: number
  /** The child-side turn range this event covers (squash region, rebase graft). */
  readonly range?: { readonly start: number; readonly end: number }
  /** Session id of the `from` branch, for machine consumers. */
  readonly fromSessionId?: string
}

/**
 * Machine-readable provenance riding the message `source`. Extends the
 * official plugin-source shape (merge-extensible `MessageSourceMap`, cf.
 * `MergeCheckpointSource` in squash.ts); `isCompactCheckpointSource`-style
 * consumers ignore unknown fields, and the model never sees any of this.
 */
export interface BranchEventSource {
  readonly kind: 'plugin'
  readonly plugin: 'dsh-session-fork'
  /** 'recall' when the payload is lifted out of another session's log (rebase transcripts). */
  readonly form: 'notice' | 'recall'
  /** One-line UI account, bounded to the official 120-char notice limit. */
  readonly summary: string
  /** Structured provenance for future DAG consumers (visualizers, rename tracking). */
  readonly branchEvent: BranchEventFacts
}

/** One page of a multi-page envelope payload (rebase transcripts can be long). */
export interface BranchEventPage {
  /** 1-based page index. */
  readonly index: number
  /** Total page count; > 1 marks this as a paged delivery. */
  readonly total: number
}

/**
 * Caller-owned source fields. The reserved keys a builder owns (`kind`,
 * `form`, `summary`, `branchEvent`) are compile-time rejected so a caller can
 * never silently rewrite the envelope's semantics; overriding `plugin` (the
 * squash checkpoint's `isCompactCheckpointSource` compatibility) stays legal.
 */
export type BranchEventExtraSource = Record<string, unknown> & {
  kind?: never
  form?: never
  summary?: never
  branchEvent?: never
}

/**
 * Build a one-line branch event notice: no payload, no tags. Used for fork
 * notifications in both directions (the parent learns it was forked; the
 * child's seed marker is a notice too — a fork carries no payload, only the
 * fact of divergence).
 * @param facts - the event facts; `kind` must be 'fork'.
 * @param line - the complete one-line statement.
 * @param extraSource - caller-owned fields spread onto the source AFTER
 *   `branchEvent` (e.g. MergeCheckpointSource fields); the reserved keys this
 *   builder owns are compile-time rejected ({@link BranchEventExtraSource}).
 * @returns a user message whose source carries the structured provenance.
 */
export function buildBranchNotice(
  facts: BranchEventFacts,
  line: string,
  extraSource?: BranchEventExtraSource,
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: line }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: boundContextSummary(`${facts.kind}: ${facts.from} → ${facts.to}`),
      branchEvent: facts,
      ...extraSource,
    } as BranchEventSource & Record<string, unknown>,
  })
}

/**
 * The standard notice lines. Centralized so every producer states the same
 * fact in the same words — the model learns one vocabulary, tests assert one
 * string. The phrasing follows the official checkpoint preamble: state the
 * fact, mark inherited material as background, tell the model to continue.
 */
export const branchNoticeLines = {
  /** Written into the CHILD's seed: the history above is inherited, not the child's own. */
  forkChild: (facts: BranchEventFacts): string =>
    `You are branch "${facts.to}", forked from branch "${facts.from}" at turn ${facts.atTurn ?? '?'}. ` +
    `The conversation above was inherited from "${facts.from}" — you did not produce it. ` +
    `Treat it as established background and continue the task from here.`,
  /** Written into the PARENT: a branch diverged from you here. */
  forkParent: (facts: BranchEventFacts): string =>
    `Branch "${facts.to}" forked from you at turn ${facts.atTurn ?? '?'}.`,
} as const

/** The material noun each envelope kind delivers. */
const MATERIAL_NOUN: Readonly<Record<BranchEventKind, string>> = {
  fork: 'notice',
  squash: 'summary',
  rebase: 'transcript',
}

/**
 * Build a branch event envelope around a payload: an English preamble plus
 * an XML-style tag pair, mirroring the official compaction checkpoint. The
 * payload is material from ANOTHER branch: a squash summary, or one page of
 * a rebase transcript. The preamble states full provenance and marks the
 * material as background; the close tag keeps later grafted material from
 * blurring into the target's own history.
 * @param facts - the event facts; `kind` is 'squash' or 'rebase' (fork has no payload).
 * @param payload - the verbatim payload text (summary or transcript page).
 * @param page - paging coordinates for multi-message rebase transcripts.
 * @param extraSource - caller-owned fields spread onto the source AFTER
 *   `branchEvent` (e.g. MergeCheckpointSource fields); the reserved keys this
 *   builder owns are compile-time rejected ({@link BranchEventExtraSource}).
 * @returns a user message whose source carries the structured provenance.
 */
export function buildBranchEnvelope(
  facts: BranchEventFacts,
  payload: string,
  page?: BranchEventPage,
  extraSource?: BranchEventExtraSource,
): UserMessage {
  const pagePart = page !== undefined && page.total > 1 ? ` ${page.index}/${page.total}` : ''
  const rangePart = facts.range !== undefined ? `, covering its turns ${facts.range.start}–${facts.range.end}` : ''
  const originPart = facts.atTurn !== undefined ? ` (forked at turn ${facts.atTurn}${rangePart})` : rangePart !== '' ? ` (${rangePart.slice(2)})` : ''
  const preamble =
    `This is a ${facts.kind} from branch "${facts.from}"${originPart} into branch "${facts.to}". ` +
    `The ${MATERIAL_NOUN[facts.kind]} below happened on "${facts.from}" and was transferred by dsh-session-fork; ` +
    `it is not part of this branch's own conversation. Treat it as established background.`
  const text =
    `${preamble}\n` +
    `<branch-${facts.kind}${pagePart}>\n` +
    `${payload}\n` +
    `</branch-${facts.kind}>`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: facts.kind === 'rebase' ? 'recall' : 'notice',
      summary: boundContextSummary(
        page !== undefined && page.total > 1
          ? `${facts.kind} ${page.index}/${page.total}: ${facts.from} → ${facts.to}`
          : `${facts.kind}: ${facts.from} → ${facts.to}`,
      ),
      branchEvent: facts,
      ...extraSource,
    } as BranchEventSource & Record<string, unknown>,
  })
}
