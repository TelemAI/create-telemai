// The Grok Build surface's file edits: `~/.grok/config.toml` and `~/.grok/hooks/telem.json`.
//
// Grok Build (`grok`) speaks remote MCP with headers, so it points at the HOSTED Telem
// MCP the same way Codex does, and its config file is TOML of the same shape: a
// `[mcp_servers.telem]` table with `url` and an inline `headers` table (Codex spells it
// `http_headers`). So this file edits it with the Codex line editor (`codex.ts`), never
// reserializing a file Grok also writes, and with the Codex rules: the key is a literal
// `Authorization: Bearer <key>` in a 0600 file; a custom url is left alone; on our url
// only our headers are brought in line; a file the scanner cannot read is refused with
// the snippet to paste. Grok sends its own User-Agent, so none is written.
//
// Three more changes, two of them consent-gated:
//  * `disable_web_search = true` — a TOP-LEVEL boolean (above the first table header,
//    or it would belong to that table). It removes Grok's own web search and fetch;
//    its X search stays.
//  * `[permission] allow = ["MCPTool(telem__telem_search)", "MCPTool(telem__telem_fetch)"]`
//    — Grok asks before every MCP call, and does not read `readOnlyHint`. Added only
//    when the file has no `permission` at all; a file that has one is not edited, and
//    the run prints the line to add.
// Grok's own `grok mcp enable|disable` rewrites the file, and turns our inline `headers`
// into a `[mcp_servers.telem.headers]` sub-table. So on our url the key and routing header
// are brought in line in that form too; without that, a rotated key would stay stale
// under an "unchanged" report.
//
//  * `hooks/telem.json` — the PreToolUse hook that sends lineage, reasoning and the
//    `.telem` options on each telem_search / telem_fetch. A file of its own, so it never
//    merges with the user's hooks. It runs `node` with the script as an argument: no
//    shell, so no quoting on any platform. Since Grok 1.0.64 a user hook runs only in a
//    trusted folder, and Grok then asks for trust in every new folder.

import { join } from "node:path"

import {
  CODEX_KEY_CHARSET,
  CODEX_TABLE,
  CODEX_URL,
  ROUTING_HEADER,
  currentValue,
  findTelemTable,
  isKeyPath,
  isUnderKeyPath,
  reconcileHostedAuth,
  reconcileHostedRouting,
  remoteTableBody,
  remoteTableText,
  replaceValue,
  scanToml,
  type HostedRouting,
  type TomlLine,
} from "./codex.ts"

/** The hosted Telem MCP endpoint — the one every hosted surface points at. */
export const GROK_URL = CODEX_URL
export const GROK_TABLE = CODEX_TABLE
/** Grok names an MCP server's tools `<server>__<tool>`; the hook matcher tests that name. */
export const GROK_HOOK_MATCHER = "^telem__telem_(search|fetch)$"
/** The hook script's file name; it is how our hooks file is recognised. */
export const GROK_HOOK_FILE = "telem-grok.mjs"
export const GROK_WEB_SEARCH_KEY = "disable_web_search"
export const GROK_ALLOW_RULES = ["MCPTool(telem__telem_search)", "MCPTool(telem__telem_fetch)"] as const
/** Seconds Grok waits for the hook (its default for PreToolUse is 5). The hook only
 * reads files; Grok goes on without it after this. */
const GROK_HOOK_TIMEOUT = 30

/** The Grok home: `$GROK_HOME` if set, else `~/.grok`. */
export function grokHome(env: Record<string, string | undefined>, home: string): string {
  const override = (env.GROK_HOME ?? "").trim()
  return override ? override : join(home, ".grok")
}

export function grokConfigPath(grokDir: string): string {
  return join(grokDir, "config.toml")
}

export function grokHooksPath(grokDir: string): string {
  return join(grokDir, "hooks", "telem.json")
}

const ALLOW_LINE = `allow = [${GROK_ALLOW_RULES.map((rule) => `"${rule}"`).join(", ")}]`

