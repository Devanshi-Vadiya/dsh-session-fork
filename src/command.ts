/**
 * `/branch` command family: argument parsing, execution core, and output
 * rendering. Pure and cordis-free: the plugin shell in `index.ts` feeds an
 * action plus {@link BranchCommandDeps}; everything here is unit-testable
 * with fakes.
 * @module dsh-fork/src/command
 */

import type { BranchPorts } from './branch.js'
import { BranchForkError, createBranchFrom as forkToBranch, createRootBranch as adoptAsRoot } from './branch.js'
import type { BranchListing, RegistryState, RegistryStore, SessionExists } from './types.js'
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

/** Subcommands that can never be a plain branch name. */
const SUBCOMMANDS = new Set(['list', 'rm', 'rename', 'create', 'adopt', 'help'])

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
      // Pre-check the name BEFORE forking: a duplicate/invalid name must
      // fail without having spawned an orphan child session. The post-fork
      // createBranch below stays as the authoritative registry gate.
      const preState = await loadRegistry(deps.store)
      try {
        assertBranchNameFree(preState, action.name)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      let record
      try {
        record = await forkToBranch(deps.currentSessionId, action.name, deps.ports)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      let state = preState
      try {
        state = createBranch(state, {
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin,
          createdAt: record.createdAt,
        })
      } catch (error) {
        // The fork already happened; surface the duplicate-name failure and
        // let the user rename or rm the existing ref. The unreferenced child
        // session stays in the session list like any anonymous fork.
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      await saveRegistry(deps.store, state)
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
      return {
        kind: 'success',
        text: `Branch '${record.name}' → session ${record.sessionId} (root branch, adopted the current session).`,
      }
    }

    case 'rm': {
      if (!action.confirmed) {
        const target = await loadRegistry(deps.store)
        try {
          const record = getBranch(target, action.name)
          return {
            kind: 'error',
            text: `Refusing to remove branch '${action.name}' (points at ${record.sessionId}). Re-run with --yes to remove the ref. Session data is never deleted.`,
          }
        } catch {
          return { kind: 'error', text: branchErrorMessage(new BranchLookupFailure(action.name)) }
        }
      }
      let state = await loadRegistry(deps.store)
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
      try {
        state = renameBranch(state, action.from, action.to)
      } catch (error) {
        return { kind: 'error', text: branchErrorMessage(error) }
      }
      await saveRegistry(deps.store, state)
      return { kind: 'success', text: `Renamed branch '${action.from}' → '${action.to}'.` }
    }
  }
}

/** Local mirror of the unknown-branch message; avoids re-implementing lookup. */
class BranchLookupFailure extends BranchRegistryError {
  constructor(name: string) {
    super('unknown-branch', `no branch named '${name}'`)
  }
}

/** Map registry/fork typed errors to user-facing text. */
function branchErrorMessage(error: unknown): string {
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
