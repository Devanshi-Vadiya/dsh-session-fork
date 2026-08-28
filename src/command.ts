/**
 * `/branch` command family: argument parsing, execution core, and output
 * rendering. Pure and cordis-free: the plugin shell in `index.ts` feeds an
 * action plus {@link BranchCommandDeps}; everything here is unit-testable
 * with fakes.
 * @module dsh-session-fork/src/command
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { buildBranchNotice, branchNoticeLines } from './branch-events.js'
import type { BranchEventFacts } from './branch-events.js'
import type { BranchPorts } from './branch.js'
import { BranchForkError, createBranchFrom as forkToBranch, createRootBranch as adoptAsRoot } from './branch.js'
import type { BranchListing, BranchRecord, RegistryState, RegistryStore, SessionExists } from './types.js'
import {
  BranchRegistryError,
  assertBranchNameFree,
  createBranch,
  getBranch,
  listBranches,
  loadRegistry,
  removeBranch,
  renameBranch,
  saveRegistry,
} from './registry.js'

/**
 * Structurally compatible with dsh's `CommandResult` (success/error + text),
 * without importing the host package.
 */
export type BranchCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export const BRANCH_USAGE = [
  'Usage:',
  '  /branch <name>            fork the current session into a named branch',
  '  /branch create <name>     same as /branch <name>',
  '  /branch adopt <name>      adopt the current session as the root branch',
  '  /branch list              list this workspace\'s branches',
  '  /branch rm <name> --yes   remove a branch ref (never deletes session data)',
  '  /branch rename <old> <new>',
].join('\n')

/** One parsed `/branch` invocation. */
export type BranchAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'adopt'; readonly name: string }
  | { readonly kind: 'rm'; readonly name: string; readonly confirmed: boolean }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'usage'; readonly problem: string }

/**
 * Parse the text after `/branch`. Never throws; ambiguous input becomes a
 * `usage` action that renders {@link BRANCH_USAGE}.
 */
export function parseBranchAction(rawInput: string): BranchAction {
  const tokens = rawInput.trim().split(/\s+/).filter(t => t.length > 0)
  const [head, second, third] = tokens as [string | undefined, string | undefined, string | undefined]
  switch (head) {
    case undefined:
    case 'list':
      return tokens.length > 1
        ? { kind: 'usage', problem: `'list' takes no arguments` }
        : { kind: 'list' }
    case 'create':
      return second === undefined || tokens.length > 2
        ? { kind: 'usage', problem: `'create' takes exactly one branch name` }
        : { kind: 'create', name: second }
    case 'adopt':
      return second === undefined || tokens.length > 2
        ? { kind: 'usage', problem: `'adopt' takes exactly one branch name` }
        : { kind: 'adopt', name: second }
    case 'rm':
      if (tokens.length === 2) return { kind: 'rm', name: second!, confirmed: false }
      if (tokens.length === 3 && third === '--yes') {
        return { kind: 'rm', name: second!, confirmed: true }
      }
      return { kind: 'usage', problem: `'rm' takes one branch name and an optional --yes` }
    case 'rename':
      return tokens.length !== 3
        ? { kind: 'usage', problem: `'rename' takes exactly two branch names` }
        : { kind: 'rename', from: second!, to: third! }
    case 'help':
      return { kind: 'usage', problem: '' }
    default:
      return tokens.length > 1
        ? { kind: 'usage', problem: `unknown subcommand '${head}'` }
        : { kind: 'create', name: head! }
  }
}

/** Capabilities one `/branch` execution needs. */
export interface BranchCommandDeps {
  /** Session the invoking agent is currently attached to. */
  readonly currentSessionId: string
  /** Per-workspace registry persistence. */
  readonly store: RegistryStore
  /** Fork/create ports from `branch.ts`. */
  readonly ports: BranchPorts
  /** Liveness check for dangling marking. */
  readonly sessionExists: SessionExists
  /**
   * Branch-event notice delivery (issues #28/#37): inject a one-line notice
   * into ANY session — the forked PARENT, the ADOPTED session, or the
   * RENAMED branch's session. Called once per successful operation, AFTER
   * the change is durably written. Contract: this callback never throws —
   * the operation already succeeded, and a notification failure must
   * surface as a logged warning, never as a failed command. Implementations
   * own their error handling.
   */
  readonly notifySession?: (
    sessionId: string,
    notice: UserMessage,
  ) => Promise<void>
}

