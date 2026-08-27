// The Codex surface's file edit: `~/.codex/config.toml`.
//
// Codex speaks Channel A (`_meta["x-codex-turn-metadata"]`) natively, so it needs
// no bridge — only to point at the HOSTED Telem MCP, the same front door every
// other surface uses (stdio `telem-mcp` is the self-host fallback, not the default
// install). Three kinds of change live here, and they are NOT the same kind:
//
//  * `[mcp_servers.telem]` as a HOSTED REMOTE — `url = "https://mcp.telem.ai/mcp"`
//    plus an INLINE `http_headers = { Authorization = "Bearer <key>" }`. The key is
//    a REAL value written into the table (the hosted server authenticates per
//    request against the hosted auth service), exactly like the hosted Claude surface writes the key
//    into its plugin `userConfig` — self-contained, no env var to export. The
//    resolved credential is threaded in from run.ts; when none is available (a
//    `--dry-run`, or no key on disk) the table is still written but WITHOUT the
//    header, and the run prints a note to add it — we NEVER write an empty or
//    placeholder `Bearer`. Because the file now carries the key, it is staged as a
//    0600 secret write. An ABSENT telem table is added; an existing STDIO
//    (`command = …`) telem table is MIGRATED to the hosted form, but only with
//    consent (it changes where searches go, local → hosted) — and it takes the
//    server's contiguous `[mcp_servers.telem.*]` SUB-TABLES with it, because a
//    surviving `[mcp_servers.telem.env]` would keep a copy of the old key the user
//    believes the migration took away. The run records how to undo it. An
//    already-hosted table keeps its url — a CUSTOM url is never touched — but when
//    that url IS ours the Authorization line is RECONCILED against the effective
//    key: added when the table has none (the keyless first run that later gets a
//    key), replaced when it carries a stale one (a rotated key). Without that the
//    hosted MCP 401s forever while this installer reports "unchanged".
//  * `web_search = "disabled"` — CONSENT-GATED. It turns off a capability the user
//    already has, so it happens only when they say yes (or pass
//    `--codex-disable-web-search`), never as a side effect of installing.
//  * `model_reasoning_summary = "detailed"` — ADDITIVE reasoning capture (see
//    CODEX_REASONING_SUMMARY_KEY), added by default, and transport-agnostic: it
//    works over the hosted remote exactly as it did over stdio.
//  * `[hooks.state."<hook key>"]` — the PRE-GRANTED trust for the Codex plugin's
//    PreToolUse hook. A plugin hook is untrusted on install and SILENTLY SKIPPED
//    until trusted, and Codex exposes no CLI to grant it, so the installer writes
//    the same state Codex's own TUI writes. The keys and hashes come from
//    codex-plugin.ts (which explains how they are derived); this file only knows
//    how to put them in the file without disturbing anything else.
//
// TOML is edited by line, never reserialized: there is no stdlib TOML writer, and
// a hand-rolled one would reflow a file full of settings this wizard knows nothing
// about. A file this scanner cannot classify line-by-line ABORTS with the path and
// the snippet to paste — the openclaw installer's rule. A `url` the user
// pointed somewhere else is left alone; only the stdio form is a migration
// candidate, and only with consent; and on an already-hosted table only the
// Authorization line is ever rewritten.

export type CodexEdit =
  | {
      status: "unchanged"
      reason: string
      /** Every requested trust entry is already in the file with the right hash. */
      hookTrustSatisfied: boolean
      hookTrustAbstained: boolean
    }
  | {
      status: "write"
      contents: string
      created: boolean
      changes: string[]
      /** A stdio `command = …` table was rewritten to the hosted remote in place. */
      /**
       * This edit ADDED the `[mcp_servers.telem]` table — it was not there before.
       * The undo line turns on this and nothing else: "remove the table" is correct
       * advice only for the run that put the table there. An edit that merely set
       * `model_reasoning_summary` beside a table the user already had must never
       * tell them to delete it.
       */
      addedTable: boolean
      /** The migration also dropped `[mcp_servers.telem.*]` sub-tables (a stale
       * `env` key copy among them), so the undo line has to say so. */
      /** An EXISTING hosted table pointing at CODEX_URL had its Authorization line
       * brought in line with the effective key — added when it had none, replaced
       * when it carried a stale one. Nothing else in that table was touched. */
      reconciled: boolean
      /** A hosted telem table was written but WITHOUT the auth header (no key was
       * available), so the run must tell the user to add their key by hand. */
      keylessHostedTable: boolean
      /** A key WAS provided but did not match the tlm_ urlsafe-base64 charset, so the
       * inline auth header was REFUSED (never built from an unvalidated value) and the
       * url-only table written instead. The run should tell the user their key looks
       * malformed — a distinct reason from "no key was available". Only meaningful
       * together with `keylessHostedTable`. */
      keyMalformed: boolean
      /** At least one `[hooks.state."…"]` trust entry was written or brought in
       * line with the plugin's current hook hash. */
      hookTrustWritten: boolean
      /** Every requested trust entry is now in the file with the right hash —
       * whether this edit wrote it or it already matched. This, not
       * `hookTrustWritten`, is what says "the hook will actually run": a plugin
       * VERSION bump whose hooks.json did not change re-installs the plugin while
       * leaving the trust byte-identical, and calling that untrusted would send the
       * user to the `/plugin` UI for nothing. */
      hookTrustSatisfied: boolean
      /** At least one trust entry was NOT written because this file already defines
       * `hooks`/`hooks.state` in a form a line editor must not rewrite (a top-level
       * pair, a `[hooks]`/`[hooks.state]` header, a multi-line value). The run tells
       * the user to trust the hook in Codex's `/plugin` UI instead — the
       * abstain-rather-than-corrupt rule. */
      hookTrustAbstained: boolean
    }
  | { status: "abort"; reason: string }