export type GrokConfigEdit =
  /** Nothing to write. `permissionManual` as in the write case. */
  | { status: "unchanged"; permissionManual: string | null }
  | {
      status: "write"
      contents: string
      created: boolean
      changes: string[]
      /** This edit added `[mcp_servers.telem]`; "remove it" is correct undo advice only then. */
      addedTable: boolean
      /** An existing hosted table had its headers brought in line with this run. */
      reconciled: boolean
      /** The hosted table has no key to authenticate with; the run must say so. */
      keyless: boolean
      /** A key was given but is not a tlm_ key, so no header was built from it. */
      keyMalformed: boolean
      /** The allow rule was wanted but the file already has a `permission` table:
       * the line to add by hand, else null. */
      permissionManual: string | null
    }
  | { status: "abort"; reason: string }

export type GrokConfigInput = {
  apiKey: string | null
  autoRouting: HostedRouting | null
  disableWebSearch: boolean
  allowTelem: boolean
}

const HEADERS_TABLE = ["mcp_servers", "telem", "headers"] as const

/** The `[mcp_servers.telem.headers]` sub-table Grok writes: its header and its end. */
function headersSubTable(lines: readonly TomlLine[]): { header: number; end: number } | null {
  const header = lines.findIndex((line) => line.kind === "header" && isKeyPath(line.parts, HEADERS_TABLE))
  if (header === -1) return null
  let end = header + 1
  while (end < lines.length && lines[end].kind !== "header") end += 1
  return { header, end }
}

/** One header's pair in the sub-table, matched case-insensitively, as Grok spells HTTP
 * header names as written; -1 when absent. */
function headerPair(lines: readonly TomlLine[], table: { header: number; end: number }, name: string): number {
  return lines.findIndex(
    (line, index) =>
      index > table.header &&
      index < table.end &&
      line.kind === "pair" &&
      line.parts.length === 1 &&
      line.parts[0].toLowerCase() === name.toLowerCase(),
  )
}

/**
 * Bring the key and routing header in line inside a `[mcp_servers.telem.headers]`
 * sub-table: each is replaced in place or added, and every other header keeps its line.
 * A multi-line value is left alone. Mutates `lines`; returns what changed.
 */
function reconcileHeadersSubTable(
  lines: TomlLine[],
  apiKey: string | null,
  routing: HostedRouting | null,
): { auth: "added" | "replaced" | null; routing: boolean } {
  const result: { auth: "added" | "replaced" | null; routing: boolean } = { auth: null, routing: false }
  const set = (name: string, value: string): "added" | "replaced" | null => {
    const table = headersSubTable(lines)
    if (!table) return null
    const index = headerPair(lines, table, name)
    if (index === -1) {
      lines.splice(table.header + 1, 0, { kind: "pair", text: `${name} = "${value}"`, key: name, parts: [name] })
      return "added"
    }
    if (lines[index + 1]?.kind === "continuation") return null
    if (currentValue(lines[index].text) === `"${value}"`) return null
    lines[index] = { ...lines[index], text: replaceValue(lines[index].text, `"${value}"`) } as TomlLine
    return "replaced"
  }
  if (apiKey) result.auth = set("Authorization", `Bearer ${apiKey}`)
  if (apiKey && routing) result.routing = set(ROUTING_HEADER, routing) !== null
  return result
}

/** The index of the first table header, or the line count when there is none. */
function firstHeaderIndex(lines: readonly TomlLine[]): number {
  const index = lines.findIndex((line) => line.kind === "header")
  return index === -1 ? lines.length : index
}

/** True when config.toml already turns off Grok's own web search. */
export function grokWebSearchOff(source: string | null): boolean {
  if (source === null) return false
  const scan = scanToml(source)
  if (!scan.ok) return false
  const limit = firstHeaderIndex(scan.lines)
  const index = scan.lines.findIndex(
    (line, at) => at < limit && line.kind === "pair" && isKeyPath(line.parts, [GROK_WEB_SEARCH_KEY]),
  )
  return index !== -1 && currentValue(scan.lines[index].text) === "true"
}

