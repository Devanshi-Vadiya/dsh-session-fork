/**
 * Tests for the agent-facing tool surface (issue #5): argument schemas,
 * caller resolution, delegation into the real executor cores, and result
 * translation — over fake ports (no cordis, no dsh services).
 * @module dsh-session-fork/tests/tools.test
 */

import { describe, expect, test } from 'bun:test'
import { branchToolDefinitions, commandResultToToolValue } from '../src/tools.js'
import type { BranchToolPorts } from '../src/tools.js'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

const LOG: readonly string[] = [
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
]

function sessionOf(id: string): SourceSessionView {
  let turn = 0
  const events: SourceEvent[] = LOG.map((type, seq) => {
    if (type === 'turn/start') turn += 1
    return type === 'turn/end' ? { seq, type, data: { turn } } : { seq, type }
  })
  return { id, events, header: { cwd: '/w' } }
}

/** In-memory store with restart semantics. */
function memoryStore(): RegistryStore & { dump(): RegistryState | null } {
  let stored: RegistryState | null = null
  return {
    async load() {
      return stored === null ? null : (JSON.parse(JSON.stringify(stored)) as RegistryState)
    },
    async save(state: RegistryState) {
      stored = JSON.parse(JSON.stringify(state)) as RegistryState
    },
    dump() {
      return stored
    },
  }
}

/** Minimal exec-context stand-in: the tool's view of one calling agent. */
function execOf(agent?: { session: { id: string; header: { cwd?: string } } }): {
  agent?: { session: { id: string; header: { cwd?: string } } }
  signal: AbortSignal
} {
  return {
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  }
}

interface Harness {
  readonly ports: BranchToolPorts
  readonly commandCalls: Array<{ sessionId: string; workspaceKey: string }>
  readonly branchLookups: string[]
  readonly resolvedSources: string[]
  readonly children: string[]
  readonly renames: Array<{ sessionId: string; title: string }>
  readonly store: ReturnType<typeof memoryStore>
}

/**
 * Fake ports with REAL executor deps for the registry operations: the
 * `command` factory returns the same deps shape tests/command.test.ts
 * builds, so branch_list/create/adopt run through the genuine core.
 */
function harness(seedState: RegistryState | null = null): Harness {
  const store = memoryStore()
  if (seedState !== null) void store.save(seedState)
  const commandCalls: Harness['commandCalls'] = []
  const branchLookups: Harness['branchLookups'] = []
  const resolvedSources: Harness['resolvedSources'] = []
  const children: string[] = []
  const renames: Harness['renames'] = []
  return {
    store,
    commandCalls,
    branchLookups,
    resolvedSources,
    children,
    renames,
    ports: {
      command(sessionId, workspaceKey) {
        commandCalls.push({ sessionId, workspaceKey })
        return {
          currentSessionId: sessionId,
          store,
          sessionExists: (id: string) => id !== 's-gone',
          ports: {
            async readSession(sessionId) {
              return sessionId === 's-parent' ? sessionOf('s-parent') : sessionId === 's-cold'
                ? sessionOf('s-cold')
                : null
            },
            async createChildFromSeed(childId) {
              children.push(childId)
            },
            async renameSession(sessionId, title) {
              renames.push({ sessionId, title })
            },
          },
        }
      },
      async branchSessionId(_workspaceKey, name) {
        branchLookups.push(name)
        const state = await store.load()
        return state?.branches[name]?.sessionId ?? null
      },
      async resolveSourceAgent(sessionId) {
        resolvedSources.push(sessionId)
        return null
      },
      squashBase() {
        throw new Error('squashBase not reached by the registry-operation tools')
      },
      rebasedBase() {
        throw new Error('rebasedBase not reached by the registry-operation tools')
      },
      trackDetached() {
        throw new Error('trackDetached not reached by the registry-operation tools')
      },
    },
  }
}

/** The calling agent's session, tool-side. */
const CALLER = { session: { id: 's-parent', header: { cwd: '/w' } } }

const toolBy = (defs: ReturnType<typeof branchToolDefinitions>, name: string) => {
  const found = defs.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`tool ${name} not defined`)
  return found
}

