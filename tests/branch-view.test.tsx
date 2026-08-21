/**
 * Component tests for the branches graph view (P4 polish): the three load
 * states over a fake loadGraph, retry behavior, pill dots, and the CSS
 * source contract (ellipsis, palette variables, dark-theme override).
 *
 * Runtime note: bun resolves `.module.css` imports to an empty object in
 * the test runtime (hashing happens only at bundle time), so class-name
 * assertions live on the CSS source text instead of the DOM; DOM
 * assertions ride on text content, element shape, and the unhashed
 * `svg.graph` class the vendored renderer stamps in JavaScript.
 * @module dsh-session-fork/tests/branch-view.test
 */

import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { BranchGraphView } from '../src/client/BranchGraphView.tsx'
import {
  rowLaneColor,
  type GraphPayloadDto,
  type GraphRpcResult,
  type RegistryBranchDto,
  type TurnEventsPayloadDto,
} from '../src/client/graph-model.ts'
import { toISCMHistoryItemViewModelArray } from '../src/client/vendor/vscode/scm-history.ts'
import type { ISCMHistoryItemViewModel } from '../src/client/vendor/vscode/types.ts'

type ViewProps = Parameters<typeof BranchGraphView>[0]
/** Dictionary keys render as #key so assertions stay locale-independent. */
const t = (key: string): string => `#${key}`

let window: Window

beforeAll(() => {
  window = new Window()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = window
  globals.document = window.document
  globals.navigator = window.navigator
  globals.IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.IS_REACT_ACT_ENVIRONMENT = false
  globals.document = undefined
  globals.window = undefined
  window.close()
})

interface Mounted {
  readonly root: Root
  readonly container: HTMLElement
}

const NO_BRANCHES: Promise<GraphRpcResult<readonly RegistryBranchDto[]>> =
  Promise.resolve({ ok: true, value: [] })

const NO_EVENTS: Promise<GraphRpcResult<TurnEventsPayloadDto>> =
  Promise.resolve({ ok: true, value: { events: [] } })

const NO_FORK: Promise<GraphRpcResult<{ readonly sessionId: string }>> = Promise.resolve({
  ok: false,
  error: { code: 'internal', message: 'unused' },
})

const NO_SQUASH: Promise<GraphRpcResult<{ readonly message: string }>> = Promise.resolve({
  ok: false,
  error: { code: 'internal', message: 'unused' },
})

const SILENT_DIALOG: ViewProps['requestBranchName'] = () => Promise.resolve(undefined)

function mount(
  loadGraph: ViewProps['loadGraph'],
  loadBranches: ViewProps['loadBranches'] = () => NO_BRANCHES,
  loadTurnEvents: ViewProps['loadTurnEvents'] = () => NO_EVENTS,
  createBranch: ViewProps['createBranch'] = () => NO_FORK,
  requestBranchName: ViewProps['requestBranchName'] = SILENT_DIALOG,
  squashBranch: ViewProps['squashBranch'] = () => NO_SQUASH,
): Mounted {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  const props = {
    sessionId: 's-view', loadGraph, loadBranches, loadTurnEvents, createBranch, requestBranchName, squashBranch, t,
  } as unknown as ViewProps
  act(() => { root.render(<BranchGraphView {...props} />) })
  return { root, container }
}

/** Flush pending promise callbacks inside act. */
async function flush(): Promise<void> {
  await act(async () => {})
}

function resultOf(value: GraphPayloadDto): GraphRpcResult<GraphPayloadDto> {
  return { ok: true, value }
}

const TWO_BRANCH_GRAPH: GraphPayloadDto = {
  nodes: [
    { id: 's-b:2', parentIds: ['s-b:1'], subject: 'second turn', refs: [{ id: 'exp', name: 'exp' }] },
    { id: 's-b:1', parentIds: ['s-a:1'], subject: 'first turn' },
    { id: 's-a:1', parentIds: [], subject: 'root turn' },
  ],
  head: 's-b:2',
}

