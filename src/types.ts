/**
 * Public types of dsh-fork's branch registry.
 * @module dsh-fork/src/types
 */

/** Where a branch was forked from, inside the parent session's event log. */
export interface ForkOrigin {
  /** Session the fork was created from. */
  readonly parentSessionId: string
  /** Event seq in the parent session that locates the fork boundary. */
  readonly atSeq: number
}

/** One named branch ref pointing at a session. */
export interface BranchRecord {
  /** Human-chosen branch name, unique within its workspace registry. */
  readonly name: string
  /** Session id the ref points at. */
  readonly sessionId: string
  /** Fork lineage; `null` for the root branch of a workspace. */
  readonly forkOrigin: ForkOrigin | null
  /** ISO-8601 creation timestamp. */
  readonly createdAt?: string
}

/** Whole persisted state of one workspace's branch registry. */
export interface RegistryState {
  /** Branch records keyed by branch name. */
  readonly branches: Readonly<Record<string, BranchRecord>>
}

/**
 * Persistence seam for one workspace's registry. Implementations own the
 * medium (dsh storage-domain in production, JSON file or memory in tests)
 * and must make `save` durable before it resolves.
 */
export interface RegistryStore {
  /** Load the persisted state, or `null` when nothing was ever written. */
  load(): Promise<RegistryState | null>
  /** Persist the full state atomically. */
  save(state: RegistryState): Promise<void>
}

/**
 * Existence check for a referenced session. Injected so registry logic stays
 * testable without a live dsh session store; implementations answer whether
 * the session's persisted log currently exists.
 */
export type SessionExists = (sessionId: string) => Promise<boolean> | boolean

/** One branch as listed to the user, with liveness of its target session. */
export interface BranchListing {
  readonly record: BranchRecord
  /** True when the referenced session no longer exists (dangling ref). */
  readonly dangling: boolean
}
