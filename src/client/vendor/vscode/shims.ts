/**
 * Shims for the vendored vscode graph core (scm-history.ts): minimal,
 * faithful stand-ins for the vscode-internal symbols its copy regions
 * import. Every entry is annotated "上游符号: behavior" with the upstream
 * source, so the mapping stays auditable. The vendored file itself is
 * untouched by these shims (module-resolution adaptation only, see its
 * [fork:adapt] marker).
 *
 * Symbols NOT shimmed because no copied region references them: $/svgElem
 * (src/vs/base/browser/dom.js — used only by the excluded
 * renderSCMHistoryGraphPlaceholder), DisposableStore/IDisposable,
 * the IMarkdownString family, ThemeIcon, IMarkdownRendererService.
 * @module dsh-session-fork/src/client/vendor/vscode/shims
 */

/**
 * 上游符号: localize (src/vs/nls.ts)
 * 行为: 返回 key 的本地化文案(英文环境即 message 本身,支持 {...} 参数占位)。
 * 本拷贝区域仅将其用于 (a) registerColor 的描述参数(本 shim 忽略)、
 * (b) incoming/outgoing-changes 占位节点文案(本插件从不启用这两个节点,
 * 见 scm-history.ts 的 addIncomingOutgoingChangesHistoryItems 调用点)。
 * shim: 原样返回 message,不带参数占位支持。
 */
export function localize(_key: string, message: string): string {
  return message
}

/**
 * 上游符号: deepClone (src/vs/base/common/objects.ts:8)
 * 行为: 非对象值/RegExp 原样返回;数组克隆为 [],普通对象克隆为 {},仅对
 * object 类型的值递归(键的拷贝走 Object.entries)。
 * shim: 与上游同语义的结构化拷贝。
 */
export function deepClone<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') {
    return obj
  }
  if (obj instanceof RegExp) {
    return obj
  }
  // 上游此处为 `const result: any`;本插件 strict 配置下用
  // Record<string, unknown> 承载"数组或普通对象"两态(数组的下标写同样合法)。
  const result = (Array.isArray(obj) ? [] : {}) as Record<string, unknown>
  Object.entries(obj).forEach(([key, value]) => {
    result[key] = value && typeof value === 'object' ? deepClone(value) : value
  })
  return result as T
}

/**
 * 上游符号: rot (src/vs/base/common/numbers.ts:28)
 * 行为: (modulo + (index % modulo)) % modulo —— 循环取模,负 index 也落在
 * [0, modulo) 区间。
 * shim: 同式。
 */
export function rot(index: number, modulo: number): number {
  return (modulo + (index % modulo)) % modulo
}

/**
 * 上游符号: findLastIdx (src/vs/base/common/arraysFind.ts:18)
 * 行为: 从 fromIndex(默认末位)向前找第一个 predicate 命中的下标,无命中
 * 返回 -1。
 * shim: 同语义。array[i] 在本插件 strict 配置下是 T | undefined,断言为 T
 * (循环上界保证下标合法)。
 */
export function findLastIdx<T>(
  array: readonly T[],
  predicate: (item: T, index: number) => unknown,
  fromIndex: number = array.length - 1,
): number {
  for (let i = fromIndex; i >= 0; i--) {
    const element = array[i] as T
    if (predicate(element, i)) {
      return i
    }
  }
  return -1
}

/**
 * 上游符号: ColorIdentifier (src/vs/platform/theme/common/colorUtils.ts:19)
 * 行为: type ColorIdentifier = string(主题色的 id)。
 * shim: 同义。
 */
export type ColorIdentifier = string

/**
 * 上游符号: registerColor (src/vs/platform/theme/common/colorUtils.ts:252)
 * 行为: 向主题色注册表登记 (id, defaults, description) 并返回 ColorIdentifier
 * (即 id 本身)。
 * shim: 本插件无主题注册表——固定五色盘由 CSS 变量承载(见 asCssVariable),
 * defaults/description 无消费者,故直接返回 id。
 */
export function registerColor(id: string, _defaults: unknown, _description: string): ColorIdentifier {
  return id
}

/**
 * 上游符号: asCssVariable (src/vs/platform/theme/common/colorUtils.ts:39)
 * 行为: id → var(--vscode-<id 以 - 替换 .>)。
 * shim: 五色盘 id 映射为 var(--dsh-fork-graph-1..5)(色板值在 client CSS
 * 中定义);三个 ref 色映射为 var(--dsh-fork-graph-ref / -ref-remote /
 * -ref-base);未知 id 兜底第 1 色,保证渲染永不产生非法 CSS。
 */
const GRAPH_CSS_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  'scmGraph.foreground1': 'var(--dsh-fork-graph-1)',
  'scmGraph.foreground2': 'var(--dsh-fork-graph-2)',
  'scmGraph.foreground3': 'var(--dsh-fork-graph-3)',
  'scmGraph.foreground4': 'var(--dsh-fork-graph-4)',
  'scmGraph.foreground5': 'var(--dsh-fork-graph-5)',
  'scmGraph.historyItemRefColor': 'var(--dsh-fork-graph-ref)',
  'scmGraph.historyItemRemoteRefColor': 'var(--dsh-fork-graph-ref-remote)',
  'scmGraph.historyItemBaseRefColor': 'var(--dsh-fork-graph-ref-base)',
})

export function asCssVariable(colorIdentifier: ColorIdentifier): string {
  return GRAPH_CSS_VARIABLES[colorIdentifier] ?? 'var(--dsh-fork-graph-1)'
}

/**
 * 上游符号: foreground / badgeBackground / chartsBlue / chartsPurple
 * (src/vs/platform/theme/common/colorRegistry.js 再导出的已注册主题色)
 * 行为: 上游为 ColorIdentifier,在本拷贝区域仅作为 registerColor 的 defaults
 * 实参出现;本 shim 的 registerColor 忽略 defaults,故这些值不参与渲染。
 * 导出上游的 id 占位以保持导入形状。上游默认值备查:foreground
 * {dark:'#CCCCCC', light:'#616161'};badgeBackground {dark:'#4D4D4D',
 * light:'#C4C4C4'};chartsBlue→editorInfoForeground {dark:'#59a4f9',
 * light:'#0063d3'};chartsPurple {dark:'#B180D7', light:'#652D90'}。
 */
export const foreground: ColorIdentifier = 'foreground'
export const badgeBackground: ColorIdentifier = 'badge.background'
export const chartsBlue: ColorIdentifier = 'charts.blue'
export const chartsPurple: ColorIdentifier = 'charts.purple'

/**
 * 上游符号: PANEL_BACKGROUND (src/vs/workbench/common/theme.ts:486)
 * 行为: 同上——仅作 registerColor 的 defaults 实参,导出上游 id 占位
 * ('panel.background')。
 */
export const PANEL_BACKGROUND: ColorIdentifier = 'panel.background'
