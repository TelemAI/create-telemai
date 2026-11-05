// The `mcpServers.telem` edit of an `mcp.json`-style file (`{ "mcpServers": { … } }`), for
// the hosts that read the hosted Telem MCP from one: Cursor (`~/.cursor/mcp.json`) and Devin
// (`~/.config/devin/mcp_config.json`). The Codex rules: a new entry gets the hosted url and the
// key as a LITERAL `Authorization: Bearer <key>` header (so the file is a 0600 secret write); an
// existing entry whose url is ours has its Authorization and routing headers brought in line
// with this run, every other header kept; a custom url is never touched. The file is the host's:
// every other key is preserved, and one that does not parse as a JSON object is refused.

import { CODEX_URL, ROUTING_HEADER, addServerChange, entryOwnership, headersBearer, isTelemMcpUrl, type HostedRouting } from "./codex.ts"

/** The hosted Telem MCP endpoint — the one every hosted surface points at by default. */
export const HOSTED_MCP_URL = CODEX_URL

export type Json = Record<string, unknown>

export const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

/** A JSON object, null for no file, or "unparseable". An empty file reads as `{}`. */
export function parseJsonObject(source: string | null): Json | null | "unparseable" {
  if (source === null) return null
  if (!source.trim()) return {}
  try {
    const value: unknown = JSON.parse(source.replace(/^﻿/, ""))
    return isObj(value) ? value : "unparseable"
  } catch {
    return "unparseable"
  }
}

export type McpJsonEdit =
  /** `foreignUrl`: the telem entry points at a url that is not ours; `heldKeyUrl`: it also
   * carries the saved key. Each set only then. */
  | { status: "unchanged"; foreignUrl?: string; heldKeyUrl?: string }
  | {
      status: "write"
      contents: string
      created: boolean
      changes: string[]
      /** This edit added `mcpServers.telem`; "remove it" is correct undo advice only then. */
      addedServer: boolean
      /** An existing hosted entry had its Authorization/routing headers updated. */
      reconciled: boolean
      /** An existing entry of ours pointed at another Telem endpoint and now points at
       * this run's `mcpUrl`; the url it had, for the undo line. Null otherwise. */
      repointedFrom: string | null
      /** The telem entry points at a url that is not ours, so it was left alone (set only then). */
      foreignUrl?: string
      /** The entry carries the saved key at a url that is not ours (set only then). */
      heldKeyUrl?: string
      /** The telem entry has no key to authenticate with; the run must say so. */
      keyless: boolean
    }
  | { status: "unparseable"; reason: string }

function headersFor(apiKey: string | undefined, routing: HostedRouting | undefined): Json {
  // The routing header rides only beside a key, as on Codex: a keyless entry 401s anyway.
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(apiKey && routing ? { [ROUTING_HEADER]: routing } : {}),
  }
}

/** The `mcpServers.telem` edit. Pure: source in, edit out. `entry` is the host's shape for a
 * new hosted server (both hosts infer the HTTP transport from `url`). */