/** Render one branch listing line. */
function renderLine(listing: BranchListing): string {
  const { record } = listing
  const origin =
    record.forkOrigin === null
      ? 'root'
      : `← ${record.forkOrigin.parentSessionId}@${String(record.forkOrigin.atSeq)}`
  const flag = listing.dangling ? ' [dangling: session missing]' : ''
  return `  ${record.name}  ${record.sessionId}  (${origin})${flag}`
}

/**
 * Shared core of `/branch create` and the GUI `fork` RPC endpoint: the full
 * named-fork pipeline with the registry as the authority.
 *
 * Order is load-bearing: the name is pre-checked against the registry
 * BEFORE forking (a duplicate/invalid name must fail without spawning an
 * orphan child session), the fork runs through the official agent path,
 * and the record is written only after the child exists. The post-fork
 * `createBranch` stays as the authoritative registry gate for the race
 * window the pre-check cannot close.
 *
 * @param name - prospective branch name (validated, uniqueness-checked).
 * @param deps - command-shaped capabilities (session id, store, ports).
 * @param options.atSeq - optional in-log anchor (fork through the turn
 *   containing this event seq); omitted means the last completed turn.
 * @returns the frozen record of the created branch.
 * @throws {BranchRegistryError} `invalid-name` / `duplicate-name` (pre-fork),
 *   {@link BranchForkError} on fork/rename failure, `BranchRegistryError`
 *   on the post-fork write (child stays listed like any anonymous fork).
 */
export async function createNamedBranch(
  name: string,
  deps: BranchCommandDeps,
  options: { readonly atSeq?: number } = {},
): Promise<BranchRecord> {
  const preState = await loadRegistry(deps.store)
  assertBranchNameFree(preState, name)
  // Issue #28: resolve the source's registry name BEFORE forking so the
  // seed-embedded notice states durable point-in-time lineage ("forked from
  // branch X", not a session id) whenever the source is a registered branch.
  const parentName = Object.values(preState.branches)
    .find(record => record.sessionId === deps.currentSessionId)?.name
  const { record, facts } = await forkToBranch(
    deps.currentSessionId,
    name,
    deps.ports,
    {
      ...options.atSeq === undefined ? {} : { atSeq: options.atSeq },
      ...parentName === undefined ? {} : { parentName },
    },
  )
  const state = createBranch(preState, {
    name: record.name,
    sessionId: record.sessionId,
    forkOrigin: record.forkOrigin,
    createdAt: record.createdAt,
  })
  await saveRegistry(deps.store, state)
  // Parent notification after the durable write (issue #28): the child's
  // notice already rode the seed; this is the other direction, delivered
  // through the never-throw `notifySession` contract.
  if (deps.notifySession !== undefined && record.forkOrigin !== null) {
    await deps.notifySession(
      record.forkOrigin.parentSessionId,
      buildBranchNotice(facts, branchNoticeLines.forkParent(facts)),
    )
  }
  return record
}

/**
 * Execute one parsed action against the registry. All failures return
 * `kind: 'error'` results — a command must never crash the host.
 */
