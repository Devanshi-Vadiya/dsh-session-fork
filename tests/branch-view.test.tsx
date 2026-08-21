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

import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { BranchGraphView } from '../src/client/BranchGraphView.tsx'
import {
  rowLaneColor,
  type GraphPayloadDto,
  type GraphRpcResult,
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

const NO_DANGLING: Promise<GraphRpcResult<readonly string[]>> =
  Promise.resolve({ ok: true, value: [] })

const NO_EVENTS: Promise<GraphRpcResult<TurnEventsPayloadDto>> =
  Promise.resolve({ ok: true, value: { events: [] } })

function mount(
  loadGraph: ViewProps['loadGraph'],
  loadDangling: ViewProps['loadDangling'] = () => NO_DANGLING,
  loadTurnEvents: ViewProps['loadTurnEvents'] = () => NO_EVENTS,
): Mounted {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  const props = {
    sessionId: 's-view', loadGraph, loadDangling, loadTurnEvents, t,
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
      () => Promise.resolve({ ok: true, value: ['ghost', 'wip'] }),
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
      () => NO_DANGLING,
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
      () => NO_DANGLING,
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
      () => NO_DANGLING,
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