export function planMcpJson(
  source: string | null,
  input: {
    apiKey: string | undefined
    autoRouting: HostedRouting | undefined
    /** The Telem MCP endpoint to point at; absent → the hosted one. */
    mcpUrl?: string
    /** The endpoint an earlier run saved, so an entry still on it counts as ours. */
    priorMcpUrl?: string
    /** The key saved in credentials.json: an entry carrying it is ours whatever its url. */
    savedApiKey?: string
    /** Repoint an entry that is ours only by its key (`entryOwnership`). */
    repointKeyed?: boolean
  },
  path: string,
): McpJsonEdit {
  const mcpUrl = input.mcpUrl ?? HOSTED_MCP_URL
  const file = parseJsonObject(source)
  if (file === "unparseable") {
    return { status: "unparseable", reason: `${path} is not a JSON object; fix or move it, then re-run` }
  }
  const out: Json = { ...(file ?? {}) }
  if (out.mcpServers !== undefined && !isObj(out.mcpServers)) {
    return { status: "unparseable", reason: `${path} has an mcpServers that is not an object; fix it, then re-run` }
  }
  const servers = { ...((out.mcpServers ?? {}) as Json) }
  const telem = servers.telem
  // The saved endpoint, and this entry's own url when it carries the saved key.
  const own = entryOwnership(
    { url: isObj(telem) ? telem.url : undefined, bearer: isObj(telem) ? headersBearer(telem.headers) : null },
    { ...input, mcpUrl },
  )
  const prior = own.prior
  const heldKeyUrl = own.heldKeyUrl
  const foreignUrl =
    isObj(telem) && typeof telem.url === "string" && !isTelemMcpUrl(telem.url, mcpUrl, prior) ? telem.url : null
  const wanted = headersFor(input.apiKey, input.autoRouting)
  const changes: string[] = []
  let addedServer = false
  let reconciled = false
  let repointedFrom: string | null = null
  if (telem === undefined) {
    servers.telem = { url: mcpUrl, headers: wanted }
    out.mcpServers = servers
    addedServer = true
    changes.push(addServerChange(mcpUrl))
  } else if (isObj(telem) && isTelemMcpUrl(telem.url, mcpUrl, prior)) {
    // Ours on another Telem endpoint (the hosted default, or the one an earlier run
    // saved): point it at this run's. Every other key of the entry stays.
    let entry: Json = telem
    if (telem.url !== mcpUrl) {
      repointedFrom = telem.url as string
      entry = { ...telem, url: mcpUrl }
      servers.telem = entry
      out.mcpServers = servers
      changes.push(`point the telem server at ${mcpUrl} (was ${repointedFrom})`)
    }
    // Only the headers this run writes move, whatever their case; any other header keeps
    // its value, and so does the routing header when this run has no routing answer.
    const prior = isObj(telem.headers) ? telem.headers : {}
    const next: Json = {}
    for (const [name, value] of Object.entries(prior)) {
      const ours = Object.keys(wanted).find((key) => key.toLowerCase() === name.toLowerCase())
      if (ours) next[ours] = wanted[ours]
      else next[name] = value
    }
    for (const [name, value] of Object.entries(wanted)) if (!(name in next)) next[name] = value
    if (JSON.stringify(next) !== JSON.stringify(prior)) {
      servers.telem = { ...entry, headers: next }
      out.mcpServers = servers
      reconciled = true
      changes.push("update the telem server's headers")
    }
  }
  const finalTelem = (out.mcpServers as Json | undefined)?.telem
  const keyless =
    isObj(finalTelem) &&
    isTelemMcpUrl(finalTelem.url, mcpUrl, prior) &&
    !Object.keys(isObj(finalTelem.headers) ? finalTelem.headers : {}).some((name) => name.toLowerCase() === "authorization")
  if (!changes.length) {
    return { status: "unchanged", ...(foreignUrl !== null ? { foreignUrl } : {}), ...(heldKeyUrl !== null ? { heldKeyUrl } : {}) }
  }
  return {
    status: "write",
    contents: `${JSON.stringify(out, null, 2)}\n`,
    created: source === null,
    changes,
    addedServer,
    reconciled,
    repointedFrom,
    keyless,
    ...(foreignUrl !== null ? { foreignUrl } : {}),
    ...(heldKeyUrl !== null ? { heldKeyUrl } : {}),
  }
}

/** How to put the file back: one step per change this run made. */
export function mcpJsonUndoLine(
  edit: { created: boolean; addedServer: boolean; reconciled: boolean; repointedFrom?: string | null },
  path: string,
): string {
  if (edit.created) return `rm ${path}`
  const steps: string[] = []
  if (edit.addedServer) steps.push("remove mcpServers.telem")
  if (edit.repointedFrom) steps.push(`set mcpServers.telem.url back to ${edit.repointedFrom}`)
  if (edit.reconciled) steps.push("restore your previous headers in mcpServers.telem")
  return `in ${path}: ${steps.length ? steps.join("; ") : "undo the edits listed above"}`
}

/** The hook scripts the Cursor and Devin surfaces copy from the Claude Code plugin, relative
 * to its root: the lineage hook and the two modules it imports. */
export const HOOK_SCRIPT_FILES = ["hooks/lineage.mjs", "hooks/telem-config.mjs", "hooks/v5hash.mjs"] as const
/** The Telem skill, relative to the Claude Code plugin root. */
export const SKILL_FILE = "skills/telem/SKILL.md"
