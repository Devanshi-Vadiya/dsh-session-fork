/**
 * The cross-branch merge-region authority: one pure function that decides,
 * from the registry's fork DAG and one source session, which part of the
 * source's conversation a transfer into a target branch must carry.
 *
 * The rule (docs/design/rebase.md, generalized 2026-08-23) is git
 * merge-base semantics restricted to "the source's own work":
 * the region is the source's content since the fork point where its
 * lineage left the lowest common ancestor (LCA) of source and target.
 *
 * - LCA = target (target is an ancestor of the source):
 *   - direct parent → the seed boundary, exactly `postForkRange` (old logic);
 *   - deeper ancestor → the leaving fork's `atSeq`, mapped into source coords.
 * - LCA = source (source is an ancestor of the target): the region is the
 *   source's content after the TARGET's fork point — what the target lacks.
 * - LCA = a third session: the source's fork point off that ancestor.
 * - No LCA: the source's whole conversation.
 *
 * Coordinate validity: every fork copies the parent's prefix verbatim with
 * preserved seq numbering, so an ancestor-side `atSeq` below a descendant's
 * seed boundary addresses the same event in the descendant's log. The
 * `session/end-seed` marker is authoritative only for the direct-parent
 * case (the seed slice may extend past the anchoring `turn/end`, so
 * `seedLength >= atSeq + 1` — the two coordinates are NOT interchangeable).
 *
 * Pure and cordis-free; the same tool-pairing balance gates as squash guard
 * every computed boundary. squash, rebase, and merge all consume this one
 * authority so they can never disagree about lineage.
 * @module dsh-session-fork/src/merge-region
 */

import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { postForkRange, SquashCoreError } from './squash.js'
import type { RegistryState } from './types.js'

/** How the target relates to the source's lineage for one merge region. */
export type MergeRelation =
  /** The target is the source's direct fork parent (seed boundary, old logic). */
  | 'direct-parent'
  /** The target is a deeper ancestor of the source. */
  | 'ancestor'
  /** The source is an ancestor of the target (transfer "into my child"). */
  | 'source-ancestor'
  /** The lineages share an ancestor that is neither endpoint. */
  | 'relative'
  /** The lineages do not intersect; the whole source conversation transfers. */
  | 'unrelated'

/** One successful merge-region decision. */
export interface MergeRegion {
  /** Discriminant: a computed region. */
  readonly kind: 'ok'
  /** Inclusive first source surface seq of the transfer region. */
  readonly start: number
  /** Inclusive last source surface seq of the transfer region. */
  readonly end: number
  /** How the two branches relate; consumers word envelopes with it. */
  readonly relation: MergeRelation
  /** Session id of the lowest common ancestor, when one exists. */
  readonly lcaSessionId?: string
}

/** One failed merge-region decision; codes mirror squash's contract. */
export interface MergeRegionError {
  readonly kind: 'error'
  readonly code:
    | 'empty-region'
    | 'unbalanced-range'
    | 'missing-seed-boundary'
  readonly message: string
}

/** The result of one merge-region computation. */
export type MergeRegionResult = MergeRegion | MergeRegionError

/** One fork edge on a walked ancestry: `sessionId` forked from `parentSessionId` at `atSeq`. */
interface AncestryStep {
  readonly sessionId: string
  readonly parentSessionId: string
  readonly atSeq: number
}

/**
 * Walk one session's fork ancestry through the registry, child first.
 * The walk stops at the first unregistered or root ancestor and guards
 * against cycles (a corrupt registry must hang no command).
 * @param state - the workspace registry.
 * @param sessionId - whose ancestry to walk.
 * @returns ordered child-first fork edges, plus every session id visited
 * (including the start).
 */
function ancestry(
  state: RegistryState,
  sessionId: string,
): { steps: AncestryStep[]; ids: Set<string> } {
  const steps: AncestryStep[] = []
  const ids = new Set<string>([sessionId])
  let currentId = sessionId
  while (true) {
    const record = Object.values(state.branches).find(r => r.sessionId === currentId)
    if (record === undefined || record.forkOrigin === null) break
    const { parentSessionId, atSeq } = record.forkOrigin
    if (parentSessionId === currentId || ids.has(parentSessionId)) break
    steps.push({ sessionId: currentId, parentSessionId, atSeq })
    ids.add(parentSessionId)
    currentId = parentSessionId
  }
  return { steps, ids }
}