/**
 * The telem server's table, as PARTS — the identity every comparison in this file
 * uses. The joined string below is for printing only.
 *
 * The two are not interchangeable. `[mcp_servers."telem.backup"]` is a table whose
 * SECOND part is the literal `telem.backup` — a different server, nothing to do with
 * ours — yet it joins to the same `mcp_servers.telem.backup` string that a real
 * `[mcp_servers.telem.backup]` sub-table joins to. Comparing joined names therefore
 * aliases a stranger's server into our own region, and a consented stdio migration
 * DELETES that region. Parts never alias: a quoted segment is one part, always.
 */
const CODEX_TABLE_PARTS = ["mcp_servers", "telem"] as const
export const CODEX_TABLE = CODEX_TABLE_PARTS.join(".")
export const CODEX_WEB_SEARCH_KEY = "web_search"
/** The hosted Telem MCP endpoint Codex's remote server points at. */
export const CODEX_URL = "https://mcp.telem.ai/mcp"
/**
 * A real tlm_ key is urlsafe-base64: letters, digits, `_` and `-`, nothing else. The
 * key is interpolated verbatim into an INLINE TOML `http_headers` table, so any other
 * character (a `"`, a newline, whitespace) could graft arbitrary TOML into
 * config.toml (e.g. a whole `[mcp_servers.evil]` table). We charset-validate-and-
 * refuse rather than TOML-escape: a value outside this charset is never a real key,
 * so refusing to build the header from it and surfacing it to the user is the safer
 * move than silently escaping a red flag. See `planCodexConfig`.
 */
export const CODEX_KEY_CHARSET = /^[A-Za-z0-9_-]+$/
// The reasoning-capture hook (codex-reasoning.ts) needs Codex to emit summaries;
// without this, `model_reasoning_summary` defaults to "none" and every summary is
// empty, so the hook captures nothing. ADDITIVE — it turns nothing off — so unlike
// web_search it is added by default. Only ADD it when absent: a user who set it to
// any value ("auto", "concise", …) keeps theirs, reported unchanged.
export const CODEX_REASONING_SUMMARY_KEY = "model_reasoning_summary"
/** Where Codex records per-hook trust: `[hooks.state."<hook key>"]`. */
export const CODEX_HOOK_STATE_PATH = ["hooks", "state"] as const

/**
 * The shape of an existing `[mcp_servers.telem]` table, so the run can decide
 * whether to prompt for a stdio→hosted migration BEFORE it edits anything:
 *   - `absent`  — no telem table (a fresh add writes the hosted remote form)
 *   - `stdio`   — a `command = …` table (migration candidate, consent-gated)
 *   - `remote`  — already has a `url` (hosted; left untouched)
 *   - `unparseable` — the file will not scan (the edit will abort naming the path)
 */
export type CodexTelemForm = "absent" | "stdio" | "remote" | "unparseable"

/**
 * One classified line.
 *
 * `parts` is the IDENTITY of a header or a pair — one entry per key segment, quotes
 * stripped. `name`/`key` are the same parts joined with dots, and they are for reading
 * and reporting ONLY: joining is lossy, because a quoted segment may contain dots of
 * its own, so `[mcp_servers."telem.backup"]` and `[mcp_servers.telem.backup]` produce
 * the same string for two entirely different tables. Compare parts (isKeyPath /
 * isUnderKeyPath); never compare, prefix-match or print the joined form.
 */
type TomlLine =
  | { kind: "blank" | "comment" | "continuation"; text: string }
  | { kind: "header"; text: string; name: string; parts: string[] }
  | { kind: "pair"; text: string; key: string; parts: string[] }

type TomlScan = { ok: true; lines: TomlLine[] } | { ok: false; error: string }

/**
 * Split a dotted TOML key into its parts, unquoting each.
 *
 * The split is QUOTE-AWARE, and that is load-bearing rather than pedantic: the hook
 * trust tables are keyed on `[hooks.state."telem@telem:hooks/hooks.json:pre_tool_use:0:0"]`,
 * whose quoted segment contains dots of its own. A naive `.split(".")` shreds it (and
 * would equally shred a user's `[mcp_servers."my.server"]`).
 */
function splitDotted(raw: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += char + (raw[index + 1] ?? "")
        index += 1
      } else if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ".") {
      parts.push(current.trim())
      current = ""
    } else current += char
  }
  parts.push(current.trim())
  return parts
}

/**
 * Do these key parts name EXACTLY this path? The comparison every table-identity
 * test in this file runs on, instead of `joined === "a.b"`.
 */
function isKeyPath(parts: readonly string[], wanted: readonly string[]): boolean {
  return parts.length === wanted.length && wanted.every((part, index) => parts[index] === part)
}

/**
 * Do these key parts name something strictly BELOW this path — i.e. is `wanted` a
 * real path PREFIX of them? Replaces `joined.startsWith("a.b.")`, which cannot tell
 * a sub-table apart from a sibling whose quoted name happens to contain a dot.
 */
function isUnderKeyPath(parts: readonly string[], wanted: readonly string[]): boolean {
  return parts.length > wanted.length && wanted.every((part, index) => parts[index] === part)
}