describe('tool surface shape', () => {
  const h = harness()
  const defs = branchToolDefinitions(h.ports)

  test('one definition per registry operation, unique names', () => {
    const names = defs.map(tool => tool.name)
    expect(names).toEqual(['branch_list', 'branch_create', 'branch_adopt', 'branch_rename', 'branch_remove'])
    expect(new Set(names).size).toBe(names.length)
  })

  test('descriptions and mandatory output schemas are present', () => {
    for (const tool of defs) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })
})

describe('commandResultToToolValue', () => {
  test('success maps ok with text, defaulting to ok', () => {
    expect(commandResultToToolValue({ kind: 'success', text: 'done' })).toEqual({ ok: true, message: 'done' })
    expect(commandResultToToolValue({ kind: 'success' })).toEqual({ ok: true, message: 'ok' })
  })

  test('error maps not-ok with the executor text verbatim', () => {
    expect(commandResultToToolValue({ kind: 'error', text: 'nope' })).toEqual({ ok: false, message: 'nope' })
  })
})

describe('caller resolution', () => {
  const h = harness()
  const defs = branchToolDefinitions(h.ports)

  test('without a calling agent every tool refuses canonically', async () => {
    const value = await toolBy(defs, 'branch_list').execute({}, execOf() as never)
    expect(value).toEqual({ ok: false, message: 'no calling agent: this tool runs only inside an agent session' })
  })

  test('the caller\'s session id and workspace cwd reach the command deps', async () => {
    const value = await toolBy(defs, 'branch_list').execute({}, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('No branches') })
    expect(h.commandCalls).toEqual([{ sessionId: 's-parent', workspaceKey: '/w' }])
  })
})

describe('branch_create / branch_adopt', () => {
  test('create forks the calling session through the real core', async () => {
    const h = harness()
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_create').execute({ name: 'review' }, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review') })
    expect(h.children.length).toBe(1)
    expect(h.renames).toEqual([{ sessionId: h.children[0]!, title: 'review' }])
    expect(h.store.dump()?.branches['review']).toBeDefined()
  })

  test('adopt registers the calling session as a root branch', async () => {
    const h = harness()
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_adopt').execute({ name: 'main' }, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('main') })
    expect(h.store.dump()?.branches['main']?.sessionId).toBe('s-parent')
    expect(h.renames).toEqual([{ sessionId: 's-parent', title: 'main' }])
  })

  test('create with a duplicate name surfaces the executor error text', async () => {
    const h = harness({ branches: { review: {
      name: 'review',
      sessionId: 's-existing',
      forkOrigin: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    } } })
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_create').execute({ name: 'review' }, execOf(CALLER) as never)
    expect(value).toEqual({
      ok: false,
      message: expect.stringContaining('already exists'),
    })
    expect(h.children.length).toBe(0)
  })
})

describe('branch_rename / branch_remove', () => {
  const seeded = (): RegistryState => ({
    branches: {
      main: { name: 'main', sessionId: 's-parent', forkOrigin: null, createdAt: '2026-01-01T00:00:00.000Z' },
      review: {
        name: 'review',
        sessionId: 's-review',
        forkOrigin: { parentSessionId: 's-parent', atSeq: 7 },
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    },
  })

  test('rename rewrites the registry key through the real core', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_rename').execute(
      { from: 'review', to: 'review-2' },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review-2') })
    const branches = h.store.dump()?.branches ?? {}
    expect(branches['review']).toBeUndefined()
    expect(branches['review-2']?.sessionId).toBe('s-review')
  })

  test('remove without confirm refuses with zero side effects', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_remove').execute(
      { name: 'review', confirm: false },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({
      ok: false,
      message: expect.stringContaining('confirm=true'),
    })
    expect(h.store.dump()?.branches['review']).toBeDefined()
    expect(h.commandCalls.length).toBe(0)
  })

  test('remove with confirm drops only the registry record', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_remove').execute(
      { name: 'review', confirm: true },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review') })
    expect(h.store.dump()?.branches['review']).toBeUndefined()
    expect(h.store.dump()?.branches['main']).toBeDefined()
  })
})
