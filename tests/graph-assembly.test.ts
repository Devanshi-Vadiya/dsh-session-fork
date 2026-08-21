/**
 * Tests for host-side graph assembly: turn extraction over session-event
 * shapes, the registry→node graph builder (lineage, refs, head, ordering,
 * degradation), and the 'graph' RPC endpoint end-to-end over fake ports.
 * @module dsh-session-fork/tests/graph-assembly.test
 */

import { describe, expect, test } from 'bun:test'
import {
  assembleBranchGraph,
  extractTurns,
  type BranchLike,
  type GraphEvent,
  type GraphSessionLog,
} from '../src/graph.ts'
import { createBranchRpcHandler } from '../src/rpc.ts'
import type { BranchRpcPorts } from '../src/rpc.ts'
import type { RegistryState } from '../src/types.ts'

/** One turn spec for the fake log builder. */
interface TurnSpec {
  readonly turn: number
  /** User message text; omitted for empty turns. */
  readonly subject?: string
  /** Event time (ms) of the turn/start. */
  readonly time: number
  /** Message source kind; 'user' = direct human prompt. */
  readonly source?: 'user' | 'plugin'
}

/** Build a session-event log from turn specs (seqs contiguous from 0). */
function sessionEvents(turns: readonly TurnSpec[]): GraphEvent[] {
  const events: GraphEvent[] = []
  let seq = 0
  const push = (type: string, time: number, data: unknown): void => {
    events.push({ seq: seq++, type, time, data })
  }
  for (const spec of turns) {
    push('turn/start', spec.time, { turn: spec.turn })
    if (spec.subject !== undefined) {
      push('user/message', spec.time, {
        id: `m-${spec.turn}`,
        role: 'user',
        content: [{ type: 'text', text: spec.subject }],
        source: { kind: spec.source ?? 'user' },
      })
    }
    push('turn/end', spec.time, { turn: spec.turn, reason: { kind: 'completed' } })
  }
  return events
}

/** Seq of one turn's `turn/end` event. */
function endSeqOf(events: readonly GraphEvent[], turn: number): number {
  const found = events.find(event =>
    event.type === 'turn/end' && (event.data as { turn?: unknown }).turn === turn)
  if (found === undefined) throw new Error(`no turn/end for turn ${turn}`)
  return found.seq
}

describe('extractTurns', () => {
  test('prefers the direct human prompt over synthetic injections', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 3 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'file changed notice' }], source: { kind: 'plugin' } },
      },
      {
        seq: 2, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } },
      },
      { seq: 3, type: 'turn/end', time: 2, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 3, startSeq: 0, endSeq: 3, startTime: 1, subject: 'fix the bug' },
    ])
  })

  test('synthetic-only and quiet turns yield no rows (human prompts are the only commits)', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: '<goal_round>…' }], source: { kind: 'goal' } },
      },
      {
        seq: 2, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin' } },
      },
      { seq: 3, type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 4, type: 'turn/start', time: 3, data: { turn: 2 } },
      { seq: 5, type: 'turn/end', time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      { seq: 6, type: 'turn/start', time: 5, data: { turn: 3 } },
      {
        seq: 7, type: 'user/message', time: 5,
        data: { role: 'user', content: [{ type: 'text', text: 'real question' }], source: { kind: 'user' } },
      },
      { seq: 8, type: 'turn/end', time: 6, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events).map(turn => [turn.turn, turn.subject]))
      .toEqual([[3, 'real question']])
  })

  test('a fromSeq cutoff (seed boundary) keeps only the session\'s own turns', () => {
    const seed = sessionEvents([{ turn: 1, subject: 'seed turn', time: 1 }])
    const own = sessionEvents([{ turn: 2, subject: 'own turn', time: 2 }])
    const events = [...seed, ...own.map(event => ({ ...event, seq: event.seq + seed.length }))]
    expect(extractTurns(events, seed.length).map(turn => turn.turn)).toEqual([2])
  })

  test('user messages outside any open turn are ignored', () => {
    // A pre-turn orphan (queued or replay residue) must not leak into the
    // next turn's subject; the message-less turn yields no row at all.
    const events = [
      {
        seq: 0, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'orphan' }], source: { kind: 'user' } },
      },
      { seq: 1, type: 'turn/start', time: 2, data: { turn: 1 } },
      { seq: 2, type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([])
  })

  test('ignores null-turn brackets and never-opened trailing turns', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: null } },
      { seq: 1, type: 'turn/end', time: 1, data: { turn: null, reason: { kind: 'completed' } } },
      { seq: 2, type: 'turn/start', time: 2, data: { turn: 5 } },
    ]
    expect(extractTurns(events)).toEqual([])
  })
})