export async function executeBranchAction(
  action: BranchAction,
  deps: BranchCommandDeps,
): Promise<BranchCommandResult> {
  switch (action.kind) {
    case 'usage':
      return {
        kind: 'error',
        text: action.problem === '' ? BRANCH_USAGE : `${action.problem}\n${BRANCH_USAGE}`,
      }

    case 'list': {
      const state = await loadRegistry(deps.store)
      const listings = await listBranches(state, deps.sessionExists)
      if (listings.length === 0) {
        return { kind: 'success', text: 'No branches in this workspace yet. Create one with /branch <name>.' }
      }
      return { kind: 'success', text: [`Branches:`, ...listings.map(renderLine)].join('\n') }
    }

    case 'create': {
      let record
      try {
        record = await createNamedBranch(action.name, deps)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      const origin =
        record.forkOrigin === null
          ? 'root branch'
          : `forked from ${record.forkOrigin.parentSessionId} at event ${String(record.forkOrigin.atSeq)} (turn end)`
      return {
        kind: 'success',
        text: `Branch '${record.name}' → session ${record.sessionId} (${origin}).`,
      }
    }

    case 'adopt': {
      let record
      try {
        record = await adoptAsRoot(deps.currentSessionId, action.name, deps.ports)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      let state = await loadRegistry(deps.store)
      try {
        state = createBranch(state, {
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin,
          createdAt: record.createdAt,
        })
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      await saveRegistry(deps.store, state)
      // Adoption notice after the durable write (issue #37): the adopted
      // session learns it IS a branch — same never-throw contract as the
      // fork parent notice. `from` names the session id: until this event
      // it had no branch name at all.
      if (deps.notifySession !== undefined) {
        const facts: BranchEventFacts = {
          kind: 'adopt',
          from: deps.currentSessionId,
          to: record.name,
        }
        await deps.notifySession(
          deps.currentSessionId,
          buildBranchNotice(facts, branchNoticeLines.adopted(facts)),
        )
      }
      return {
        kind: 'success',
        text: `Branch '${record.name}' → session ${record.sessionId} (root branch, adopted the current session).`,
      }
    }

    case 'rm': {
      let state = await loadRegistry(deps.store)
      if (!action.confirmed) {
        try {
          const record = getBranch(state, action.name)
          return {
            kind: 'error',
            text: `Refusing to remove branch '${action.name}' (points at ${record.sessionId}). Re-run with --yes to remove the ref. Session data is never deleted.`,
          }
        } catch {
          return { kind: 'error', text: branchErrorMessage(new BranchLookupFailure(action.name)) }
        }
      }
      try {
        state = removeBranch(state, action.name)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      await saveRegistry(deps.store, state)
      return { kind: 'success', text: `Removed branch '${action.name}'. Sessions are untouched.` }
    }

    case 'rename': {
      let state = await loadRegistry(deps.store)
      let sessionId: string
      try {
        // Capture the target BEFORE the rename: the notice goes into the
        // renamed branch's session, whatever the session is.
        sessionId = getBranch(state, action.from).sessionId
        state = renameBranch(state, action.from, action.to)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      await saveRegistry(deps.store, state)
      // Rename notice after the durable write (issue #37): the session
      // learns its branch vocabulary changed — old name no longer resolves
      // in any branch command.
      if (deps.notifySession !== undefined) {
        const facts: BranchEventFacts = { kind: 'rename', from: action.from, to: action.to }
        await deps.notifySession(
          sessionId,
          buildBranchNotice(facts, branchNoticeLines.renamed(facts)),
        )
      }
      return { kind: 'success', text: `Renamed branch '${action.from}' → '${action.to}'.` }
    }
  }
}

/** Local mirror of the unknown-branch message; avoids re-implementing lookup.
 * Used only for 'rm' without confirmation, we need to check the branch exists.
 */
class BranchLookupFailure extends BranchRegistryError {
  constructor(name: string) {
    super('unknown-branch', `no branch named '${name}'`)
  }
}

/** Map registry/fork typed errors to user-facing text (commands and the
 * GUI `fork` RPC endpoint share this rendering). */
export function branchErrorMessage(error: unknown): string {
  if (error instanceof BranchForkError) {
    return error.message
  }
  if (error instanceof BranchRegistryError) {
    switch (error.code) {
      case 'duplicate-name': return `A branch with that name already exists. Use /branch list, or /branch rename first.`
      case 'unknown-branch': return error.message
      case 'invalid-name': return `Invalid branch name: ${error.message}`
    }
  }
  return String(error instanceof Error ? error.message : error)
}