/** A part that needs no quotes as a TOML key. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * Key parts re-rendered the way TOML spells them, re-quoting any part that is not a
 * bare key. Printing `parts.join(".")` instead would report `[mcp_servers.telem."my.env"]`
 * as `[mcp_servers.telem.my.env]` — a path that names a different table than the one
 * the message is about.
 */
function renderKeyParts(parts: readonly string[]): string {
  return parts
    .map((part) => {
      if (BARE_KEY.test(part)) return part
      return part.includes('"') ? `'${part}'` : `"${part}"`
    })
    .join(".")
}

/**
 * Classify every line.
 *
 * Two kinds of value legally span lines and both are tracked, because mistaking
 * either for a syntax error would make this planner ABORT on a perfectly good
 * config — printing manual instructions to someone whose file was fine:
 *
 *   - multi-line strings (`"""` / `'''`)
 *   - multi-line arrays (`notify = [`  …  `]`), whose inner lines are bare values,
 *     blanks and comments that no key = value rule would ever match
 *
 * An unterminated one of either is an error rather than a silently truncated file.
 */
export function scanToml(text: string): TomlScan {
  const lines: TomlLine[] = []
  let open: '"""' | "'''" | null = null
  let openArrays = 0
  const rawLines = text.split("\n")
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    if (open) {
      lines.push({ kind: "continuation", text: raw })
      if (raw.includes(open)) open = null
      continue
    }
    if (openArrays > 0) {
      lines.push({ kind: "continuation", text: raw })
      openArrays = Math.max(0, openArrays + bracketDelta(raw))
      continue
    }
    const trimmed = raw.trim()
    if (trimmed === "") {
      lines.push({ kind: "blank", text: raw })
      continue
    }
    if (trimmed.startsWith("#")) {
      lines.push({ kind: "comment", text: raw })
      continue
    }
    if (trimmed.startsWith("[")) {
      const close = trimmed.lastIndexOf("]")
      if (close === -1) return { ok: false, error: `unterminated table header on line ${index + 1}` }
      const inner = trimmed.slice(trimmed.startsWith("[[") ? 2 : 1, trimmed.endsWith("]]") ? close - 1 : close)
      const headerParts = splitDotted(inner)
      lines.push({ kind: "header", text: raw, name: headerParts.join("."), parts: headerParts })
      continue
    }
    const equals = indexOfAssignment(trimmed)
    if (equals === -1) return { ok: false, error: `line ${index + 1} is neither a comment, a table header, nor key = value` }
    const keyParts = splitDotted(trimmed.slice(0, equals))
    const key = keyParts.join(".")
    const value = trimmed.slice(equals + 1).trim()
    if (value.startsWith('"""') && !closesOnSameLine(value, '"""')) open = '"""'
    else if (value.startsWith("'''") && !closesOnSameLine(value, "'''")) open = "'''"
    else openArrays = Math.max(0, bracketDelta(value))
    lines.push({ kind: "pair", text: raw, key, parts: keyParts })
  }
  if (open) return { ok: false, error: "unterminated multi-line string" }
  if (openArrays > 0) return { ok: false, error: "unterminated array" }
  return { ok: true, lines }
}

function closesOnSameLine(value: string, delimiter: string): boolean {
  return value.slice(delimiter.length).includes(delimiter)
}

/** `[` minus `]` outside strings and comments — how many arrays this line leaves open. */
function bracketDelta(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === "\\" && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "#") break
    else if (char === "[") depth += 1
    else if (char === "]") depth -= 1
  }
  return depth
}

/** Index of the `=` that assigns, skipping any inside a quoted key. */
function indexOfAssignment(line: string): number {
  let quote: string | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "=") return index
  }
  return -1
}

/** Replace a pair line's value, keeping its key spacing and any trailing comment. */
function replaceValue(line: string, value: string): string {
  const equals = indexOfAssignment(line)
  if (equals === -1) return line
  const after = line.slice(equals + 1)
  const comment = commentIndex(after)
  const tail = comment === -1 ? "" : after.slice(comment)
  return `${line.slice(0, equals + 1)} ${value}${tail ? ` ${tail.trim()}` : ""}`
}

/** Index of a `#` that starts a comment (i.e. one that is not inside a string). */
function commentIndex(text: string): number {
  let quote: string | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "#") return index
  }
  return -1
}

function currentValue(line: string): string {
  const equals = indexOfAssignment(line)
  if (equals === -1) return ""
  const after = line.slice(equals + 1)
  const comment = commentIndex(after)
  return (comment === -1 ? after : after.slice(0, comment)).trim()
}

/**
 * The lines that ARE the hosted remote server, in write order. The `url` is always
 * present; the inline `http_headers` line is written ONLY when a key is available,
 * carrying it as a REAL Bearer value (the hosted server authenticates per request).
 * With no key we write the url alone — never an empty/placeholder Bearer — and the
 * run prints a note to add the header by hand.
 */
function remoteTableBody(apiKey: string | null): TomlLine[] {
  const body: TomlLine[] = [{ kind: "pair", text: `url = "${CODEX_URL}"`, key: "url", parts: ["url"] }]
  if (apiKey) body.push(authHeaderLine(apiKey))
  return body
}

/** The one inline `http_headers` line, so a fresh write and a reconcile agree. */
function authHeaderLine(apiKey: string): TomlLine {
  return {
    kind: "pair",
    text: `http_headers = { Authorization = "Bearer ${apiKey}" }`,
    key: "http_headers",
    parts: ["http_headers"],
  }
}

