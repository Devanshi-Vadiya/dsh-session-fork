/**
 * Tests for the vendored vscode SCM history graph core: swimlane layout,
 * HEAD/kind determination, SVG rendering (happy-dom), and vendor-integrity
 * markers. No cordis, no live dsh services; the vendored module is exercised
 * exactly as the GUI will call it.
 * @module dsh-session-fork/tests/vendor-graph.test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import {
  renderSCMHistoryItemGraph,
  SWIMLANE_HEIGHT,
  SWIMLANE_WIDTH,
  toISCMHistoryItemViewModelArray,
} from '../src/client/vendor/vscode/scm-history.ts'
import { rot } from '../src/client/vendor/vscode/shims.ts'
import type { ISCMHistoryItem, ISCMHistoryItemRef } from '../src/client/vendor/vscode/types.ts'

// The vendored palette ids, as produced by the registerColor shim.
const FG = ['scmGraph.foreground1', 'scmGraph.foreground2', 'scmGraph.foreground3', 'scmGraph.foreground4', 'scmGraph.foreground5']

/** Build one graph history item (upstream order: newest first). */
function item(id: string, parentIds: string[], references?: ISCMHistoryItemRef[]): ISCMHistoryItem {
  return {
    id,
    parentIds,
    subject: `subject ${id}`,
    message: '',
    ...(references === undefined ? {} : { references }),
  }
}

function headRef(revision: string): ISCMHistoryItemRef {
  return { id: 'branch-main', name: 'main', revision }
}

describe('shims.rot', () => {
  test('cycles modulo, including negative indices', () => {
    expect(rot(0, 5)).toBe(0)
    expect(rot(5, 5)).toBe(0)
    expect(rot(-1, 5)).toBe(4)
    expect(rot(7, 5)).toBe(2)
  })
})

