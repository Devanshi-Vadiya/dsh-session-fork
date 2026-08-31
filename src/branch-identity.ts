/**
 * Ambient branch identity (issue #28 phase 2): the system-prompt section
 * that states, at every assembly, WHICH branch the assembling session is
 * on — the always-current sibling of the event-time notices (#37) and the
 * `*` marker in `/branch list` (#42), reading the same registry they do.
 * @module dsh-session-fork/src/branch-identity
 *
 * Mechanics:
 * - The section's `text` is a per-assembly provider. The harness builds
 *   assembly contexts through `assembleContextFor(agent)`
 *   (dsh-agent/src/dispatch.ts:174), which carries the agent subject —
 *   `agent.session.id` names the session, `agent.session.header.cwd` the
 *   workspace key (the registry's own addressing). The public
 *   `AssembleContext` type does not declare the field, so it is read
 *   through a structural slice — the plugin's established pattern for
 *   host surfaces (cf. `SessionControllerLike`), degrading to an empty
 *   line whenever it is absent.
 * - Providers are SYNCHRONOUS (`PromptSection.text` contract), while the
 *   registry is a storage domain: the cache below is the sync read plane.
 *   Three refresh points keep it honest — `refresh()` enumerates the
 *   whole `branches` table at plugin start and on cache misses,
 *   `updateFromSave()` mirrors every registry save this host performs
 *   (all mutations flow through `saveRegistry`, and every store the
 *   plugin hands out is wrapped by {@link identityTrackingStore}).
 * - Empty text contributes nothing: `renderPrompt` drops empty sections
 *   (system-prompt/src/index.ts:256-263), so a session without a branch
 *   (a subagent, an un-adopted conversation) simply gets no line.
 *
 * Pure text construction, no cordis, no I/O — unit-testable with fake
 * stores and domains, mirroring the purity discipline of `prompt.ts`.
 */

import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { DomainLike } from './store.js'
import type { RegistryState, RegistryStore } from './types.js'

/** Name of the ambient identity section (shadows nothing; plugin-owned). */
export const BRANCH_IDENTITY_SECTION = 'dsh-session-fork:identity'

/**
 * Placement: directly after the vocabulary section (2950) — identity reads
 * best once the reader knows what a branch IS. Bare number: central
 * `SECTION_ORDERS` names are harness-internal (dsh-mnemon precedent).
 */
export const BRANCH_IDENTITY_ORDER = 2960

/**
 * Structural slice of the assembly's agent subject. `assembleContextFor`
 * sets the whole agent; only these two facts carry meaning here.
 */
interface AgentSubjectLike {
  readonly session?: {
    readonly id?: string
    readonly header?: { readonly cwd?: string }
  }
}

/** One branch name a session carries, with its fork parent's name. */
export interface IdentityBranch {
  readonly name: string
  /** Display name of the fork parent's record; null on roots and when the parent is unregistered. */
  readonly parentName: string | null
}

/** Session-id → names index built from one workspace's registry state. */
type WorkspaceIndex = ReadonlyMap<string, readonly IdentityBranch[]>

/**
 * The one-line ambient statement. Wording mirrors `branchNoticeLines`
 * (one vocabulary, tests assert exact strings):
 * - root:   `You are on branch "main" — the root branch of this workspace.`
 * - fork:   `You are on branch "feat/x", forked from branch "main".`
 * - multi:  `You are on branches "a" and "b" — one session carrying two names.`
 * @param branches - the session's branch names, registry order.
 * @returns the line, or '' when the session carries no name.
 */
export function branchIdentityLine(branches: readonly IdentityBranch[]): string {
  const [first] = branches
  if (first === undefined) return ''
  if (branches.length === 1) {
    return first.parentName === null
      ? `You are on branch "${first.name}" — the root branch of this workspace.`
      : `You are on branch "${first.name}", forked from branch "${first.parentName}".`
  }
  const names = branches.map(branch => `"${branch.name}"`).join(', ')
  return `You are on branches ${names} — one session carrying two names.`
}