/** Every line that defines `permission`: a `[permission(.x)]` header, or a top-level
 * `permission` / `permission.x` pair. */
function permissionLines(lines: readonly TomlLine[]): number[] {
  const limit = firstHeaderIndex(lines)
  const found: number[] = []
  lines.forEach((line, index) => {
    if (line.kind === "header" && (isKeyPath(line.parts, ["permission"]) || isUnderKeyPath(line.parts, ["permission"]))) {
      found.push(index)
    } else if (
      index < limit &&
      line.kind === "pair" &&
      (isKeyPath(line.parts, ["permission"]) || isUnderKeyPath(line.parts, ["permission"]))
    ) {
      found.push(index)
    }
  })
  return found
}

/** True when the file's permission rules already allow both Telem tools. */
export function grokTelemAllowed(source: string | null): boolean {
  if (source === null) return false
  const scan = scanToml(source)
  if (!scan.ok) return false
  const lines = scan.lines
  const starts = permissionLines(lines)
  if (!starts.length) return false
  // The text of every permission region: a header's table up to the next header, or a
  // pair with its continuation lines.
  let text = ""
  for (const start of starts) {
    let end = start + 1
    if (lines[start].kind === "header") while (end < lines.length && lines[end].kind !== "header") end += 1
    else while (end < lines.length && lines[end].kind === "continuation") end += 1
    text += lines
      .slice(start, end)
      .map((line) => line.text)
      .join("\n")
  }
  return GROK_ALLOW_RULES.every((rule) => text.includes(`"${rule}"`) || text.includes(`'${rule}'`))
}

