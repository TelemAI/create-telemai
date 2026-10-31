// The Muse CLI surface's file edit: `~/.config/muse/settings.json`.
//
// Muse speaks remote MCP with headers, so it points at the HOSTED Telem MCP the same
// way Codex does — one JSON file, three kinds of change, and the KEY is in no command:
//
//  * `mcpServers.telem` — `streamable_http` to https://mcp.telem.ai/mcp with the key
//    as a LITERAL `Authorization: Bearer <key>` header, so the file is a 0600 secret
//    write. Never a `${VAR}` reference: Muse turns off EVERY MCP server for the run,
//    with no error, when a header names an unset variable (probe, 2026-10-26).
//    `mode: "optional"`, because Muse's default `required` aborts the whole run when
//    the server cannot be reached. An existing entry whose url is ours has its
//    Authorization and routing headers brought in line with this run (a rotated key,
//    a changed answer) and gains `User-Agent: telem-muse` if it has none — the hosted
//    server's CDN refuses a request without one, and Muse sends none. A custom url is
//    never touched — the Codex rules. Muse rewrites
//    this file itself and spells the block `mcpServers`, and a file holding both that
//    and `mcp_servers` runs with no MCP server at all, so the block is always written
//    as `mcpServers`, a `mcp_servers` block is moved into it, and a file with both is
//    refused.
//  * `hooks.PreToolUse` — the telem hook that sends lineage, reasoning and the
//    `.telem` options on each telem_search / telem_fetch. A Muse user hook needs no
//    approval step. Our handler is replaced in place, never duplicated, and any
//    handler the user put beside it stays.
//  * `tools.web_search.mode = "off"` — CONSENT-GATED, like Codex's
//    `web_search = "disabled"`. It removes Muse's built-in web_search AND web_fetch.
//
// The file is Muse's, not ours: every other key is preserved, and a file that does
// not parse as a strict JSON object (Muse does not start on one with comments either)
// is refused with its path rather than overwritten.

import { dirname, join } from "node:path"

import { CODEX_URL, ROUTING_HEADER, type HostedRouting } from "./codex.ts"

/** The hosted Telem MCP endpoint — the one every hosted surface points at. */
export const MUSE_URL = CODEX_URL
/** Muse names a server's tools `mcp__<server>__<tool>`. */
export const MUSE_HOOK_MATCHER = "^mcp__telem__telem_(search|fetch)$"
/** The hook script's file name; it is how an earlier telem hook entry is recognised. */
export const MUSE_HOOK_FILE = "telem-muse.mjs"
/** Seconds Muse waits for the hook. The hook only reads files; Muse goes on without it after this. */
const MUSE_HOOK_TIMEOUT = 30

/** The Muse config directory: `$XDG_CONFIG_HOME/muse` if set, else `~/.config/muse`. */
export function museConfigDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim()
  return xdg ? join(xdg, "muse") : join(home, ".config", "muse")
}

/** Where Muse keeps its session logs: `$XDG_DATA_HOME/muse/sessions`, else under
 * `~/.local/share`. The hook gets it as its argument, because a hook's environment never
 * carries XDG_DATA_HOME. */
export function museSessionsDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = (env.XDG_DATA_HOME ?? "").trim()
  return join(xdg || join(home, ".local", "share"), "muse", "sessions")
}

export function museSettingsPath(configDir: string): string {
  return join(configDir, "settings.json")
}

export type MuseSettingsInput = {
  /** The key to write into the Authorization header; none = a keyless entry. */
  apiKey: string | undefined
  /** The installer's routing answer; none = no header (the server default). */
  autoRouting: HostedRouting | undefined
  /** The hook command to register, or null to leave hooks alone. */
  hookCommand: string | null
  disableWebSearch: boolean
}

export type MuseSettingsEdit =
  | { status: "unchanged" }
  | {
      status: "write"
      contents: string
      created: boolean
      changes: string[]
      /** This edit added `mcpServers.telem`; "remove it" is correct undo advice only then. */
      addedServer: boolean
      /** This edit added our hook handler; "remove it" is correct undo advice only then. */
      addedHook: boolean
      /** An existing hosted entry had its Authorization/routing headers updated. */
      reconciled: boolean
      /** The telem entry has no key to authenticate with; the run must say so. */
      keyless: boolean
    }
  | { status: "unparseable"; reason: string }

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

function parse(source: string | null): Json | null | "unparseable" {
  if (source === null) return null
  try {
    const value: unknown = JSON.parse(source.replace(/^﻿/, ""))
    return isObj(value) ? value : "unparseable"
  } catch {
    return "unparseable"
  }
}

/** True when settings.json already turns off Muse's built-in web search. */
export function museWebSearchOff(source: string | null): boolean {
  const file = parse(source)
  if (!isObj(file) || !isObj(file.tools)) return false
  const webSearch = file.tools.web_search
  return isObj(webSearch) && webSearch.mode === "off"
}

