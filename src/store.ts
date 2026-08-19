/**
 * Production registry persistence: one storage-domain record per workspace.
 * @module dsh-fork/src/store
 *
 * The web-app bundle mounts `dsh-storage` + `dsh-storage-json` +
 * `dsh-storage-domain` (json backend rooted at `~/.dsh/storages`), so a
 * plugin sees `ctx.storageDomain`. The `dsh_fork` domain stores one
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

/** Durable declaration of the dsh-fork branch registry domain. */
export const dshForkDomainSpec = defineDomain({
  name: 'dsh_fork',
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
  }
  close(): Promise<void>
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