export function planGrokConfig(source: string | null, input: GrokConfigInput, path: string): GrokConfigEdit {
  const routing = input.autoRouting
  const rawKey = input.apiKey
  // The key goes verbatim into an inline TOML table, so a value outside the tlm_
  // charset is refused rather than escaped (the Codex rule).
  const keyMalformed = rawKey !== null && rawKey.length > 0 && !CODEX_KEY_CHARSET.test(rawKey)
  const apiKey = keyMalformed ? null : rawKey
  const manual = `add\n\n  [${GROK_TABLE}]\n  url = "${GROK_URL}"\n  headers = { Authorization = "Bearer <your tlm_ key>" }\n\nto ${path} by hand`

  if (source === null) {
    const changes = [`create with [${GROK_TABLE}] (hosted url${apiKey ? " + auth header" : ""})`]
    let text = ""
    if (input.disableWebSearch) {
      text += `${GROK_WEB_SEARCH_KEY} = true\n\n`
      changes.push(`set ${GROK_WEB_SEARCH_KEY} = true`)
    }
    text += remoteTableText(apiKey, routing, "headers")
    if (input.allowTelem) {
      text += `\n[permission]\n${ALLOW_LINE}\n`
      changes.push("add [permission] allow for the two Telem tools")
    }
    return {
      status: "write",
      contents: text,
      created: true,
      changes,
      addedTable: true,
      reconciled: false,
      keyless: !apiKey,
      keyMalformed,
      permissionManual: null,
    }
  }

  const scan = scanToml(source)
  if (!scan.ok) return { status: "abort", reason: `${path} could not be parsed (${scan.error}); ${manual}` }
  const lines = scan.lines.slice()
  const changes: string[] = []

  if (input.disableWebSearch) {
    const limit = firstHeaderIndex(lines)
    // A `[disable_web_search]` table, a dotted `disable_web_search.x` pair or a
    // multi-line value is not a scalar this line editor can set: abstain, as Codex does.
    const tableForm = lines.some(
      (line) =>
        line.kind === "header" &&
        (isKeyPath(line.parts, [GROK_WEB_SEARCH_KEY]) || isUnderKeyPath(line.parts, [GROK_WEB_SEARCH_KEY])),
    )
    const dottedForm = lines.some(
      (line, index) => index < limit && line.kind === "pair" && isUnderKeyPath(line.parts, [GROK_WEB_SEARCH_KEY]),
    )
    const existing = lines.findIndex(
      (line, index) => index < limit && line.kind === "pair" && isKeyPath(line.parts, [GROK_WEB_SEARCH_KEY]),
    )
    const multiline = existing !== -1 && lines[existing + 1]?.kind === "continuation"
    if (tableForm || dottedForm || multiline) {
      return {
        status: "abort",
        reason: `${path} already defines ${GROK_WEB_SEARCH_KEY} in a form this installer will not rewrite; set \`${GROK_WEB_SEARCH_KEY} = true\` at the top of ${path} by hand`,
      }
    }
    if (existing === -1) {
      lines.splice(
        limit,
        0,
        { kind: "pair", text: `${GROK_WEB_SEARCH_KEY} = true`, key: GROK_WEB_SEARCH_KEY, parts: [GROK_WEB_SEARCH_KEY] },
        { kind: "blank", text: "" },
      )
      changes.push(`set ${GROK_WEB_SEARCH_KEY} = true`)
    } else if (currentValue(lines[existing].text) !== "true") {
      const previous = currentValue(lines[existing].text)
      lines[existing] = {
        kind: "pair",
        key: GROK_WEB_SEARCH_KEY,
        parts: [GROK_WEB_SEARCH_KEY],
        text: replaceValue(lines[existing].text, "true"),
      }
      changes.push(`set ${GROK_WEB_SEARCH_KEY} = true (was ${previous || "empty"})`)
    }
  }

  let addedTable = false
  let reconciled = false
  const telem = findTelemTable(lines)
  if (telem === null) {
    while (lines.length && lines[lines.length - 1].kind === "blank") lines.pop()
    if (lines.length) lines.push({ kind: "blank", text: "" })
    lines.push({ kind: "header", text: `[${GROK_TABLE}]`, name: GROK_TABLE, parts: ["mcp_servers", "telem"] })
    lines.push(...remoteTableBody(apiKey, routing, "headers"))
    changes.push(`add [${GROK_TABLE}] (hosted url${apiKey ? " + auth header" : ""})`)
    addedTable = true
  } else if (
    telem.pairs.some((pair) => isKeyPath(pair.parts, ["url"]) && currentValue(pair.text) === `"${GROK_URL}"`) &&
    headersSubTable(lines)
  ) {
    // Ours, in the sub-table form Grok's own commands write.
    const outcome = reconcileHeadersSubTable(lines, apiKey, routing)
    if (outcome.auth !== null) {
      changes.push(
        outcome.auth === "added"
          ? `add the Telem auth header to [${GROK_TABLE}]`
          : `replace the stale Telem auth header in [${GROK_TABLE}]`,
      )
      reconciled = true
    }
    if (outcome.routing) {
      changes.push(`set the routing header in [${GROK_TABLE}]`)
      reconciled = true
    }
  } else if (telem.pairs.some((pair) => isKeyPath(pair.parts, ["url"]))) {
    // Already hosted: a custom url stays the user's; on ours, an absent or stale key
    // and the routing answer are brought in line, and nothing else in the table moves.
    const auth = reconcileHostedAuth(lines, telem, apiKey, routing, "headers")
    if (auth !== null) {
      changes.push(
        auth === "added"
          ? `add the Telem auth header to [${GROK_TABLE}]`
          : `replace the stale Telem auth header in [${GROK_TABLE}]`,
      )
      reconciled = true
    }
    // findTelemTable again: the auth reconcile may have added a line.
    const routed = reconcileHostedRouting(lines, findTelemTable(lines) ?? telem, routing, "headers")
    if (routed !== null) {
      changes.push(`set the routing header in [${GROK_TABLE}]`)
      reconciled = true
    }
  }
  // A `command = …` (stdio) telem server is the user's own; it is left as it is.

  let permissionManual: string | null = null
  if (input.allowTelem && !grokTelemAllowed(source)) {
    if (permissionLines(lines).length) {
      permissionManual = `${ALLOW_LINE} (under [permission] in ${path})`
    } else {
      while (lines.length && lines[lines.length - 1].kind === "blank") lines.pop()
      if (lines.length) lines.push({ kind: "blank", text: "" })
      lines.push(
        { kind: "header", text: "[permission]", name: "permission", parts: ["permission"] },
        { kind: "pair", text: ALLOW_LINE, key: "allow", parts: ["allow"] },
      )
      changes.push("add [permission] allow for the two Telem tools")
    }
  }

  const finalTelem = findTelemTable(lines)
  const hosted =
    finalTelem !== null &&
    finalTelem.pairs.some((pair) => isKeyPath(pair.parts, ["url"]) && currentValue(pair.text) === `"${GROK_URL}"`)
  const subTable = headersSubTable(lines)
  const keyless =
    hosted &&
    !finalTelem.pairs.some((pair) => isKeyPath(pair.parts, ["headers"]) && /Authorization\s*=\s*"Bearer\s+\S/i.test(pair.text)) &&
    !(subTable && /"Bearer\s+\S/.test(lines[headerPair(lines, subTable, "Authorization")]?.text ?? ""))

  if (!changes.length) return { status: "unchanged", permissionManual }
  return {
    status: "write",
    contents: `${lines.map((line) => line.text).join("\n").replace(/\n+$/, "")}\n`,
    created: false,
    changes,
    addedTable,
    reconciled,
    keyless,
    keyMalformed,
    permissionManual,
  }
}

/** How to put config.toml back: one step per change this run made, nothing more. */
export function grokUndoLine(
  edit: { created: boolean; addedTable: boolean; reconciled: boolean; changes: string[] },
  path: string,
): string {
  if (edit.created) return `rm ${path}`
  const steps: string[] = []
  if (edit.addedTable) steps.push(`remove the [${GROK_TABLE}] table`)
  if (edit.reconciled) steps.push(`restore your previous Telem headers in [${GROK_TABLE}]`)
  for (const change of edit.changes) {
    const restored = /^set (\S+) = (\S+) \(was (.*)\)$/.exec(change)
    if (restored) steps.push(restored[3] === "empty" ? `remove the ${restored[1]} line` : `set ${restored[1]} back to ${restored[3]}`)
    else if (change.startsWith(`set ${GROK_WEB_SEARCH_KEY} = `)) steps.push(`remove the ${GROK_WEB_SEARCH_KEY} = true line`)
    else if (change.startsWith("add [permission]")) steps.push("remove the [permission] table")
  }
  return `in ${path}: ${steps.length ? steps.join("; ") : "undo the edits listed above"}`
}

export type GrokHooksEdit =
  | { status: "unchanged" }
  | { status: "write"; contents: string; created: boolean }
  | { status: "refuse"; reason: string }

/** `hooks/telem.json`: our own file, holding the one PreToolUse handler. An older copy
 * of ours is rewritten; a file of that name that is not ours is left alone. */
export function planGrokHooksFile(source: string | null, hookScript: string, path: string): GrokHooksEdit {
  const contents = `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: GROK_HOOK_MATCHER,
            hooks: [{ type: "command", command: "node", args: [hookScript], timeout: GROK_HOOK_TIMEOUT }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`
  if (source === null) return { status: "write", contents, created: true }
  if (source === contents) return { status: "unchanged" }
  if (source.includes(GROK_HOOK_FILE)) return { status: "write", contents, created: false }
  return {
    status: "refuse",
    reason:
      `${path} exists and is not the Telem hook file, so it was left alone and the telem hook was not installed. ` +
      `Rename that file, then re-run the installer`,
  }
}

/** Where the hook script and the two Codex modules it imports go, and the skill. */
export function grokHookDir(grokDir: string): string {
  return join(grokDir, "telem")
}

export function grokSkillPath(grokDir: string): string {
  return join(grokDir, "skills", "telem", "SKILL.md")
}