/** The hosted server's CDN refuses a request with no User-Agent, and Muse sends none.
 * Any non-blank value already there is kept: the CDN needs only one. */
const USER_AGENT_HEADER = "User-Agent"
const USER_AGENT = "telem-muse"

function headersFor(apiKey: string | undefined, routing: HostedRouting | undefined): Json {
  // The User-Agent rides in every entry: the refusal does not depend on the key, and a
  // key added by hand later must work. The routing header rides only beside a key, as
  // on Codex: a keyless entry 401s anyway.
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(apiKey && routing ? { [ROUTING_HEADER]: routing } : {}),
    [USER_AGENT_HEADER]: USER_AGENT,
  }
}

/** Is this hook handler ours? The command runs `<dir>/telem/telem-muse.mjs`, with `\`
 * between the two on Windows: missed there, every re-run added another copy of our hook. */
function isTelemHandler(handler: unknown): boolean {
  return (
    isObj(handler) &&
    typeof handler.command === "string" &&
    handler.command.replaceAll("\\", "/").includes(`telem/${MUSE_HOOK_FILE}`)
  )
}

/**
 * `hooks.PreToolUse` with our handler in place: the first group holding one gets our
 * handler there; any other copy of ours is removed (and a group it leaves empty with
 * it); a file without ours gets a new group. Every handler the user added stays as it
 * was, matcher included: a group that shares ours with the user's handlers under
 * another matcher keeps them and that matcher, and ours moves to a group of its own
 * just before it. Our matcher there would stop the user's hook on every other tool.
 */
function withTelemHook(prior: unknown[], handler: Json): unknown[] {
  let placed = false
  const out: unknown[] = []
  for (const group of prior) {
    if (!isObj(group) || !Array.isArray(group.hooks) || !group.hooks.some(isTelemHandler)) {
      out.push(group)
      continue
    }
    const others = group.hooks.filter((entry) => !isTelemHandler(entry))
    if (!placed) {
      placed = true
      if (!others.length || group.matcher === MUSE_HOOK_MATCHER) {
        const at = group.hooks.findIndex(isTelemHandler)
        const hooks = [...others]
        hooks.splice(at, 0, handler)
        out.push({ ...group, matcher: MUSE_HOOK_MATCHER, hooks })
        continue
      }
      out.push({ matcher: MUSE_HOOK_MATCHER, hooks: [handler] })
    }
    if (others.length) out.push({ ...group, hooks: others })
  }
  if (!placed) out.push({ matcher: MUSE_HOOK_MATCHER, hooks: [handler] })
  return out
}

/** The entry to paste by hand, for a refusal: never with the real key. */
const SNIPPET = JSON.stringify(
  { mcpServers: { telem: { transport: "streamable_http", url: MUSE_URL, headers: { Authorization: "Bearer tlm_…" }, mode: "optional" } } },
  null,
  2,
)

