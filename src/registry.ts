/**
 * Branch registry core: pure state transforms plus a persistence seam.
 * @module dsh-session-fork/src/registry
 *
 * All mutating functions are copy-on-write: they return a new frozen
 * {@link RegistryState} and never modify their input. Persistence goes
 * through the injected {@link RegistryStore} so tests run without cordis;
 * production wires a dsh storage-domain-backed store (see stage 3).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateBranchName } from './branch-name.js'
import type {
  BranchListing,
  BranchRecord,
  RegistryState,
  RegistryStore,
  SessionExists,
} from './types.js'

/** Typed failure of one registry operation. */
export class BranchRegistryError extends Error {
  /** Machine-readable failure code. */
  readonly code: 'duplicate-name' | 'unknown-branch' | 'invalid-name'

  constructor(code: BranchRegistryError['code'], message: string) {
    super(message)
    this.name = 'BranchRegistryError'
    this.code = code
  }
}

/**
 * Reject branch names the official session-title pipeline would rewrite.
 *
 * A branch name is the registry's record key AND — since issue #7 — the
 * exact title `/branch create` and `/branch adopt` write onto the session
 * through the official `session.rename` handler. That handler accepts its
 * input by *normalizing* it (strips terminal/control/invisible characters,
 * collapses whitespace runs, trims, truncates to the deployment's UTF-8
 * byte budget), so a name it would rewrite would produce a session title
 * that differs from the registry key. The gate is therefore the official
 * normalizer itself, held to identity: a name passes only when the official
 * pipeline returns it byte-for-byte unchanged. Passing the gate makes the
 * later rename deterministic — it must accept the title and store exactly
 * this name.
 *
 * Validation logic lives in branch-name.ts (shared with the browser
 * fork-name dialog); this wrapper keeps the registry's throwing contract.
 */
function assertValidName(name: string): void {
  const check = validateBranchName(name)
  if (!check.ok) {
    throw new BranchRegistryError('invalid-name', check.reason)
  }
}

/** A fresh registry with no branches. */
export function emptyState(): RegistryState {
  return { branches: Object.freeze({}) }
}

/** Look up one branch or fail with `unknown-branch`. */
export function getBranch(state: RegistryState, name: string): BranchRecord {
  const record = state.branches[name]
  if (record === undefined) {
    throw new BranchRegistryError('unknown-branch', `no branch named '${name}'`)
  }
  return record
}

/** Inputs accepted by {@link createBranch}. */
export interface CreateBranchInput {
  readonly name: string
  readonly sessionId: string
  readonly forkOrigin: BranchRecord['forkOrigin']
  readonly createdAt?: string
}

/**
 * Validate a prospective branch name (format + availability) without
 * registering anything. Callers that create side effects under the name —
 * e.g. forking a child session — run this FIRST, so a bad name fails
 * before the side effect can orphan anything.
 */
export function assertBranchNameFree(state: RegistryState, name: string): void {
  assertValidName(name)
  if (state.branches[name] !== undefined) {
    throw new BranchRegistryError(
      'duplicate-name',
      `a branch named '${name}' already exists`,
    )
  }
}

/** Register a new branch ref. Fails on invalid or duplicate names. */
export function createBranch(state: RegistryState, input: CreateBranchInput): RegistryState {
  assertBranchNameFree(state, input.name)
  const record: BranchRecord = Object.freeze({
    name: input.name,
    sessionId: input.sessionId,
    forkOrigin: input.forkOrigin === null ? null : Object.freeze({ ...input.forkOrigin }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  })
  return { branches: Object.freeze({ ...state.branches, [input.name]: record }) }
}

/** Point a branch at a different session (used when re-adopting a session). */
export function setBranchSession(
  state: RegistryState,
  name: string,
  sessionId: string,
): RegistryState {
  const record = getBranch(state, name)
  return {
    branches: Object.freeze({
      ...state.branches,
      [name]: Object.freeze({ ...record, sessionId }),
    }),
  }
}

/** Rename a branch, keeping everything else. Unknown or clashing names fail. */
export function renameBranch(state: RegistryState, from: string, to: string): RegistryState {
  const record = getBranch(state, from)
  assertValidName(to)
  if (state.branches[to] !== undefined) {
    throw new BranchRegistryError('duplicate-name', `a branch named '${to}' already exists`)
  }
  const { [from]: _removed, ...rest } = state.branches
  return {
    branches: Object.freeze({
      ...rest,
      [to]: Object.freeze({ ...record, name: to }),
    }),
  }
}

/** Delete one branch ref. The referenced session is left untouched. */
export function removeBranch(state: RegistryState, name: string): RegistryState {
  getBranch(state, name)
  const { [name]: _removed, ...rest } = state.branches
  return { branches: Object.freeze(rest) }
}

/** List all branches, marking refs whose session no longer exists. */
export async function listBranches(
  state: RegistryState,
  sessionExists: SessionExists,
): Promise<BranchListing[]> {
  const listings = await Promise.all(
    Object.keys(state.branches).map(async (name) => {
      const record = state.branches[name]!
      const dangling = !(await sessionExists(record.sessionId))
      return Object.freeze({ record, dangling }) as BranchListing
    }),
  )
  listings.sort((a, b) => a.record.name.localeCompare(b.record.name))
  return listings
}

/** Load the persisted state; a never-written medium yields a fresh state. */
export async function loadRegistry(store: RegistryStore): Promise<RegistryState> {
  const loaded = await store.load()
  return loaded === null ? emptyState() : loaded
}

/** Persist the full state. */
export async function saveRegistry(store: RegistryStore, state: RegistryState): Promise<void> {
  await store.save(state)
}

/**
 * Simple durable store: one pretty-printed JSON file, written atomically via
 * rename. Useful for tests and as the reference semantics for the
 * storage-domain-backed production store.
 */
export function createFileStore(path: string): RegistryStore {
  return {
    async load(): Promise<RegistryState | null> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as RegistryState
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async save(state: RegistryState): Promise<void> {
      const payload = `${JSON.stringify(state, null, 2)}\n`
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, path)
    },
  }
}