/** The canonical workspace: root session + one forked child. */
function canonicalWorkspace(): {
  readonly branches: readonly BranchLike[]
  readonly logs: ReadonlyMap<string, GraphSessionLog>
} {
  const rootEvents = sessionEvents([
    { turn: 1, subject: 'first prompt', time: 10 },
    { turn: 2, subject: 'second prompt', time: 20 },
  ])
  // The child seeds the root prefix (through turn 2's end), then works on.
  const seedLength = endSeqOf(rootEvents, 2) + 1
  const ownTurns = sessionEvents([
    { turn: 3, subject: 'experiment', time: 30 },
    { turn: 4, subject: 'keep going', time: 40 },
  ])
  const childEvents = [
    ...rootEvents,
    ...ownTurns.map(event => ({ ...event, seq: event.seq + seedLength })),
  ]
  const logs = new Map<string, GraphSessionLog>([
    ['s-root', { header: {}, events: rootEvents }],
    ['s-child', { header: { seedLength, parentSession: 's-root' }, events: childEvents }],
  ])
  return {
    branches: [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      {
        name: 'exp', sessionId: 's-child',
        forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootEvents, 2) },
      },
    ],
    logs,
  }
}

/** readSession fake over a fixed log map. */
function readerOf(logs: ReadonlyMap<string, GraphSessionLog>) {
  const reads: string[] = []
  return {
    reads,
    readSession: async (sessionId: string): Promise<GraphSessionLog | null> => {
      reads.push(sessionId)
      return logs.get(sessionId) ?? null
    },
  }
}