describe('BranchGraphView states', () => {
  test('loading state shows the skeleton while the call is pending', async () => {
    const mounted = mount(() => new Promise(() => {}))
    expect(mounted.container.textContent).toContain('#state.loading')
    await act(async () => { mounted.root.unmount() })
  })

  test('error state shows the message and a retry button that re-calls loadGraph', async () => {
    let calls = 0
    const mounted = mount((): Promise<GraphRpcResult<GraphPayloadDto>> => {
      calls += 1
      return Promise.resolve({ ok: false, error: { code: 'internal', message: 'boom' } })
    })
    await flush()
    expect(mounted.container.textContent).toContain('#state.error')
    expect(mounted.container.textContent).toContain('boom')
    const retry = mounted.container.querySelector('button')
    expect(retry?.textContent).toContain('#state.retry')
    await act(async () => { retry?.click() })
    await flush()
    expect(calls).toBe(2)
    await act(async () => { mounted.root.unmount() })
  })

  test('ready state renders one svg row per node with the solid lane-color ref badge', async () => {
    const mounted = mount(() => Promise.resolve(resultOf(TWO_BRANCH_GRAPH)))
    await flush()
    const rows = mounted.container.querySelectorAll('svg.graph')
    expect(rows).toHaveLength(3)
    for (const subject of ['second turn', 'first turn', 'root turn']) {
      expect(mounted.container.textContent).toContain(subject)
    }
    // The vscode-style badge: name text plus an icon inside a span whose
    // BACKGROUND is filled by a lane-palette variable (solid color chip).
    expect(mounted.container.textContent).toContain('exp')
    const badges = [...mounted.container.querySelectorAll('span')]
      .filter(span => (span as HTMLElement).style.backgroundColor.includes('--dsh-fork-graph'))
    expect(badges).toHaveLength(1)
    // The badge carries the branch icon (official IconBranchOutline16).
    expect(badges[0]?.querySelector('svg')).not.toBeNull()
    // The label spans render as the official Tooltip primitive's anchors
    // (issue #8): no data-full CSS-tooltip residue anywhere.
    const label = [...mounted.container.querySelectorAll('span')]
      .find(span => span.textContent === 'second turn')
    expect(label).toBeDefined()
    expect(mounted.container.querySelector('[data-full]')).toBeNull()
    await act(async () => { mounted.root.unmount() })
  })

  test('empty graph shows the guidance state', async () => {
    const mounted = mount(() => Promise.resolve(resultOf({ nodes: [], head: null })))
    await flush()
    expect(mounted.container.textContent).toContain('#state.empty')
    await act(async () => { mounted.root.unmount() })
  })

  test('dangling branches render as a distinct demoted section', async () => {
    const mounted = mount(
      () => Promise.resolve(resultOf({ nodes: [], head: null })),
      () => Promise.resolve({
        ok: true,
        value: [
          { name: 'ghost', sessionId: 's-1', dangling: true },
          { name: 'wip', sessionId: 's-2', dangling: true },
        ] as readonly RegistryBranchDto[],
      }),
    )
    await flush()
    expect(mounted.container.textContent).toContain('#state.dangling')
    expect(mounted.container.textContent).toContain('ghost')
    expect(mounted.container.textContent).toContain('wip')
    // A dangling-only workspace is not the empty state.
    expect(mounted.container.textContent).not.toContain('#state.empty')
    await act(async () => { mounted.root.unmount() })
  })

  test('a failing dangling call never takes the graph down', async () => {
    const mounted = mount(
      () => Promise.resolve(resultOf(TWO_BRANCH_GRAPH)),
      () => Promise.reject(new Error('registry blew up')),
    )
    await flush()
    expect(mounted.container.querySelectorAll('svg.graph')).toHaveLength(3)
    expect(mounted.container.textContent).not.toContain('#state.dangling')
    await act(async () => { mounted.root.unmount() })
  })
})

