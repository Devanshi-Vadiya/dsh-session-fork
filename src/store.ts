/**
 * Production registry persistence: one storage-domain record per workspace.
 * @module dsh-session-fork/src/store
 *
 * The web-app bundle mounts `dsh-storage` + `dsh-storage-json` +
 * `dsh-storage-domain` (json backend rooted at `~/.dsh/storages`), so a
 * plugin sees `ctx.storageDomain`. The `dsh_session_fork` domain stores one
 * `branches` record per workspace, keyed by the workspace's session `cwd`
 * (empty string when a session has no cwd), which matches dsh's own
 * cwd-scoped session storage while keeping everything inside the storage
 * family's durability guarantees.
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RegistryState, RegistryStore } from './types.js'

/** Runtime schema of one persisted branch record. */
const forkOriginSchema = z.object({
  parentSessionId: z.string().min(1),
  atSeq: z.number().int().nonnegative(),
})

const branchRecordSchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().min(1),
  forkOrigin: forkOriginSchema.nullable(),
  createdAt: z.string().optional(),
})

const registryStateSchema = z.object({
  branches: z.record(z.string(), branchRecordSchema),
})

/** Durable declaration of the dsh-session-fork branch registry domain. */
export const dshForkDomainSpec = defineDomain({
  name: 'dsh_session_fork',
  version: 0,
  tables: {
    branches: domainTable<string, RegistryState>(registryStateSchema),
  },
})

/** Minimal structural type of `ctx.storageDomain.open(spec)` we rely on. */
export interface DomainLike {
  table(name: 'branches'): {
    get(key: string): RegistryState | undefined
    put(key: string, value: RegistryState): Promise<void>
    entries(): IterableIterator<[string, RegistryState]>
    readonly size: number
  }
  close(): Promise<void>
}

/**
 * Durable declaration of the pre-rename storage domain, `dsh_fork` — opened
 * exactly once (when the new domain is untouched) to copy old records out.
 * Identical shape to {@link dshForkDomainSpec}, different name, so the
 * storage facility treats it as a distinct unit over the same backend.
 *
 * [rename-migration] removable at v0.1.0, together with
 * {@link migrateLegacyDomain} and its `apply` wiring.
 */
export const legacyForkDomainSpec = defineDomain({
  name: 'dsh_fork',
  version: 0,
  tables: {
    branches: domainTable<string, RegistryState>(registryStateSchema),
  },
})

/**
 * One-time data migration from the pre-rename `dsh_fork` domain into the
 * current `dsh_session_fork` domain.
 *
 * [rename-migration] removable at v0.1.0: once every install that predates
 * the rename has migrated (or the legacy file has been pruned), the legacy
 * domain no longer exists and this whole path is dead code.
 *
 * Strategy: both domains live in the same storage facility, so the legacy
 * domain is read through the SAME formal API (`ctx.storageDomain.open` with
 * {@link legacyForkDomainSpec}) and its `branches` records are copied one by
 * one into the target domain — no raw file access. The legacy unit file is
 * kept as a backup: the domain API has no whole-unit delete, and the
 * target-empty guard below keeps the migration from re-running.
 *
 * @param target - the open current domain (opened by the caller).
 * @param openLegacy - opens the legacy domain; only called when the target
 *   is empty. The returned domain is always closed before this returns.
 * @returns the number of workspace records migrated (0 when there was
 *   nothing to do).
 */
export async function migrateLegacyDomain(
  target: DomainLike,
  openLegacy: () => Promise<DomainLike>,
): Promise<number> {
  // Guard: only an untouched target can need migration. If anything is
  // already stored under the new name, the rename ran before and the legacy
  // medium is stale — never overwrite newer data.
  const targetBranches = target.table('branches')
  if (targetBranches.size > 0) return 0
  const legacy = await openLegacy()
  try {
    const legacyBranches = legacy.table('branches')
    let migrated = 0
    for (const [workspaceKey, state] of legacyBranches.entries()) {
      // A key already present wins (idempotence under retry); with an
      // untouched target this cannot fire.
      if (targetBranches.get(workspaceKey) === undefined) {
        await targetBranches.put(workspaceKey, state)
        migrated += 1
      }
    }
    return migrated
  } finally {
    await legacy.close()
  }
}

/**
 * Adapt one open domain into the registry's persistence seam for one
 * workspace key. `put` reaches backend durability before it resolves, so a
 * resolved save survives restart (ROADMAP v0.0.1 acceptance 1).
 */
export function createDomainStore(domain: DomainLike, workspaceKey: string): RegistryStore {
  return {
    async load(): Promise<RegistryState | null> {
      return domain.table('branches').get(workspaceKey) ?? null
    },
    async save(state: RegistryState): Promise<void> {
      await domain.table('branches').put(workspaceKey, state)
    },
  }
}
