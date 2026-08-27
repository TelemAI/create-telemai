// A minimal JSONC scanner, used only to EDIT someone else's file in place.
//
// opencode's config is `opencode.json` or `opencode.jsonc` and, despite the name,
// both are read as JSONC — so it may carry comments the user wrote. Reserializing
// it with `JSON.stringify` would delete those comments, which is the same class of
// damage as clobbering an unmanaged key. So: we PARSE a comment-blanked copy to
// understand the file, and then splice the original text at offsets taken from
// that copy.
//
// The blanking is length-preserving, which is the whole trick: every offset the
// scanner finds in the blanked copy is the same offset in the original bytes.
//
// This is deliberately not a general JSONC library. It answers three questions —
// is this file structurally readable, where is the root object, where is the
// `plugin` array — and abstains loudly on anything it cannot answer.

export type Span = { start: number; end: number }

export type BlankResult = {
  /** Same length as the input, comments replaced by spaces (newlines preserved). */
  blanked: string
  hadComments: boolean
  /** Set when a string or block comment runs off the end of the file. */
  error?: string
}

/** Replace comments with spaces, keeping every offset and line number intact. */
export function blankComments(text: string): BlankResult {
  const out = text.split("")
  let hadComments = false
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index += 1
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2
          continue
        }
        if (text[index] === '"') break
        if (text[index] === "\n") {
          return { blanked: out.join(""), hadComments, error: "unterminated string" }
        }
        index += 1
      }
      if (index >= text.length) {
        return { blanked: out.join(""), hadComments, error: "unterminated string" }
      }
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      hadComments = true
      while (index < text.length && text[index] !== "\n") {
        out[index] = " "
        index += 1
      }
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      hadComments = true
      const start = index
      let end = text.indexOf("*/", index + 2)
      if (end === -1) {
        return { blanked: out.join(""), hadComments, error: "unterminated block comment" }
      }
      end += 2
      for (let cursor = start; cursor < end; cursor += 1) {
        if (out[cursor] !== "\n") out[cursor] = " "
      }
      index = end
      continue
    }
    index += 1
  }
  return { blanked: out.join(""), hadComments }
}

/** Replace trailing commas (`,` before `}`/`]`) with spaces. Length-preserving. */
export function blankTrailingCommas(text: string): string {
  const out = text.split("")
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1
      }
      index += 1
      continue
    }
    if (char === ",") {
      let ahead = index + 1
      while (ahead < text.length && isSpace(text[ahead])) ahead += 1
      if (ahead < text.length && (text[ahead] === "}" || text[ahead] === "]")) out[index] = " "
    }
    index += 1
  }
  return out.join("")
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}

export type JsoncRead =
  | { ok: true; value: unknown; blanked: string; hadComments: boolean }
  | { ok: false; error: string }

/** Parse JSONC tolerantly (comments + trailing commas) and keep the blanked copy. */
export function readJsonc(text: string): JsoncRead {
  const blank = blankComments(text)
  if (blank.error) return { ok: false, error: blank.error }
  const relaxed = blankTrailingCommas(blank.blanked)
  try {
    return {
      ok: true,
      value: JSON.parse(relaxed || "null"),
      blanked: blank.blanked,
      hadComments: blank.hadComments,
    }
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? "invalid JSON" }
  }
}

/** Span of the root `{...}`, or `null` when the document's root is not an object. */
export function rootObjectSpan(blanked: string): Span | null {
  let index = 0
  while (index < blanked.length && isSpace(blanked[index])) index += 1
  if (blanked[index] !== "{") return null
  const end = matchingBracket(blanked, index)
  return end === -1 ? null : { start: index, end }
}

/**
 * Span of `[...]` for a top-level `"<key>": [ ... ]`, or `null` when the key is
 * absent or its value is not an array literal.
 */
export function topLevelArraySpan(blanked: string, key: string): Span | null {
  const root = rootObjectSpan(blanked)
  if (!root) return null
  let index = root.start + 1
  let depth = 0
  while (index < root.end) {
    const char = blanked[index]
    if (char === '"' && depth === 0) {
      const stringEnd = stringEndIndex(blanked, index)
      if (stringEnd === -1) return null
      const name = safeParseString(blanked.slice(index, stringEnd + 1))
      let cursor = stringEnd + 1
      while (cursor < root.end && isSpace(blanked[cursor])) cursor += 1
      if (blanked[cursor] === ":" && name === key) {
        cursor += 1
        while (cursor < root.end && isSpace(blanked[cursor])) cursor += 1
        if (blanked[cursor] !== "[") return null
        const close = matchingBracket(blanked, cursor)
        return close === -1 ? null : { start: cursor, end: close }
      }
      index = stringEnd + 1
      continue
    }
    if (char === '"') {
      const stringEnd = stringEndIndex(blanked, index)
      if (stringEnd === -1) return null
      index = stringEnd + 1
      continue
    }
    if (char === "{" || char === "[") depth += 1
    else if (char === "}" || char === "]") depth -= 1
    index += 1
  }
  return null
}

/** Index of the closing bracket matching the opener at `open`, or -1. */
export function matchingBracket(text: string, open: number): number {
  const opener = text[open]
  const closer = opener === "{" ? "}" : "]"
  let depth = 0
  let index = open
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const end = stringEndIndex(text, index)
      if (end === -1) return -1
      index = end + 1
      continue
    }
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

function stringEndIndex(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2
      continue
    }
    if (text[index] === '"') return index
    index += 1
  }
  return -1
}

function safeParseString(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

/** Index of the first non-whitespace character after `open`, or -1 when empty. */
export function firstElementIndex(text: string, span: Span): number {
  let index = span.start + 1
  while (index < span.end && isSpace(text[index])) index += 1
  return index < span.end ? index : -1
}