/** Build one workspace's index from a registry state (parent names resolved within it). */
function indexState(state: RegistryState): WorkspaceIndex {
  const bySession = new Map<string, IdentityBranch[]>()
  for (const record of Object.values(state.branches)) {
    const parentName = record.forkOrigin === null
      ? null
      : Object.values(state.branches).find(
          candidate => candidate.sessionId === record.forkOrigin?.parentSessionId,
        )?.name ?? null
    const list = bySession.get(record.sessionId) ?? []
    list.push({ name: record.name, parentName })
    bySession.set(record.sessionId, list)
  }
  return bySession
}

/** The sync read plane and its refresh points. Created once per plugin. */
export interface BranchIdentity {
  /** The ambient line for one session; '' when it carries no branch name. */
  lineFor(workspaceKey: string, sessionId: string): string
  /** Mirror one registry save (called after the durable write resolves). */
  updateFromSave(workspaceKey: string, state: RegistryState): void
  /** Re-enumerate the whole `branches` table; resolves when cached. */
  refresh(): Promise<void>
}

/**
 * Create the identity cache over one open storage domain.
 * @param domain - the plugin's open `dsh_session_fork` domain (store.ts DomainLike).
 * @returns the cache; safe for concurrent `refresh()` calls (deduplicated).
 */
export function createBranchIdentity(domain: DomainLike): BranchIdentity {
  const workspaces = new Map<string, WorkspaceIndex>()
  const known = new Set<string>()
  let refreshing: Promise<void> | undefined

  const refresh = async (): Promise<void> => {
    const table = domain.table('branches')
    for (const [key, state] of table.entries()) {
      workspaces.set(key, indexState(state))
      known.add(key)
    }
  }

  return {
    lineFor(workspaceKey, sessionId) {
      if (!known.has(workspaceKey)) {
        // Cold workspace (pre-warm raced, or another host process created
        // it): kick one enumeration; this assembly degrades to no line.
        refreshing ??= refresh().finally(() => { refreshing = undefined })
        void refreshing.catch(() => { refreshing = undefined })
        return ''
      }
      return branchIdentityLine(workspaces.get(workspaceKey)?.get(sessionId) ?? [])
    },
    updateFromSave(workspaceKey, state) {
      workspaces.set(workspaceKey, indexState(state))
      known.add(workspaceKey)
    },
    async refresh() {
      await (refreshing ??= refresh().finally(() => { refreshing = undefined }))
    },
  }
}

/**
 * Wrap one registry store so every successful save mirrors into the
 * identity cache — the single choke point all this host's mutations flow
 * through (`saveRegistry` is the only writer, and every store the plugin
 * hands out passes through here).
 * @param store - the store being wrapped.
 * @param workspaceKey - the workspace the store addresses.
 * @param identity - the cache to mirror into.
 * @returns a store with identical semantics plus the post-save mirror.
 */
export function identityTrackingStore(
  store: RegistryStore,
  workspaceKey: string,
  identity: BranchIdentity,
): RegistryStore {
  return {
    async load() {
      return store.load()
    },
    async save(state) {
      await store.save(state)
      identity.updateFromSave(workspaceKey, state)
    },
  }
}

/**
 * The identity section's text provider: resolve the assembling agent's
 * session and workspace through the structural slice, then read the cache.
 * @param identity - the plugin's cache.
 * @returns a provider returning the ambient line, or '' when the assembly
 *   carries no agent subject or the session has no branch name.
 */
export function branchIdentityProvider(identity: BranchIdentity): (context: AssembleContext) => string {
  return (context) => {
    const agent = (context as { agent?: AgentSubjectLike }).agent
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return ''
    return identity.lineFor(agent?.session?.header?.cwd ?? '', sessionId)
  }
}