describe('row expansion (issue #8)', () => {
  /** Payload whose rows carry the issue-#8 data-plane metadata. */
  const EXPANDABLE_GRAPH: GraphPayloadDto = {
    nodes: [
      {
        id: 's-a:2', parentIds: ['s-a:1'], subject: 'asked for a listing',
        sessionId: 's-a', turn: 2, endSeq: 9,
      },
      { id: 's-a:1', parentIds: [], subject: 'root turn', sessionId: 's-a', turn: 1, endSeq: 3 },
    ],
    head: 's-a:2',
  }
  const EVENTS: TurnEventsPayloadDto = {
    events: [
      { seq: 4, type: 'turn/start', text: 'turn/start' },
      { seq: 5, type: 'user/message', text: 'list the files' },
      { seq: 6, type: 'tool/call', text: 'tool bash: {"command":"ls"}' },
      { seq: 9, type: 'turn/end', text: 'turn/end' },
    ],
  }

  /** The expandable row element (meta-carrying rows are role=button). */
  function expandableRow(mounted: Mounted, id: string): HTMLElement {
    const rows = [...mounted.container.querySelectorAll('[role="button"]')]
    const row = rows.find(element => element.textContent?.includes(
      EXPANDABLE_GRAPH.nodes.find(node => node.id === id)!.subject))
    if (row === undefined) throw new Error(`row ${id} not found`)
    return row as HTMLElement
  }

  test('clicking a row loads its turn events and renders lightweight lines', async () => {
    const calls: Array<{ sessionId: string, turn: number }> = []
    const mounted = mount(
      () => Promise.resolve(resultOf(EXPANDABLE_GRAPH)),
      () => NO_BRANCHES,
      (sessionId, turn) => {
        calls.push({ sessionId, turn })
        return Promise.resolve({ ok: true, value: EVENTS })
      },
    )
    await flush()
    await act(async () => { expandableRow(mounted, 's-a:2').click() })
    await flush()
    expect(calls).toEqual([{ sessionId: 's-a', turn: 2 }])
    for (const text of ['list the files', 'tool bash: {"command":"ls"}']) {
      expect(mounted.container.textContent).toContain(text)
    }
    // Type badges ride along, one per event line.
    const badges = [...mounted.container.querySelectorAll('[data-event-type]')]
    expect(badges.map(badge => badge.textContent)).toEqual([
      'turn/start', 'user/message', 'tool/call', 'turn/end',
    ])
    // Full summary text rides the official Tooltip primitive (no title
    // attribute fallback anymore, issue #8).
    const toolLine = [...mounted.container.querySelectorAll('span')]
      .find(span => span.textContent === 'tool bash: {"command":"ls"}')
    expect(toolLine).toBeDefined()
    expect(mounted.container.querySelector('[title]')).toBeNull()
    await act(async () => { mounted.root.unmount() })
  })

  test('a second click collapses; the cached events survive without a re-fetch', async () => {
    let calls = 0
    const mounted = mount(
      () => Promise.resolve(resultOf(EXPANDABLE_GRAPH)),
      () => NO_BRANCHES,
      () => {
        calls += 1
        return Promise.resolve({ ok: true, value: EVENTS })
      },
    )
    await flush()
    const row = expandableRow(mounted, 's-a:2')
    await act(async () => { row.click() })
    await flush()
    expect(calls).toBe(1)
    await act(async () => { row.click() })
    await flush()
    expect(calls).toBe(1)
    expect(mounted.container.textContent).not.toContain('list the files')
    // Re-expanding is instant and reuses the cache (still one fetch).
    await act(async () => { row.click() })
    await flush()
    expect(calls).toBe(1)
    expect(mounted.container.textContent).toContain('list the files')
    await act(async () => { mounted.root.unmount() })
  })

  test('a failing event fetch renders the error line inside the expansion', async () => {
    const mounted = mount(
      () => Promise.resolve(resultOf(EXPANDABLE_GRAPH)),
      () => NO_BRANCHES,
      () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'no turn 2' } }),
    )
    await flush()
    await act(async () => { expandableRow(mounted, 's-a:2').click() })
    await flush()
    expect(mounted.container.textContent).toContain('#events.error')
    expect(mounted.container.textContent).toContain('no turn 2')
    await act(async () => { mounted.root.unmount() })
  })

  test('rows without issue-#8 metadata stay plain (not expandable)', async () => {
    const mounted = mount(() => Promise.resolve(resultOf(TWO_BRANCH_GRAPH)))
    await flush()
    expect(mounted.container.querySelectorAll('[role="button"]')).toHaveLength(0)
    expect(mounted.container.querySelectorAll('[aria-expanded]')).toHaveLength(0)
    await act(async () => { mounted.root.unmount() })
  })

  test('the expansion subtree is indented to the label column (CSS contract)', () => {
    const source = readFileSync(
      new URL('../src/client/BranchGraphView.module.css', import.meta.url), 'utf8')
    expect(source).toContain('.events')
    expect(source).toContain('text-overflow: ellipsis')
    expect(source).toContain('.eventType')
  })
})