/** The bare text of the remote table, header included — used for a fresh write. */
function remoteTableText(apiKey: string | null): string {
  return `[${CODEX_TABLE}]\n${remoteTableBody(apiKey)
    .map((line) => line.text)
    .join("\n")}\n`
}

/**
 * The `[headerIdx+1, end)` span of scanned lines that belongs to the table whose
 * header is at `headerIdx` — everything up to the next header or EOF.
 */
function tableSpanEnd(lines: TomlLine[], headerIdx: number): number {
  let end = headerIdx + 1
  while (end < lines.length && lines[end].kind !== "header") end += 1
  return end
}

/**
 * The telem server as it sits in the file: its header, where its OWN lines stop,
 * and where the whole REGION stops — the parent table plus every contiguous
 * `[mcp_servers.telem.*]` sub-table under it.
 *
 * The two ends are not the same thing and both are load-bearing. `ownEnd` is what
 * `url`/`command` are read from: a `url` inside `[mcp_servers.telem.env]` is
 * `telem.env.url`, somebody else's key entirely, and counting it would misclassify
 * the server. `regionEnd` is what a consented migration REPLACES, because a
 * `[mcp_servers.telem.env]` left standing keeps a copy of the old key the user
 * believes the migration took away.
 */
type TelemTable = {
  headerIdx: number
  /** End of the parent table's own lines — the next header of any name, or EOF. */
  ownEnd: number
  /** End of the parent plus its contiguous `mcp_servers.telem.*` sub-tables. */
  regionEnd: number
  /** The parent table's OWN pairs; a sub-table's pairs are not telem's. */
  pairs: Extract<TomlLine, { kind: "pair" }>[]
  /** The sub-tables inside the region, as key PARTS, in file order. */
  subTables: string[][]
}

function findTelemTable(lines: TomlLine[]): TelemTable | null {
  // Identity by parts: `["mcp_servers.telem"]` is a top-level table literally named
  // `mcp_servers.telem`, NOT our nested one, and joined names cannot tell them apart.
  const headerIdx = lines.findIndex((line) => line.kind === "header" && isKeyPath(line.parts, CODEX_TABLE_PARTS))
  if (headerIdx === -1) return null
  const ownEnd = tableSpanEnd(lines, headerIdx)
  const subTables: string[][] = []
  let regionEnd = ownEnd
  while (regionEnd < lines.length) {
    const line = lines[regionEnd]
    // Likewise for the region: `[mcp_servers."telem.backup"]` is a SIBLING server
    // whose name contains a dot, not a sub-table of ours. Swallowing it here is what
    // made a consented migration delete an unrelated server.
    if (line.kind !== "header" || !isUnderKeyPath(line.parts, CODEX_TABLE_PARTS)) break
    subTables.push(line.parts)
    regionEnd = tableSpanEnd(lines, regionEnd)
  }
  const pairs = lines
    .slice(headerIdx + 1, ownEnd)
    .filter((line): line is Extract<TomlLine, { kind: "pair" }> => line.kind === "pair")
  return { headerIdx, ownEnd, regionEnd, pairs, subTables }
}

/** The text of a single-line TOML string value, unquoted; null if it is not one. */
function stringValue(raw: string): string | null {
  const trimmed = raw.trim()
  for (const quote of ['"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote) && !trimmed.startsWith(quote.repeat(3))) {
      return trimmed.slice(1, -1)
    }
  }
  return null
}

/**
 * The `Authorization = "Bearer <value>"` part of an inline `http_headers` table:
 * head, the current value, and the closing quote. Case-insensitive on the key name
 * and tolerant of a quoted key, because both spellings are legal TOML — but the
 * value is captured, never assumed, so an unreadable header is left alone instead
 * of being guessed at.
 */
