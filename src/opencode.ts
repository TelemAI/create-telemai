// The opencode surface's file edit: put `@telemai/opencode-plugin` into the
// `plugin` array of opencode.json / opencode.jsonc.
//
// Three properties this planner has to hold, all of them "someone else owns this
// file" properties:
//
//  * It is a TEXT edit, not a reserialize. opencode's config is read as JSONC and
//    users do put comments in it; `JSON.parse` → mutate → `JSON.stringify` would
//    silently delete every comment and reflow the whole file.
//  * An existing entry — plain, version-pinned, or in the plugin-TUPLE form
//    `["@telemai/opencode-plugin", { … }]` that spec level 1 makes meaningful —
//    is left exactly as it is. Adding a second entry beside a configured tuple
//    would be an idempotence bug that silently drops the user's options.
//  * Anything it cannot do safely ABORTS with the path and the manual snippet. An
//    unparseable config is never overwritten (the openclaw installer's rule).

import { firstElementIndex, readJsonc, rootObjectSpan, topLevelArraySpan } from "./jsonc.ts"

export type OpencodeEdit =
  | { status: "unchanged"; reason: string }
  | { status: "write"; contents: string; created: boolean; reason: string }
  | { status: "abort"; reason: string }

const PLUGIN_KEY = "plugin"

/** Does this `plugin` array already carry `pkg`, in any of its legal spellings? */
export function pluginArrayHas(entries: unknown, pkg: string): boolean {
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry
    if (typeof name !== "string") return false
    return name === pkg || name.startsWith(`${pkg}@`)
  })
}

export function planOpencodePlugin(source: string | null, pkg: string, path: string): OpencodeEdit {
  if (source === null || source.trim() === "") {
    return {
      status: "write",
      created: true,
      reason: `create ${path} with a plugin array`,
      contents: `{\n  "${PLUGIN_KEY}": ["${pkg}"]\n}\n`,
    }
  }

  const read = readJsonc(source)
  if (!read.ok) {
    return {
      status: "abort",
      reason: `${path} is not valid JSON/JSONC (${read.error}); fix it, or add "${pkg}" to its "${PLUGIN_KEY}" array by hand`,
    }
  }
  if (typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
    return {
      status: "abort",
      reason: `${path} does not contain a JSON object; add {"${PLUGIN_KEY}": ["${pkg}"]} by hand`,
    }
  }

  const config = read.value as Record<string, unknown>
  const existing = Object.prototype.hasOwnProperty.call(config, PLUGIN_KEY)
    ? config[PLUGIN_KEY]
    : undefined

  if (existing !== undefined && !Array.isArray(existing)) {
    return {
      status: "abort",
      reason: `${path} has a "${PLUGIN_KEY}" key that is not an array; add "${pkg}" to it by hand`,
    }
  }
  if (pluginArrayHas(existing, pkg)) {
    return { status: "unchanged", reason: `${path} already lists ${pkg}` }
  }

  const blanked = read.blanked
  if (existing !== undefined) {
    const span = topLevelArraySpan(blanked, PLUGIN_KEY)
    if (!span) {
      // The value parses as an array but is not a literal we can point at — a
      // shape this scanner does not model. Abstain rather than guess.
      return {
        status: "abort",
        reason: `could not locate the "${PLUGIN_KEY}" array in ${path}; add "${pkg}" to it by hand`,
      }
    }
    const first = firstElementIndex(blanked, span)
    if (first === -1) {
      // No elements — but the brackets may still hold a comment we must not drop
      // (`first` is measured on the comment-blanked copy, so a comment reads as
      // empty here). Keep any inner text and slot our entry in front of it.
      const inner = source.slice(span.start + 1, span.end)
      const contents =
        inner.trim() === ""
          ? `${source.slice(0, span.start)}["${pkg}"]${source.slice(span.end + 1)}`
          : `${source.slice(0, span.start + 1)}"${pkg}"${inner}${source.slice(span.end)}`
      return { status: "write", created: false, contents, reason: `add ${pkg} to ${path}` }
    }
    // Reuse the whitespace that leads the first element as our entry's indentation,
    // so a one-line array stays one line and an indented one keeps its indentation.
    //
    // Crucially, reuse only the WHITESPACE, never a comment. `first` comes from the
    // comment-blanked copy, so a comment sitting between `[` and the first element
    // is skipped by it — slicing the ORIGINAL from `[` up to `first` would capture
    // that comment, and the tail slice (which starts right after `[`) re-emits it,
    // printing the comment twice. Taking only the leading whitespace run and letting
    // the untouched tail carry the comment + element keeps every comment exactly once.
    const tail = source.slice(span.start + 1)
    const leadingWhitespace = /^\s*/.exec(tail)?.[0] ?? ""
    // A one-line array has no whitespace to reuse, so it gets the `", "` its own
    // entries are separated by rather than a jammed-together `","`.
    const separator = leadingWhitespace === "" ? " " : ""
    const contents = `${source.slice(0, span.start + 1)}${leadingWhitespace}"${pkg}",${separator}${tail}`
    return { status: "write", created: false, contents, reason: `add ${pkg} to ${path}` }
  }

  const root = rootObjectSpan(blanked)
  if (!root) {
    return {
      status: "abort",
      reason: `could not locate the top-level object in ${path}; add "${PLUGIN_KEY}": ["${pkg}"] by hand`,
    }
  }
  const firstKey = firstElementIndex(blanked, root)
  if (firstKey === -1) {
    // No keys — but the braces may still hold a comment we must not drop (`firstKey`
    // is measured on the comment-blanked copy, so a comment reads as empty here).
    // Rebuild the braces from scratch ONLY when the object is genuinely empty;
    // otherwise slot our key in and let the untouched inner text carry the comment.
    const inner = source.slice(root.start + 1, root.end)
    const contents =
      inner.trim() === ""
        ? `${source.slice(0, root.start)}{\n  "${PLUGIN_KEY}": ["${pkg}"]\n}${source.slice(root.end + 1)}`
        : `${source.slice(0, root.start + 1)}"${PLUGIN_KEY}": ["${pkg}"]${inner}${source.slice(root.end)}`
    return { status: "write", created: false, contents, reason: `add a "${PLUGIN_KEY}" array to ${path}` }
  }
  // Reuse only the leading WHITESPACE before the first key as our key's indentation,
  // never a leading header comment. `firstKey` comes from the comment-blanked copy,
  // so a comment between `{` and the first key is skipped by it — slicing the ORIGINAL
  // from `{` up to `firstKey` would capture that comment, and the tail slice (which
  // starts right after `{`) re-emits it, printing the comment TWICE. Taking only the
  // whitespace run and letting the untouched tail carry the comment keeps it once.
  const tail = source.slice(root.start + 1)
  const leadingWhitespace = /^\s*/.exec(tail)?.[0] ?? ""
  const contents = `${source.slice(0, root.start + 1)}${leadingWhitespace}"${PLUGIN_KEY}": ["${pkg}"],${tail}`
  return { status: "write", created: false, contents, reason: `add a "${PLUGIN_KEY}" array to ${path}` }
}

/**
 * Which opencode config file to edit: whichever of `opencode.json` /
 * `opencode.jsonc` already exists (json first, matching opencode's own lookup),
 * else `opencode.json` as the file to create.
 */
export function pickOpencodeConfigPath(
  dir: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): string {
  const json = join(dir, "opencode.json")
  const jsonc = join(dir, "opencode.jsonc")
  if (exists(json)) return json
  if (exists(jsonc)) return jsonc
  return json
}