describe('row context menu + fork from here (issue #8)', () => {
  const EXPANDABLE_GRAPH2: GraphPayloadDto = {
    nodes: [
      {
        id: 's-a:2', parentIds: ['s-a:1'], subject: 'asked for a listing',
        sessionId: 's-a', turn: 2, endSeq: 9,
      },
      { id: 's-a:1', parentIds: [], subject: 'root turn', sessionId: 's-a', turn: 1, endSeq: 3 },
    ],
    head: 's-a:2',
  }

  /** Fire a right-click on the row showing `subject`. */
  function contextMenuOn(mounted: Mounted, subject: string): void {
    const row = [...mounted.container.querySelectorAll('[role="button"]')]
      .find(element => element.textContent?.includes(subject))
    if (row === undefined) throw new Error(`row with "${subject}" not found`)
    act(() => {
      row.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 40, clientY: 60,
      }))
    })
  }

  test('right-click opens the menu at the pointer; squash stays disabled without lineage', async () => {
    const mounted = mount(() => Promise.resolve(resultOf(EXPANDABLE_GRAPH2)))
    await flush()
    expect(mounted.container.querySelector('[role="menu"]')).toBeNull()
    contextMenuOn(mounted, 'asked for a listing')
    const menu = mounted.container.querySelector('[role="menu"]') ?? window.document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const items = [...(menu as HTMLElement).querySelectorAll('[role="menuitem"]')]
    expect(items.map(item => item.textContent)).toEqual(['#menu.fork', '#menu.squash'])
    expect((items[1] as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { mounted.root.unmount() })
  })

  test('Fork from here: dialog texts, client gate, fork at endSeq, refresh + toast', async () => {
    let graphCalls = 0
    const forkCalls: Array<{ name: string, sessionId: string, atSeq?: number }> = []
    const dialogTextsSeen: unknown[] = []
    const requestBranchName: ViewProps['requestBranchName'] = async (submit, texts) => {
      dialogTextsSeen.push(texts)
      const first = await submit(' spaced ')
      if (first.ok) return { sessionId: first.sessionId }
      const second = await submit('experiment')
      return second.ok ? { sessionId: second.sessionId } : undefined
    }
    const mounted = mount(
      () => {
        graphCalls += 1
        return Promise.resolve(resultOf(EXPANDABLE_GRAPH2))
      },
      () => NO_BRANCHES,
      () => NO_EVENTS,
      async (request) => {
        if (request.name !== 'experiment') {
          return { ok: false, error: { code: 'internal', message: 'unreachable' } }
        }
        forkCalls.push(request)
        return { ok: true, value: { sessionId: 's-child-new' } }
      },
      requestBranchName,
    )
    await flush()
    contextMenuOn(mounted, 'asked for a listing')
    const item = [...window.document.querySelectorAll('[role="menuitem"]')]
      .find(element => element.textContent === '#menu.fork')
    await act(async () => { item?.click() })
    await flush()
    await flush()
    expect(forkCalls).toEqual([{ name: 'experiment', sessionId: 's-a', atSeq: 9 }])
    // Success refreshed the graph (initial load + post-fork reload).
    expect(graphCalls).toBe(2)
    // The toast announces the created branch (body portal — fixed banner).
    expect(window.document.body.textContent).toContain('#toast.forkedexperiment')
    await act(async () => { mounted.root.unmount() })
  })

  test('dialog rejection (invalid name) surfaces through the dialog bridge, no fork, no toast', async () => {
    const submissions: string[] = []
    const requestBranchName: ViewProps['requestBranchName'] = async (submit) => {
      const outcome = await submit(' spaced ')
      submissions.push(outcome.ok ? 'ok' : 'rejected')
      return undefined
    }
    let forkCalls = 0
    const mounted = mount(
      () => Promise.resolve(resultOf(EXPANDABLE_GRAPH2)),
      () => NO_BRANCHES,
      () => NO_EVENTS,
      async () => {
        forkCalls += 1
        return { ok: true, value: { sessionId: 'x' } }
      },
      requestBranchName,
    )
    await flush()
    contextMenuOn(mounted, 'asked for a listing')
    const item = [...window.document.querySelectorAll('[role="menuitem"]')]
      .find(element => element.textContent === '#menu.fork')
    await act(async () => { item?.click() })
    await flush()
    expect(submissions).toEqual(['rejected'])
    expect(forkCalls).toBe(0)
    expect(window.document.body.textContent).not.toContain('#toast.forked')
    await act(async () => { mounted.root.unmount() })
  })
})