describe('assembleBranchGraph', () => {
  test('assembles lineage, refs, head, and newest-first order', async () => {
    const { branches, logs } = canonicalWorkspace()
    const graph = await assembleBranchGraph(branches, 's-child', readerOf(logs).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual([
      's-child:4',
      's-child:3',
      's-root:2',
      's-root:1',
    ])
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-child:4')?.parentIds).toEqual(['s-child:3'])
    // The fork link: the child's first own turn parents to the root's
    // anchor turn (the right-jump lane in the renderer).
    expect(byId.get('s-child:3')?.parentIds).toEqual(['s-root:2'])
    expect(byId.get('s-root:2')?.parentIds).toEqual(['s-root:1'])
    expect(byId.get('s-root:1')?.parentIds).toEqual([])
    // Branch-name refs land on each branch's head row.
    expect(byId.get('s-child:4')?.refs).toEqual([{ id: 'exp', name: 'exp' }])
    expect(byId.get('s-root:2')?.refs).toEqual([{ id: 'main', name: 'main' }])
    // Quiet turns carry no refs key at all.
    expect('refs' in (byId.get('s-child:3') ?? {})).toBe(false)
    expect(graph.head).toBe('s-child:4')
  })

  test('degrades by omission when a branch session is unreadable', async () => {
    const { branches, logs } = canonicalWorkspace()
    const pruned = new Map(logs)
    pruned.delete('s-child')
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(pruned).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual(['s-root:2', 's-root:1'])
    expect(graph.head).toBe('s-root:2')
  })

  test('drops the fork link when the anchor resolves outside the branch set', async () => {
    // The child's fork parent is not a registry branch.
    const { logs } = canonicalWorkspace()
    const branches: BranchLike[] = [
      { name: 'exp', sessionId: 's-child', forkOrigin: { parentSessionId: 's-root', atSeq: 2 } },
    ]
    const graph = await assembleBranchGraph(branches, 's-child', readerOf(logs).readSession)
    const first = graph.nodes.find(node => node.id === 's-child:3')
    expect(first?.parentIds).toEqual([])
  })

  test('walks an anchor landing in the parent\'s own seed up to the ancestor that owns the turn', async () => {
    // Chain A → B → C: B forked from A's turn 1; C forked from B at a seq
    // inside B's inherited A-prefix. The anchor must resolve to A's turn.
    const aEvents = sessionEvents([
      { turn: 1, subject: 'a1', time: 10 },
      { turn: 2, subject: 'a2', time: 60 },
    ])
    const bSeedLength = endSeqOf(aEvents, 1) + 1
    const bOwn = sessionEvents([{ turn: 2, subject: 'b2', time: 20 }])
    const bEvents = [...aEvents.slice(0, bSeedLength), ...bOwn.map(e => ({ ...e, seq: e.seq + bSeedLength }))]
    const cSeedLength = bEvents.length
    const cOwn = sessionEvents([{ turn: 3, subject: 'c3', time: 30 }])
    const cEvents = [...bEvents, ...cOwn.map(e => ({ ...e, seq: e.seq + cSeedLength }))]
    const logs = new Map<string, GraphSessionLog>([
      ['s-a', { header: {}, events: aEvents }],
      ['s-b', { header: { seedLength: bSeedLength, parentSession: 's-a' }, events: bEvents }],
      ['s-c', { header: { seedLength: cSeedLength, parentSession: 's-b' }, events: cEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'a', sessionId: 's-a', forkOrigin: null },
      { name: 'b', sessionId: 's-b', forkOrigin: { parentSessionId: 's-a', atSeq: endSeqOf(aEvents, 1) } },
      // C's fork anchor seq falls inside B's inherited prefix — coordinates
      // are shared, so the walk must land on A's turn 1.
      { name: 'c', sessionId: 's-c', forkOrigin: { parentSessionId: 's-b', atSeq: endSeqOf(aEvents, 1) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-c', readerOf(logs).readSession)
    const first = graph.nodes.find(node => node.id === 's-c:3')
    expect(first?.parentIds).toEqual(['s-a:1'])
  })

  test('an empty registry yields an empty graph', async () => {
    const graph = await assembleBranchGraph([], 's-any', readerOf(new Map()).readSession)
    expect(graph.nodes).toEqual([])
    expect(graph.head).toBeNull()
  })

  test('timestamp-less logs order deterministically by branch order then seq', async () => {
    // No turn/start times: every row's primary sort key falls back to 0, so
    // the tie-break decides — later-declared branch session first, then
    // higher seq within a session (still newest-first overall).
    const stripTime = (events: readonly GraphEvent[]): GraphEvent[] =>
      events.map(({ time: _time, ...rest }) => rest)
    const logs = new Map<string, GraphSessionLog>([
      ['s-a', { header: {}, events: stripTime(sessionEvents([{ turn: 1, subject: 'a1', time: 1 }])) }],
      ['s-b', { header: {}, events: stripTime(sessionEvents([{ turn: 1, subject: 'b1', time: 1 }, { turn: 2, subject: 'b2', time: 2 }])) }],
    ])
    const branches: BranchLike[] = [
      { name: 'a', sessionId: 's-a', forkOrigin: null },
      { name: 'b', sessionId: 's-b', forkOrigin: null },
    ]
    const graph = await assembleBranchGraph(branches, 's-a', readerOf(logs).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual(['s-b:2', 's-b:1', 's-a:1'])
  })
})

describe('rpc handler graph endpoint (end-to-end over fake ports)', () => {
  function handlerPorts(options: {
    readonly state: RegistryState
    readonly logs: ReadonlyMap<string, GraphSessionLog>
  }): BranchRpcPorts {
    return {
      async resolveWorkspaceKey(sessionId) {
        // The workspace resolves for every session in the fake logs.
        return options.logs.has(sessionId) ? '/work' : null
      },
      async loadRegistry() {
        return options.state
      },
      readSession: async (sessionId) => options.logs.get(sessionId) ?? null,
      sessionExists: () => true,
    }
  }

  test('serves the assembled graph for the payload session', async () => {
    const { branches, logs } = canonicalWorkspace()
    const state: RegistryState = {
      branches: Object.fromEntries(branches.map(branch => [branch.name, {
        name: branch.name,
        sessionId: branch.sessionId,
        forkOrigin: branch.forkOrigin,
        createdAt: '2026-01-01T00:00:00.000Z',
      }])),
    }
    const handler = createBranchRpcHandler(handlerPorts({ state, logs }))
    // The payload session is the child branch the user is viewing.
    const result = await handler('graph', { sessionId: 's-child' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.head).toBe('s-child:4')
    expect(result.value.nodes).toHaveLength(4)
    expect(result.value.nodes.map(node => node.subject)).toEqual([
      'keep going', 'experiment', 'second prompt', 'first prompt',
    ])
  })

  test('a missing session still folds into an internal error', async () => {
    const handler = createBranchRpcHandler(handlerPorts({ state: { branches: {} }, logs: new Map() }))
    const result = await handler('graph', { sessionId: 's-unknown' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'no session named "s-unknown" exists', details: {} },
    })
  })

  test('an empty workspace registry serves an empty graph, not an error', async () => {
    const { logs } = canonicalWorkspace()
    // The workspace resolves, but its registry was never written.
    const handler = createBranchRpcHandler(handlerPorts({ state: { branches: {} }, logs }))
    const result = await handler('graph', { sessionId: 's-root' })
    expect(result).toEqual({ ok: true, value: { nodes: [], head: null } })
  })
})
