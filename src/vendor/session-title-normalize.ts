/**
 * VENDORED FROM: deepseek-harness@528c682e061696f5a160f363f236ecbf53cbd006
 * (copied 2026-08-21)
 *
 * - packages/session/session-title/src/normalize.ts:1-74 — the title
 *   normalization the mounted SessionTitleService applies before accepting
 *   any `session.rename`. `fallbackSessionTitle` (upstream lines 64-74) is
 *   not vendored: no fork-button path derives a fallback title.
 *
 * Why vendor instead of import: the browser client bundle cannot resolve
 * `@deepseek-ai/dsh-session-title` (the client module table seeds only
 * react/cordis/ui-primitives/ui-slots/runtime; that package ships no
 * client half), and upstream counts UTF-8 bytes with Node's Buffer, which
 * does not exist in a browser. The single adaptation is marked inline;
 * tests/parity.test.ts pins this copy against the official package so the
 * issue #7 identity gate ("gate ≡ rename normalization") keeps holding
 * even though the two halves now run different copies.
 * @module dsh-session-fork/src/vendor/session-title-normalize
 */

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

// [fork:adapt] Buffer.byteLength → TextEncoder: identical UTF-8 byte counts
// in every environment (browser and Node ≥ 18 both encode lone surrogates
// as U+FFFD); upstream normalize.ts counts with Node's Buffer, which does
// not exist in the browser bundle.
const utf8Encoder = new TextEncoder()

/** UTF-8 encoded length of one string, without Node's Buffer. */
function utf8ByteLength(input: string): number {
  return utf8Encoder.encode(input).length
}

/** Reject an invalid public text limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Remove controls and produce one trimmed, whitespace-normalized line. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - normalized title text.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (utf8ByteLength(input) <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = utf8ByteLength(character)
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Normalize one accepted session title and enforce its UTF-8 byte budget.
 * @param input - untrusted title text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe one-line title, possibly empty after sanitization.
 */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}