describe('rowLaneColor', () => {
  function viewModelsOf(): ISCMHistoryItemViewModel[] {
    const items = TWO_BRANCH_GRAPH.nodes.map(node => ({
      id: node.id,
      parentIds: [...node.parentIds],
      subject: node.subject,
      message: node.subject,
      ...(node.refs === undefined ? {} : { references: node.refs.map(ref => ({ id: ref.id, name: ref.name })) }),
    }))
    return toISCMHistoryItemViewModelArray(items, undefined, { id: 'HEAD', name: 'HEAD', revision: 's-b:2' })
  }

  test('mirrors the renderer circle color pick (output lane first, then input)', () => {
    const rows = viewModelsOf()
    // Newest row: input lane holds s-b:2, its output lane 0 carries the
    // first parent — the palette first color.
    expect(rowLaneColor(rows[0]!)).toBe('scmGraph.foreground1')
  })

  test('falls back to undefined when neither lane covers the circle index', () => {
    const rows = viewModelsOf()
    const root = rows.find(row => row.historyItem.id === 's-a:1')
    expect(root).toBeDefined()
    // The root's input lane exists (it was seeded forward), so a color is
    // present — the no-lane branch needs a node outside every lane.
    const bare: ISCMHistoryItemViewModel = {
      historyItem: { id: 'x', parentIds: [], subject: '', message: '' },
      inputSwimlanes: [],
      outputSwimlanes: [],
      kind: 'node',
    }
    expect(rowLaneColor(bare)).toBeUndefined()
  })
})