export function planMuseSettings(source: string | null, input: MuseSettingsInput, path: string): MuseSettingsEdit {
  const refuse = (what: string, snippet = false): MuseSettingsEdit => ({
    status: "unparseable",
    reason:
      `${path} ${what} and will not be overwritten; fix or remove it, then re-run` +
      (snippet ? `. The Telem entry to add by hand:\n\n${SNIPPET}` : ""),
  })
  const existing = parse(source)
  // Muse itself does not start on such a file either: strict JSON only, no comments.
  if (existing === "unparseable") return refuse("is not valid JSON (Muse cannot read it either)")
  const out: Json = existing ? structuredClone(existing) : {}
  if (out.schema_version === undefined) out.schema_version = 1
  else if (out.schema_version !== 1) return refuse(`has schema_version ${JSON.stringify(out.schema_version)}, not 1,`)
  for (const key of ["mcpServers", "mcp_servers", "hooks", "tools"]) {
    if (out[key] !== undefined && !isObj(out[key])) return refuse(`has a ${key} that is not an object`, key !== "hooks")
  }
  // Muse rewrites this file itself and spells the block `mcpServers`; a file holding
  // both spellings runs with no MCP server at all, and no error. Write `mcpServers`,
  // and move a `mcp_servers` block into it, as Muse does.
  if (out.mcpServers !== undefined && out.mcp_servers !== undefined) {
    return refuse("has both mcpServers and mcp_servers (Muse then loads no MCP server)", true)
  }
  const hooks = (out.hooks ?? {}) as Json
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) {
    return refuse("has a hooks.PreToolUse that is not a list")
  }
  const tools = (out.tools ?? {}) as Json
  if (tools.web_search !== undefined && !isObj(tools.web_search)) {
    return refuse("has a tools.web_search that is not an object", true)
  }

  const changes: string[] = []
  let addedServer = false
  let addedHook = false
  let reconciled = false

  if (out.mcp_servers !== undefined) {
    out.mcpServers = out.mcp_servers
    delete out.mcp_servers
    changes.push("rename mcp_servers to mcpServers (Muse's own spelling)")
  }
  const servers = { ...((out.mcpServers ?? {}) as Json) }
  const telem = servers.telem
  const wanted = headersFor(input.apiKey, input.autoRouting)
  if (telem === undefined) {
    servers.telem = {
      transport: "streamable_http",
      url: MUSE_URL,
      headers: wanted,
      mode: "optional",
    }
    out.mcpServers = servers
    addedServer = true
    changes.push("add the hosted telem MCP server")
  } else if (isObj(telem) && telem.url === MUSE_URL) {
    // Only the headers this run writes move, whatever their case; any other header keeps
    // its value — the routing header too when this run has no routing answer (Codex), and
    // a User-Agent the user set.
    const prior = isObj(telem.headers) ? telem.headers : {}
    const userAgent = Object.entries(prior).find(([name]) => name.toLowerCase() === "user-agent")?.[1]
    // A blank or non-string value counts as missing: the CDN refuses it the same way.
    if (typeof userAgent === "string" && userAgent.trim()) delete wanted[USER_AGENT_HEADER]
    // In place: each header keeps its position, so an identical re-run writes nothing.
    const next: Json = {}
    for (const [name, value] of Object.entries(prior)) {
      const ours = Object.keys(wanted).find((key) => key.toLowerCase() === name.toLowerCase())
      if (ours) next[ours] = wanted[ours]
      else next[name] = value
    }
    for (const [name, value] of Object.entries(wanted)) if (!(name in next)) next[name] = value
    if (JSON.stringify(next) !== JSON.stringify(prior)) {
      servers.telem = { ...telem, headers: next }
      out.mcpServers = servers
      reconciled = true
      changes.push("update the telem server's headers")
    }
  }
  const finalTelem = (out.mcpServers as Json | undefined)?.telem
  const keyless =
    isObj(finalTelem) &&
    finalTelem.url === MUSE_URL &&
    !Object.keys(isObj(finalTelem.headers) ? finalTelem.headers : {}).some((name) => name.toLowerCase() === "authorization")

  if (input.hookCommand) {
    const handler = { type: "command", command: input.hookCommand, timeout: MUSE_HOOK_TIMEOUT }
    const prior = (hooks.PreToolUse ?? []) as unknown[]
    const next = withTelemHook(prior, handler)
    if (JSON.stringify(next) !== JSON.stringify(prior)) {
      out.hooks = { ...hooks, PreToolUse: next }
      addedHook = !prior.some((group) => isObj(group) && Array.isArray(group.hooks) && group.hooks.some(isTelemHandler))
      changes.push(addedHook ? "add the telem PreToolUse hook" : "update the telem PreToolUse hook")
    }
  }

  if (input.disableWebSearch && !museWebSearchOff(source)) {
    const webSearch = isObj(tools.web_search) ? tools.web_search : {}
    out.tools = { ...tools, web_search: { ...webSearch, mode: "off" } }
    // The old value rides in the change text, so the undo can put it back.
    changes.push(
      webSearch.mode === undefined
        ? 'set tools.web_search.mode = "off" so Muse searches through Telem'
        : `set tools.web_search.mode = "off" so Muse searches through Telem (was ${JSON.stringify(webSearch.mode)})`,
    )
  }

  if (!changes.length) return { status: "unchanged" }
  return {
    status: "write",
    contents: `${JSON.stringify(out, null, 2)}\n`,
    created: source === null,
    changes,
    addedServer,
    addedHook,
    reconciled,
    keyless,
  }
}

/** How to put settings.json back: one step per change this run made, nothing more. */
export function museUndoLine(
  edit: { created: boolean; addedServer: boolean; addedHook: boolean; reconciled: boolean; changes: string[] },
  path: string,
): string {
  const hookDir = join(dirname(path), "telem")
  if (edit.created) return `rm ${path} and rm -r ${hookDir}`
  const steps: string[] = []
  if (edit.changes.some((change) => change.startsWith("rename mcp_servers"))) {
    steps.push("leave the mcpServers spelling (Muse writes it itself)")
  }
  if (edit.addedServer) steps.push("remove mcpServers.telem")
  if (edit.reconciled) steps.push("restore your previous headers in mcpServers.telem")
  // Only the run that added the handler may tell the user to remove it (Codex's
  // `addedTable` rule): a re-run that refreshed it leaves an install that was there before.
  if (edit.addedHook) steps.push(`remove the hooks.PreToolUse handler that runs telem-muse.mjs, and delete ${hookDir}`)
  for (const change of edit.changes) {
    if (!change.includes("tools.web_search")) continue
    const was = /\(was (.*)\)$/.exec(change)
    steps.push(was ? `set tools.web_search.mode back to ${was[1]}` : "remove tools.web_search.mode")
  }
  return `in ${path}: ${steps.length ? steps.join("; ") : "undo the edits listed above"}`
}