const HOSTED_AUTH_BEARER = /((?:"Authorization"|'Authorization'|Authorization)\s*=\s*")Bearer\s+([^"]*)(")/i

/**
 * Bring an EXISTING hosted table's auth header in line with the effective key.
 *
 * This is the flow that used to rot silently: a keyless first run writes the url
 * alone, the user gets a key later (`--login` stores it but touches no surface),
 * and every re-run then classified the table `remote` → "unchanged" while the
 * hosted MCP 401s. Key rotation is the same shape — credentials.json gets the new
 * key, config.toml keeps the revoked Bearer.
 *
 * The don't-touch-the-user's-url stance is preserved exactly: this fires ONLY when
 * the table's url is CODEX_URL verbatim, and it rewrites ONLY the Authorization
 * line. Anything it cannot edit as one line — an `http_headers` sub-table, a dotted
 * `http_headers.x` key, a multi-line value, an Authorization it cannot parse — is
 * left untouched rather than double-defined or clobbered.
 *
 * Mutates `lines`; returns what it did, or null for "nothing to do".
 */
function reconcileHostedAuth(
  lines: TomlLine[],
  telem: TelemTable,
  apiKey: string | null,
): "added" | "replaced" | null {
  if (!apiKey) return null
  const urlIndex = lines.findIndex(
    (line, index) =>
      index > telem.headerIdx && index < telem.ownEnd && line.kind === "pair" && isKeyPath(line.parts, ["url"]),
  )
  if (urlIndex === -1) return null
  if (stringValue(currentValue(lines[urlIndex].text)) !== CODEX_URL) return null

  // `[mcp_servers.telem.http_headers]` and `http_headers.X = …` both define the
  // name as a table; adding a second inline `http_headers` beside either would
  // define it twice and break the file. Abstain, exactly like the web_search flip.
  if (telem.subTables.some((parts) => isKeyPath(parts, [...CODEX_TABLE_PARTS, "http_headers"]))) return null
  if (telem.pairs.some((pair) => isUnderKeyPath(pair.parts, ["http_headers"]))) return null

  const headerIndex = lines.findIndex(
    (line, index) =>
      index > telem.headerIdx && index < telem.ownEnd && line.kind === "pair" && isKeyPath(line.parts, ["http_headers"]),
  )
  if (headerIndex === -1) {
    lines.splice(urlIndex + 1, 0, authHeaderLine(apiKey))
    return "added"
  }
  // A multi-line value continues onto the following lines; a one-line rewrite would
  // strand them as invalid TOML.
  if (lines[headerIndex + 1]?.kind === "continuation") return null
  const text = lines[headerIndex].text
  const match = HOSTED_AUTH_BEARER.exec(text)
  if (!match) return null
  if (match[2] === apiKey) return null
  lines[headerIndex] = {
    kind: "pair",
    key: "http_headers",
    parts: ["http_headers"],
    // A function replacer, not a `$1…` string: the key is charset-validated, but a
    // replacement string is one `$&` away from meaning something else entirely.
    text: text.replace(HOSTED_AUTH_BEARER, (_all, head: string, _old: string, tail: string) => `${head}Bearer ${apiKey}${tail}`),
  }
  return "replaced"
}

/** One pre-granted hook trust entry: Codex's own hook key, and its current hash.
 * Produced by codex-plugin.ts, which is where the derivation is explained. */
export type CodexHookTrustEntry = { key: string; hash: string }

/**
 * A key safe to write as a TOML quoted key. Hook keys are built by us out of a
 * plugin ref, a relative path and two indices, so this can only fail if something
 * upstream changed shape — and a `"` or a newline in a quoted key would graft
 * arbitrary TOML into the user's config, exactly the hazard CODEX_KEY_CHARSET
 * guards on the auth header. Refuse rather than escape.
 */
const HOOK_KEY_SAFE = /^[^"\\\n\r]+$/

/** The `[hooks.state."<key>"]` table for one entry, header included. */
function hookTrustTableText(entry: CodexHookTrustEntry): string {
  return `[${CODEX_HOOK_STATE_PATH.join(".")}."${entry.key}"]\nenabled = true\ntrusted_hash = "${entry.hash}"\n`
}

/** Do these header parts name exactly `hooks.state."<key>"`? */
function isHookStateHeader(parts: readonly string[], key: string): boolean {
  return isKeyPath(parts, [...CODEX_HOOK_STATE_PATH, key])
}

/**
 * Does this file already define `hooks` or `hooks.state` in a shape we did NOT write
 * — one that appending a `[hooks.state."<key>"]` table would DOUBLE-DEFINE?
 *
 * A duplicate definition is not a cosmetic problem: Codex refuses the WHOLE
 * config.toml, so every setting in it — the telem server included — stops working.
 * The only shape this line editor can reconcile is the exact header table it writes
 * itself, `[hooks.state."<full key>"]`; everything else abstains:
 *
 *   hooks = { … }              a top-level pair defining the name `hooks`
 *   hooks.state = { … }        …and its dotted spellings, at any depth. TOML CLOSES
 *   hooks.state.x = 1          a table defined by dotted keys, so no later
 *                              `[hooks.state."k"]` header may extend it.
 *   [hooks] / [hooks.state]    a header table our append would land inside
 *   [hooks]\nstate = { … }     the same definition, spelled under a header
 *
 * Header context is what makes the pair rule correct in both directions: a
 * `hooks = { … }` under `[foo]` is `foo.hooks` and is none of our business, while a
 * `state = { … }` under `[hooks]` really is `hooks.state` — and the `[hooks]` header
 * above it has already answered for that one.
 */
function definesHooksUnrecognizably(lines: readonly TomlLine[]): boolean {
  let header: readonly string[] = []
  for (const line of lines) {
    if (line.kind === "header") {
      header = line.parts
      if (isKeyPath(header, ["hooks"]) || isKeyPath(header, CODEX_HOOK_STATE_PATH)) return true
      continue
    }
    // Only a pair at the document root can define the top-level `hooks` name; under a
    // header it belongs to that header's table, and the two headers that would make it
    // ours have already returned above.
    if (line.kind === "pair" && header.length === 0 && line.parts[0] === "hooks") return true
  }
  return false
}

/**
 * Write (or reconcile) the pre-granted hook trust entries.
 *
 * Absent entry → a new table appended at the end, `enabled = true` and the hash.
 * Present entry → ONLY `trusted_hash` is rewritten, and only when it differs: an
 * `enabled = false` the user set in Codex's UI is their decision and survives, and a
 * hash that already matches is left byte-identical so a re-run stages nothing.
 *
 * Anything this line editor cannot safely rewrite — any definition of `hooks` or
 * `hooks.state` in a shape we did not write (see `definesHooksUnrecognizably`), a
 * multi-line `trusted_hash` — is ABSTAINED rather than clobbered, and the caller tells
 * the user to trust the hook in the `/plugin` UI instead.
 *
 * Mutates `lines`; returns what happened.
 */
function applyHookTrust(
  lines: TomlLine[],
  entries: readonly CodexHookTrustEntry[],
  changes: string[],
): { written: boolean; abstained: boolean; satisfied: boolean } {
  let written = false
  let abstained = false
  // Any pre-existing definition of `hooks`/`hooks.state` we did not write ourselves:
  // appending our header table beside one of those defines the name twice, and Codex
  // then refuses the ENTIRE config.toml.
  const foreignState = definesHooksUnrecognizably(lines)
  for (const entry of entries) {
    if (!HOOK_KEY_SAFE.test(entry.key) || !HOOK_KEY_SAFE.test(entry.hash)) {
      abstained = true
      continue
    }
    if (foreignState) {
      abstained = true
      continue
    }
    const headerIdx = lines.findIndex((line) => line.kind === "header" && isHookStateHeader(line.parts, entry.key))
    if (headerIdx === -1) {
      while (lines.length && lines[lines.length - 1].kind === "blank") lines.pop()
      if (lines.length) lines.push({ kind: "blank", text: "" })
      const parts = [...CODEX_HOOK_STATE_PATH, entry.key]
      lines.push({
        kind: "header",
        text: `[${CODEX_HOOK_STATE_PATH.join(".")}."${entry.key}"]`,
        name: parts.join("."),
        parts,
      })
      lines.push({ kind: "pair", text: "enabled = true", key: "enabled", parts: ["enabled"] })
      lines.push({
        kind: "pair",
        text: `trusted_hash = "${entry.hash}"`,
        key: "trusted_hash",
        parts: ["trusted_hash"],
      })
      changes.push("trust the telem Codex hook")
      written = true
      continue
    }
    const end = tableSpanEnd(lines, headerIdx)
    const hashIdx = lines.findIndex(
      (line, index) => index > headerIdx && index < end && line.kind === "pair" && isKeyPath(line.parts, ["trusted_hash"]),
    )
    if (hashIdx === -1) {
      lines.splice(headerIdx + 1, 0, {
        kind: "pair",
        text: `trusted_hash = "${entry.hash}"`,
        key: "trusted_hash",
        parts: ["trusted_hash"],
      })
      changes.push("trust the telem Codex hook")
      written = true
      continue
    }
    if (lines[hashIdx + 1]?.kind === "continuation") {
      abstained = true
      continue
    }
    if (stringValue(currentValue(lines[hashIdx].text)) === entry.hash) continue
    lines[hashIdx] = {
      kind: "pair",
      key: "trusted_hash",
      parts: ["trusted_hash"],
      text: replaceValue(lines[hashIdx].text, `"${entry.hash}"`),
    }
    changes.push(`re-trust the telem Codex hook (its hook definition changed)`)
    written = true
  }
  // Every entry that did not abstain is now present with the right hash — either it
  // already was (the loop `continue`d) or this pass wrote it.
  return { written, abstained, satisfied: entries.length > 0 && !abstained }
}

/**
 * Which shape an existing `[mcp_servers.telem]` table takes, so the run can prompt
 * for a stdio→hosted migration only when there is a stdio table to migrate. A
 * table carrying a `url` is remote (left alone); one carrying only `command` is
 * stdio; a file that will not scan is `unparseable`; no table at all is `absent`.
 */
export function classifyCodexTelemTable(source: string | null): CodexTelemForm {
  if (source === null) return "absent"
  const scan = scanToml(source)
  if (!scan.ok) return "unparseable"
  // The SAME inspection planCodexConfig uses, so the prompt the run shows and the
  // edit it then makes can never disagree about what is in the file.
  const telem = findTelemTable(scan.lines)
  if (telem === null) return "absent"
  if (telem.pairs.some((pair) => isKeyPath(pair.parts, ["url"]))) return "remote"
  if (telem.pairs.some((pair) => isKeyPath(pair.parts, ["command"]))) return "stdio"
  // A table with neither key (empty, or something exotic) is treated as remote —
  // "already present, do not clobber" — the same conservative stance as before.
  return "remote"
}

/**
 * Is Codex's built-in web search ALREADY off?
 *
 * Read with the same top-level-scalar rule `planCodexConfig` writes with: a bare
 * `web_search = "disabled"` above the first table header. Anything else — absent, a
 * different value, a `[web_search]` table, a file that will not scan — is "not
 * disabled", which keeps the question honest in exactly the cases where answering it
 * would change something. It exists so the wizard can SKIP a consent prompt whose
 * yes-answer is a guaranteed no-op.
 */
export function codexWebSearchDisabled(source: string | null): boolean {
  if (source === null) return false
  const scan = scanToml(source)
  if (!scan.ok) return false
  const firstHeader = scan.lines.findIndex((line) => line.kind === "header")
  const limit = firstHeader === -1 ? scan.lines.length : firstHeader
  const index = scan.lines.findIndex(
    (line, at) => at < limit && line.kind === "pair" && isKeyPath(line.parts, [CODEX_WEB_SEARCH_KEY]),
  )
  if (index === -1) return false
  return stringValue(currentValue(scan.lines[index].text)) === "disabled"
}

export function planCodexConfig(
  source: string | null,
  options: {
    disableWebSearch: boolean
    captureReasoning?: boolean
    /** The resolved credential, written into the table's `http_headers` as a real
     * Bearer value. `null`/absent → the table is written WITHOUT the header. */
    apiKey?: string | null
    /** Consent to rewrite an existing stdio (`command = …`) table to the hosted
     * remote. Without it, a stdio table is left as it is. */
    /** Pre-granted trust for the Codex plugin's hooks, derived in codex-plugin.ts.
     * Empty/absent → no `[hooks.state."…"]` table is touched at all. */
    hookTrust?: readonly CodexHookTrustEntry[]
  },
  path: string,
): CodexEdit {
  const rawApiKey = options.apiKey ?? null
  // A key that is not the tlm_ urlsafe-base64 charset must NEVER be interpolated into
  // the inline http_headers table — a crafted value (a `"` plus a newline) would
  // inject arbitrary TOML. Refuse the header and fall back to the keyless url-only
  // table; the run then surfaces a "looks malformed" note. An empty/blank value is
  // simply "no key", not malformed.
  const keyMalformed = rawApiKey !== null && rawApiKey.length > 0 && !CODEX_KEY_CHARSET.test(rawApiKey)
  const apiKey = keyMalformed ? null : rawApiKey
  const manual = `add\n\n  [${CODEX_TABLE}]\n  url = "${CODEX_URL}"\n\nto ${path} by hand`

  if (source === null) {
    const changes = [`create with [${CODEX_TABLE}] (hosted url${apiKey ? " + auth header" : ""})`]
    // Bare top-level keys must precede the first table header, so both go in the head.
    let head = ""
    if (options.disableWebSearch) {
      head += `${CODEX_WEB_SEARCH_KEY} = "disabled"\n`
      changes.push(`set ${CODEX_WEB_SEARCH_KEY} = "disabled"`)
    }
    if (options.captureReasoning) {
      head += `${CODEX_REASONING_SUMMARY_KEY} = "detailed"\n`
      changes.push(`set ${CODEX_REASONING_SUMMARY_KEY} = "detailed"`)
    }
    if (head) head += "\n"
    // A brand-new file has nothing to reconcile, so the trust tables are simply
    // appended — but through the same applyHookTrust as an existing file, so the
    // abstain guards and the exact table shape have one implementation. The text we
    // just built is TOML we wrote ourselves, so re-scanning it cannot fail; if it
    // somehow did, the trust tables are skipped rather than the install broken.
    const freshScan = scanToml(`${head}${remoteTableText(apiKey)}`)
    const fresh: TomlLine[] = freshScan.ok ? freshScan.lines.slice(0, -1) : []
    const trust = freshScan.ok
      ? applyHookTrust(fresh, options.hookTrust ?? [], changes)
      : { written: false, abstained: (options.hookTrust ?? []).length > 0, satisfied: false }
    return {
      status: "write",
      created: true,
      changes,
      addedTable: true,
      reconciled: false,
      keylessHostedTable: !apiKey,
      keyMalformed,
      hookTrustWritten: trust.written,
      hookTrustSatisfied: trust.satisfied,
      hookTrustAbstained: trust.abstained,
      contents: freshScan.ok
        ? `${fresh.map((line) => line.text).join("\n")}\n`
        : `${head}${remoteTableText(apiKey)}`,
    }
  }

  const scan = scanToml(source)
  if (!scan.ok) {
    return { status: "abort", reason: `${path} could not be parsed (${scan.error}); ${manual}` }
  }

  const lines = scan.lines.slice()
  const changes: string[] = []

  if (options.disableWebSearch) {
    const firstHeader = lines.findIndex((line) => line.kind === "header")
    const limit = firstHeader === -1 ? lines.length : firstHeader
    // A `[web_search]` / `[web_search.x]` TABLE means the key is not a scalar this
    // line editor can flip: adding a top-level `web_search = "disabled"` beside a
    // table of the same name would define it twice and break the file. Abstain.
    const tableForm = lines.some(
      (line) =>
        line.kind === "header" &&
        (isKeyPath(line.parts, [CODEX_WEB_SEARCH_KEY]) || isUnderKeyPath(line.parts, [CODEX_WEB_SEARCH_KEY])),
    )
    // A dotted-key pair `web_search.<sub> = …` is a valid TOML pair that ALSO defines
    // `web_search` — as a table — so it is the header-table case in another spelling.
    // Adding a bare `web_search = "disabled"` beside it would define the name twice
    // and break the file, exactly as the `[web_search]` header would. It is top-level
    // only when it sits before the first header, like the scalar form. Abstain.
    const dottedForm = lines.some(
      (line, index) =>
        index < limit && line.kind === "pair" && isUnderKeyPath(line.parts, [CODEX_WEB_SEARCH_KEY]),
    )
    const existing = lines.findIndex(
      (line, index) => index < limit && line.kind === "pair" && isKeyPath(line.parts, [CODEX_WEB_SEARCH_KEY]),
    )
    // A multi-line value (a `"""` string or a `[` array) shows up as continuation
    // lines after the pair. `replaceValue` rewrites only the pair's first line, so
    // it would strand those continuation lines as invalid TOML. Rather than corrupt
    // the file, abort with the exact line to add — the openclaw/credentials
    // abort-vs-clobber rule.
    const multiline = existing !== -1 && lines[existing + 1]?.kind === "continuation"
    if (tableForm || dottedForm || multiline) {
      const shape = tableForm || dottedForm ? "table" : "multi-line"
      return {
        status: "abort",
        reason: `${path} already defines ${CODEX_WEB_SEARCH_KEY} as a ${shape} value this installer will not rewrite; set \`${CODEX_WEB_SEARCH_KEY} = "disabled"\` in ${path} by hand`,
      }
    }
    if (existing === -1) {
      // A bare key BELOW a table header would belong to that table, not to the
      // document — so it goes before the first header, or at the end when there
      // is none.
      const inserted: TomlLine = {
        kind: "pair",
        text: `${CODEX_WEB_SEARCH_KEY} = "disabled"`,
        key: CODEX_WEB_SEARCH_KEY,
        parts: [CODEX_WEB_SEARCH_KEY],
      }
      lines.splice(limit, 0, inserted, { kind: "blank", text: "" })
      changes.push(`set ${CODEX_WEB_SEARCH_KEY} = "disabled"`)
    } else if (currentValue(lines[existing].text) !== '"disabled"') {
      const previous = currentValue(lines[existing].text)
      lines[existing] = {
        kind: "pair",
        key: CODEX_WEB_SEARCH_KEY,
        parts: [CODEX_WEB_SEARCH_KEY],
        text: replaceValue(lines[existing].text, '"disabled"'),
      }
      changes.push(`set ${CODEX_WEB_SEARCH_KEY} = "disabled" (was ${previous || "empty"})`)
    }
  }

  if (options.captureReasoning) {
    const firstHeader = lines.findIndex((line) => line.kind === "header")
    const limit = firstHeader === -1 ? lines.length : firstHeader
    // Present in ANY form — a top-level scalar OR a `[model_reasoning_summary(.x)]`
    // table — means leave it: the user chose it, and a second definition would break
    // the file. Only a genuinely absent key is added, as a bare key before the first
    // header (below one, it would belong to that table, not the document).
    const tableForm = lines.some(
      (line) =>
        line.kind === "header" &&
        (isKeyPath(line.parts, [CODEX_REASONING_SUMMARY_KEY]) ||
          isUnderKeyPath(line.parts, [CODEX_REASONING_SUMMARY_KEY])),
    )
    // A dotted-key pair `model_reasoning_summary.<sub> = …` (e.g.
    // `model_reasoning_summary.enabled = true`) is a valid TOML pair that ALSO defines
    // the name — as a table — so it is "present in a form we must not touch", the same
    // as the header-table form. Injecting a second bare `model_reasoning_summary =
    // "detailed"` beside it would redefine the name as a string too and break the
    // file. It is top-level only when it precedes the first header, like the scalar.
    const dottedForm = lines.some(
      (line, index) =>
        index < limit && line.kind === "pair" && isUnderKeyPath(line.parts, [CODEX_REASONING_SUMMARY_KEY]),
    )
    const existing = lines.findIndex(
      (line, index) => index < limit && line.kind === "pair" && isKeyPath(line.parts, [CODEX_REASONING_SUMMARY_KEY]),
    )
    if (!tableForm && !dottedForm && existing === -1) {
      lines.splice(
        limit,
        0,
        {
          kind: "pair",
          text: `${CODEX_REASONING_SUMMARY_KEY} = "detailed"`,
          key: CODEX_REASONING_SUMMARY_KEY,
          parts: [CODEX_REASONING_SUMMARY_KEY],
        },
        { kind: "blank", text: "" },
      )
      changes.push(`set ${CODEX_REASONING_SUMMARY_KEY} = "detailed"`)
    }
  }

  let addedTable = false
  let reconciled = false
  let wroteHostedTable = false
  const telem = findTelemTable(lines)
  if (telem === null) {
    // No telem table yet: append the hosted remote form.
    while (lines.length && lines[lines.length - 1].kind === "blank") lines.pop()
    if (lines.length) lines.push({ kind: "blank", text: "" })
    lines.push({ kind: "header", text: `[${CODEX_TABLE}]`, name: CODEX_TABLE, parts: [...CODEX_TABLE_PARTS] })
    lines.push(...remoteTableBody(apiKey))
    changes.push(`add [${CODEX_TABLE}] (hosted url${apiKey ? " + auth header" : ""})`)
    addedTable = true
    wroteHostedTable = true
  } else {
    // A telem table exists. A `url` table is already remote and gets its auth header
    // reconciled below. A `command` (stdio) table is left exactly as it is: the local
    // server it starts is deprecated and `telem-sdk` no longer ships `telem-mcp`, but
    // silently rewriting a table this installer did not write is not its call.
    const isStdio =
      !telem.pairs.some((pair) => isKeyPath(pair.parts, ["url"])) &&
      telem.pairs.some((pair) => isKeyPath(pair.parts, ["command"]))
    if (!isStdio) {
      // Already hosted. The url stays the user's, but an auth header that is absent
      // or stale is reconciled with the effective key — otherwise a keyless first
      // run, or a rotated key, leaves this table 401ing forever under a "unchanged".
      const outcome = reconcileHostedAuth(lines, telem, apiKey)
      if (outcome !== null) {
        changes.push(
          outcome === "added"
            ? `add the Telem auth header to [${CODEX_TABLE}]`
            : `replace the stale Telem auth header in [${CODEX_TABLE}]`,
        )
        reconciled = true
      }
    }
  }

  const trust = applyHookTrust(lines, options.hookTrust ?? [], changes)

  if (!changes.length) {
    return {
      status: "unchanged",
      reason: `${path} already has [${CODEX_TABLE}]`,
      hookTrustSatisfied: trust.satisfied,
      hookTrustAbstained: trust.abstained,
    }
  }
  const contents = `${lines.map((line) => line.text).join("\n").replace(/\n+$/, "")}\n`
  return {
    status: "write",
    created: false,
    contents,
    changes,
    addedTable,
    reconciled,
    keylessHostedTable: wroteHostedTable && !apiKey,
    keyMalformed,
    hookTrustWritten: trust.written,
    hookTrustSatisfied: trust.satisfied,
    hookTrustAbstained: trust.abstained,
  }
}