describe('BranchGraphView CSS contract (source text)', () => {
  const css = readFileSync(new URL('../src/client/BranchGraphView.module.css', import.meta.url), 'utf8')

  test('defines the five-lane palette plus the ref colors', () => {
    for (const name of [
      '--dsh-fork-graph-1', '--dsh-fork-graph-2', '--dsh-fork-graph-3',
      '--dsh-fork-graph-4', '--dsh-fork-graph-5', '--dsh-fork-graph-ref',
    ]) {
      expect(css).toContain(`${name}: #`)
    }
  })

  test('lifts the palette for the dark theme', () => {
    expect(css).toContain('body[data-ds-dark-theme] .graph')
    expect(css.match(/--dsh-fork-graph-3: #d9944d/)).not.toBeNull()
  })

  test('the label ellipsizes; full text went to the official Tooltip primitive', () => {
    expect(css).toContain('text-overflow: ellipsis')
    // The CSS attr() bubble is gone (issue #8 replaced it with Tooltip).
    expect(css).not.toContain('content: attr(data-full)')
    expect(css).not.toContain('.label::after')
  })

  test('rows hover, the HEAD row is the current treatment, and badges are solid vscode chips', () => {
    expect(css).toContain('.historyItem:hover')
    // Trajectory-tab alignment: xs-13 token + secondary label color, and
    // the interactive hover alias.
    expect(css).toContain('font: var(--dsw-font-xs-13)')
    expect(css).toContain('color: var(--dsw-alias-label-secondary)')
    expect(css).toContain('interactive-bg-hover')
    expect(css).toContain('.current .label')
    expect(css).toContain('dsw-font-xs-strong-13')
    // vscode badge recipe: 10px radius, no border, ref name ellipsized.
    expect(css).toContain('border-radius: 10px')
    expect(css).toContain('.refName')
    expect(css).not.toContain('refDot')
    expect(css).toContain('.skeletonRow')
    expect(css).toContain('@keyframes skeleton-pulse')
    // Trajectory row rhythm: 38px rows and skeleton.
    expect(css).toContain('min-height: 38px')
    expect(css).toContain('height: 38px')
  })

  test('the dangling section is dashed and demoted, not hidden', () => {
    expect(css).toContain('.danglingSection')
    expect(css).toContain('.danglingRef')
    expect(css).toContain('1px dashed')
    expect(css).toContain('opacity: 0.7')
  })
})

describe('squash into branch (issue #8)', () => {
  // Portal-level assertions need a clean body: earlier tests' containers
  // (and any toast they left mid-fade) stay in this shared happy-dom body.
  beforeEach(() => {
    window.document.body.replaceChildren()
  })

  /** Root rows (s-a) and forked-child rows (s-b) in one graph. */
  const LINEAGE_GRAPH: GraphPayloadDto = {
    nodes: [
      {
        id: 's-b:1', parentIds: ['s-a:2'], subject: 'experiment turn',
        sessionId: 's-b', turn: 1, endSeq: 12,
      },
      { id: 's-a:2', parentIds: ['s-a:1'], subject: 'root second', sessionId: 's-a', turn: 2, endSeq: 9 },
      { id: 's-a:1', parentIds: [], subject: 'root first', sessionId: 's-a', turn: 1, endSeq: 3 },
    ],
    head: 's-b:1',
  }

  const LINEAGE_BRANCHES: readonly RegistryBranchDto[] = [
    { name: 'main', sessionId: 's-a', dangling: false, forkOrigin: null },
    { name: 'exp', sessionId: 's-b', dangling: false, forkOrigin: { parentSessionId: 's-a', atSeq: 9 } },
  ]

  const LINEAGE_LOAD: ViewProps['loadBranches'] = () =>
    Promise.resolve({ ok: true, value: LINEAGE_BRANCHES })

  function contextMenuOn(mounted: Mounted, subject: string): void {
    const row = [...mounted.container.querySelectorAll('[role="button"]')]
      .find(element => element.textContent?.includes(subject))
    if (row === undefined) throw new Error(`row with "${subject}" not found`)
    act(() => {
      row.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 20,
      }))
    })
  }

  function menuItems(): HTMLButtonElement[] {
    return [...window.document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
  }

  test('squash is enabled on forked-session rows and disabled on root rows', async () => {
    const mounted = mount(
      () => Promise.resolve(resultOf(LINEAGE_GRAPH)),
      LINEAGE_LOAD,
    )
    await flush()
    contextMenuOn(mounted, 'experiment turn')
    const squashChild = menuItems()[1]
    expect(squashChild?.disabled).toBe(false)
    await act(async () => { mounted.root.unmount() })

    const mountedRoot = mount(
      () => Promise.resolve(resultOf(LINEAGE_GRAPH)),
      LINEAGE_LOAD,
    )
    await flush()
    contextMenuOn(mountedRoot, 'root second')
    const squashRoot = menuItems()[1]
    expect(squashRoot?.disabled).toBe(true)
    await act(async () => { mountedRoot.root.unmount() })
  })

  test('squash flow: dialog texts name the parent, target goes to the wire, refresh + toast', async () => {
    let graphCalls = 0
    const squashCalls: Array<{ sessionId: string, target: string }> = []
    const textsSeen: unknown[] = []
    const requestBranchName: ViewProps['requestBranchName'] = async (submit, texts) => {
      textsSeen.push(texts)
      const outcome = await submit('main')
      return outcome.ok ? { sessionId: outcome.sessionId } : undefined
    }
    const mounted = mount(
      () => {
        graphCalls += 1
        return Promise.resolve(resultOf(LINEAGE_GRAPH))
      },
      LINEAGE_LOAD,
      () => NO_EVENTS,
      () => NO_FORK,
      requestBranchName,
      async (request) => {
        squashCalls.push({ sessionId: request.sessionId, target: request.target })
        return { ok: true, value: { message: 'Squashed 2 surface nodes into branch \'main\'.' } }
      },
    )
    await flush()
    contextMenuOn(mounted, 'experiment turn')
    await act(async () => { menuItems()[1]?.click() })
    await flush()
    await flush()
    expect(squashCalls).toEqual([{ sessionId: 's-b', target: 'main' }])
    expect(textsSeen[0]).toMatchObject({
      title: '#squash.title',
      placeholder: '#squash.placeholdermain',
      confirm: '#squash.confirm',
    })
    expect(graphCalls).toBe(2)
    expect(window.document.body.textContent).toContain('#toast.squashedmain')
    await act(async () => { mounted.root.unmount() })
  })

  test('a host rejection surfaces through the dialog bridge: no toast, no refresh', async () => {
    let graphCalls = 0
    const requestBranchName: ViewProps['requestBranchName'] = async (submit) => {
      const outcome = await submit('other')
      return outcome.ok ? { sessionId: outcome.sessionId } : undefined
    }
    const mounted = mount(
      () => {
        graphCalls += 1
        return Promise.resolve(resultOf(LINEAGE_GRAPH))
      },
      LINEAGE_LOAD,
      () => NO_EVENTS,
      () => NO_FORK,
      requestBranchName,
      async () => ({
        ok: false,
        error: { code: 'internal', message: "branch 'other' is not this session's parent" },
      }),
    )
    await flush()
    contextMenuOn(mounted, 'experiment turn')
    await act(async () => { menuItems()[1]?.click() })
    await flush()
    expect(graphCalls).toBe(1)
    expect(window.document.body.textContent).not.toContain('#toast.squashed')
    await act(async () => { mounted.root.unmount() })
  })
})