describe('toISCMHistoryItemViewModelArray (swimlane layout)', () => {
  test('a linear chain stays on a single swimlane', () => {
    const vms = toISCMHistoryItemViewModelArray([
      item('c', ['b']),
      item('b', ['a']),
      item('a', []),
    ])
    expect(vms).toHaveLength(3)
    for (const vm of vms) {
      expect(vm.inputSwimlanes.length).toBeLessThanOrEqual(1)
      expect(vm.outputSwimlanes.length).toBeLessThanOrEqual(1)
    }
    // The root has no parent, so its output lane set is empty.
    expect(vms[2]!.outputSwimlanes).toEqual([])
  })

  test('a fork appends a new swimlane to the right and connects the parent chain', () => {
    // x and y both branch off b: the first child keeps b's lane, the second
    // child forces b to also appear in a new lane on the right.
    const vms = toISCMHistoryItemViewModelArray([
      item('y', ['b']),
      item('x', ['b']),
      item('b', ['a']),
      item('a', []),
    ])
    expect(vms[0]!.outputSwimlanes).toEqual([{ id: 'b', color: FG[0] }])
    expect(vms[1]!.outputSwimlanes).toEqual([
      { id: 'b', color: FG[0] },
      { id: 'b', color: FG[1] },
    ])
    // At b's row the two lanes merge back into a's single lane.
    expect(vms[2]!.outputSwimlanes).toEqual([{ id: 'a', color: FG[0] }])
    expect(vms[3]!.outputSwimlanes).toEqual([])
  })

  test('a nested fork expands the lanes again to the right', () => {
    // f branches off c, d branches off c, e branches off b: three lanes at d.
    const vms = toISCMHistoryItemViewModelArray([
      item('f', ['c']),
      item('e', ['b']),
      item('d', ['c']),
      item('c', ['b']),
      item('b', ['a']),
      item('a', []),
    ])
    expect(vms[2]!.outputSwimlanes).toEqual([
      { id: 'c', color: FG[0] },
      { id: 'b', color: FG[1] },
      { id: 'c', color: FG[2] },
    ])
  })

  test('the palette color rot cycles back to the first color', () => {
    // One node with six parents: the unprocessed-parent loop assigns
    // rot(0..5, 5) — the sixth parent wraps back to the first palette color.
    const vms = toISCMHistoryItemViewModelArray([
      item('m', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
    ])
    expect(vms[0]!.outputSwimlanes.map(node => node.color)).toEqual([
      FG[0], FG[1], FG[2], FG[3], FG[4], FG[0],
    ])
  })

  test('marks the row matching the current ref as HEAD, all others as node', () => {
    const vms = toISCMHistoryItemViewModelArray(
      [item('c', ['b']), item('b', ['a']), item('a', [])],
      undefined,
      headRef('b'),
    )
    expect(vms[0]!.kind).toBe('node')
    expect(vms[1]!.kind).toBe('HEAD')
    expect(vms[2]!.kind).toBe('node')
  })
})

describe('renderSCMHistoryItemGraph', () => {
  let window: Window

  beforeAll(() => {
    window = new Window()
    // The vendored draw helpers only touch the global `document`.
    ;(globalThis as { document?: unknown }).document = window.document
  })

  afterAll(() => {
    ;(globalThis as { document?: unknown }).document = undefined
    window.close()
  })

  function renderVms(items: ISCMHistoryItem[], head?: ISCMHistoryItemRef) {
    return toISCMHistoryItemViewModelArray(items, undefined, head)
  }

  test('a HEAD row renders the double ring (outer + inner circle)', () => {
    const vms = renderVms([item('b', ['a']), item('a', [])], headRef('b'))
    const svg = renderSCMHistoryItemGraph(vms[0]!)
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.classList.contains('graph')).toBe(true)
    const circles = svg.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    // Upstream radii: outer = CIRCLE_RADIUS + 3 = 7, inner = stroke width = 2.
    expect(circles[0]!.getAttribute('r')).toBe('7')
    expect(circles[1]!.getAttribute('r')).toBe('2')
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  test('a plain node with one parent renders a single ring', () => {
    const vms = renderVms([item('b', ['a']), item('a', [])])
    const svg = renderSCMHistoryItemGraph(vms[0]!)
    const circles = svg.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    // Upstream node radius: CIRCLE_RADIUS + 1 = 5.
    expect(circles[0]!.getAttribute('r')).toBe('5')
  })

  test('a merge node (two parents) renders the multi-parent double ring', () => {
    const vms = renderVms([item('m', ['p1', 'p2'])])
    const svg = renderSCMHistoryItemGraph(vms[0]!)
    const circles = svg.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    // Upstream radii: outer = CIRCLE_RADIUS + 2 = 6, inner = CIRCLE_RADIUS - 1 = 3.
    expect(circles[0]!.getAttribute('r')).toBe('6')
    expect(circles[1]!.getAttribute('r')).toBe('3')
  })

  test('the svg row keeps the adapted 38px row height and lane-based width', () => {
    const vms = renderVms([item('y', ['b']), item('x', ['b']), item('b', ['a']), item('a', [])])
    const svg = renderSCMHistoryItemGraph(vms[1]!)
    // [fork:adapt] lane geometry: SWIMLANE_HEIGHT 38 (trajectory-tab row
    // rhythm), SWIMLANE_WIDTH 19 (same 19/11 scale factor).
    expect(svg.style.height).toBe('38px')
    // width = SWIMLANE_WIDTH * (max(input, output, 1) + 1) = 19 * 3.
    expect(svg.style.width).toBe('57px')
  })

  test('the fork lane merge renders arc-segmented paths', () => {
    // Two children of b (y keeps b's lane, x spawns the right lane); at b's
    // row the spawned lane curves back into the circle's lane — a visual
    // path only the arc ('A ') command family can draw.
    const vms = renderVms([item('y', ['b']), item('x', ['b']), item('b', ['a']), item('a', [])])
    const svg = renderSCMHistoryItemGraph(vms[2]!)
    const arcPaths = [...svg.querySelectorAll('path')]
      .filter(path => (path.getAttribute('d') ?? '').includes('A '))
    expect(arcPaths.length).toBeGreaterThan(0)
  })
})

describe('vendor marker integrity', () => {
  const source = readFileSync(new URL('../src/client/vendor/vscode/scm-history.ts', import.meta.url), 'utf8')
  // Only inline code-comment markers count; the file-header policy blurb
  // mentions the markers by name and must not (mirrors tests/vendor.test.ts).
  const markers = (kind: string): number =>
    source.match(new RegExp(`^\\s*// \\[fork:${kind}\\]`, 'gm'))?.length ?? 0

  test('records the upstream vscode commit SHA in the VENDORED FROM header', () => {
    expect(source).toContain('611c5dfed2fb34ec3e5619bb6e77fdbd1e9d9541')
    expect(source).toContain('microsoft/vscode')
    expect(source).toContain('Copyright (c) Microsoft Corporation')
    expect(source).toContain('MIT License')
  })

  test('exactly two [fork:adapt] markers (import block + lane constants) and zero [fork:surgery]', () => {
    expect(markers('adapt')).toBe(2)
    expect(markers('surgery')).toBe(0)
  })

  test('the lane constants carry the adapted 19/11-scaled values', () => {
    // [fork:adapt] geometry: upstream 22/11 scaled by 19/11 to the
    // trajectory-tab row rhythm (user decision, 2026-08-21).
    expect(SWIMLANE_HEIGHT).toBe(38)
    expect(SWIMLANE_WIDTH).toBe(19)
  })

  test('the vendored body matches the upstream slice byte-for-byte (SHA-256 drift guard)', () => {
    // Guards against silent drift of the copied regions: everything after
    // the adapted constants block must hash to the SHA-256 of the exact
    // upstream line ranges listed in the VENDORED FROM header (ranges
    // 26-68, 70-122, 124-275, 292-407, 420-530, 532-558 of
    // src/vs/workbench/contrib/scm/browser/scmHistory.ts @ 611c5df);
    // the constants block itself (upstream 20-24) is the pinned
    // [fork:adapt] region covered by the dedicated test above.
    const body = source.slice(source.indexOf('const SWIMLANE_CURVE_RADIUS'))
    const digest = createHash('sha256').update(body).digest('hex')
    expect(digest).toBe('3406406cf1ba40bd8f5125268106d55122be103982290abe16c06f37249886fd')
  })
})