/**
 * Compute the surface region of `sourceSession` that a transfer into the
 * branch named by `targetSessionId` must carry, with the shared squash
 * balance gates. All failures are returned, never thrown.
 *
 * The caller guarantees `targetSessionId !== sourceSession.id` (rebase's
 * self-target check runs first); a violation throws defensively.
 * @param state - the workspace registry (the fork DAG).
 * @param sourceSession - the open source session; read-only.
 * @param targetSessionId - the target branch's session id.
 * @returns the region, or an error result.
 */
export function mergeRegion(
  state: RegistryState,
  sourceSession: Session,
  targetSessionId: string,
): MergeRegionResult {
  if (targetSessionId === sourceSession.id) {
    throw new Error('merge-region: target and source are the same session')
  }
  const source = ancestry(state, sourceSession.id)
  const target = ancestry(state, targetSessionId)

  // Case: the source is an ancestor of the target. The region is the
  // source's content after the child-most fork edge where the target's
  // lineage left the source — exactly what the target lacks.
  if (target.ids.has(sourceSession.id)) {
    const leaving = target.steps.find(step => step.parentSessionId === sourceSession.id)
    if (leaving === undefined) {
      throw new Error('merge-region: ancestry walk reached an inconsistent registry state')
    }
    return regionSince(sourceSession, leaving.atSeq, 'source-ancestor', sourceSession.id)
  }

  // Case: a shared ancestor on the source's chain (possibly the target).
  const leaving = source.steps.find(step => target.ids.has(step.parentSessionId))
  if (leaving !== undefined) {
    const lca = leaving.parentSessionId
    if (lca === targetSessionId) {
      if (source.steps[0] === leaving) {
        // Direct parent: the seed boundary is authoritative (old logic).
        return regionFromPostFork(sourceSession, 'direct-parent', targetSessionId)
      }
      return regionSince(sourceSession, leaving.atSeq, 'ancestor', targetSessionId)
    }
    return regionSince(sourceSession, leaving.atSeq, 'relative', lca)
  }

  // No shared ancestry (or the registry walk truncated before one): the
  // whole conversation transfers.
  return wholeRegion(sourceSession)
}

/** Seed-boundary region via the squash authority (direct-parent case). */
function regionFromPostFork(
  session: Session,
  relation: MergeRelation,
  lcaSessionId: string,
): MergeRegionResult {
  try {
    const { start, end } = postForkRange(session)
    return { kind: 'ok', start, end, relation, lcaSessionId }
  } catch (error) {
    if (error instanceof SquashCoreError) {
      return { kind: 'error', code: mapPostForkCode(error.code), message: error.message }
    }
    throw error
  }
}

/** Map postForkRange's stable error code to its merge-region counterpart. */
function mapPostForkCode(code: SquashCoreError['code']): MergeRegionError['code'] {
  switch (code) {
    case 'missing-seed-boundary': return 'missing-seed-boundary'
    case 'empty-fork-range': return 'empty-region'
    case 'unbalanced-range': return 'unbalanced-range'
    case 'checkpoint-not-found': return 'empty-region'
  }
}

/** Region of all source surface nodes strictly after `boundarySeq`. */
function regionSince(
  session: Session,
  boundarySeq: number,
  relation: MergeRelation,
  lcaSessionId: string,
): MergeRegionResult {
  const nodes = session.surface.nodes.filter(seq => seq > boundarySeq)
  return settleRegion(session, nodes, relation, lcaSessionId)
}

/** The whole conversation as the region (no shared ancestry). */
function wholeRegion(session: Session): MergeRegionResult {
  return settleRegion(session, [...session.surface.nodes], 'unrelated', undefined)
}

/** Apply the empty and balance gates to one candidate node list. */
function settleRegion(
  session: Session,
  nodes: readonly number[],
  relation: MergeRelation,
  lcaSessionId: string | undefined,
): MergeRegionResult {
  const start = nodes[0]
  const end = nodes.at(-1)
  if (start === undefined || end === undefined) {
    return {
      kind: 'error',
      code: 'empty-region',
      message: 'merge-region: the source has no conversation in the transfer region',
    }
  }
  if (!toolPairingBalancedBefore(session, start)) {
    return {
      kind: 'error',
      code: 'unbalanced-range',
      message: `merge-region: region start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`,
    }
  }
  if (!toolPairingBalancedAfter(session, end)) {
    return {
      kind: 'error',
      code: 'unbalanced-range',
      message: `merge-region: region end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`,
    }
  }
  return { kind: 'ok', start, end, relation, ...lcaSessionId === undefined ? {} : { lcaSessionId } }
}
