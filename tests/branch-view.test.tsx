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
import { rowLaneColor, type GraphPayloadDto, type GraphRpcResult } from '../src/client/graph-model.ts'
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

function mount(
  loadGraph: ViewProps['loadGraph'],
  loadDangling: ViewProps['loadDangling'] = () => NO_DANGLING,
): Mounted {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  const props = { sessionId: 's-view', loadGraph, loadDangling, t } as unknown as ViewProps
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
    // The label carries the full text for the CSS tooltip.
    const label = mounted.container.querySelector('[data-full="second turn"]')
    expect(label).not.toBeNull()
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

  test('the label ellipsizes and the tooltip fades in', () => {
    expect(css).toContain('text-overflow: ellipsis')
    expect(css).toContain('content: attr(data-full)')
    expect(css).toMatch(/transition: opacity/)
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
