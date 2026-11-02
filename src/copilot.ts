// The VS Code surface (`--client vscode`; `--client copilot` is its 0.1.28 name): VS Code's agent
// through GitHub Copilot's runtime (the Copilot harness, and VS Code's Local agent) and Copilot CLI,
// which share one runtime and one home (`$COPILOT_HOME`, else `~/.copilot`). The router names
// these calls `vscode` (the owner's rename, 2026-11-02); 0.1.28 installs still send `copilot`.
//
// Three edits, and the KEY is in no command:
//
//  * `<copilot home>/mcp-config.json` — `mcpServers.telem`, `http` to the hosted Telem MCP
//    with the key as a LITERAL `Authorization: Bearer <key>` header, so the file is a 0600
//    secret write. Copilot can expand `${NAME}` here, but only from an environment the
//    user would have to export for VS Code; VS Code's own `mcp.json` does not reach the
//    Copilot harness at all with `${env:…}` (lab, 2026-11-02). An existing entry whose url
//    is ours has its Authorization and routing headers brought in line with this run; a
//    custom url is never touched (the Codex rules).
//  * `<copilot home>/settings.json` — the plugin's registration, the same two keys Copilot's
//    own `/plugin install` writes: `extraKnownMarketplaces.telem` (a directory source) and
//    `enabledPlugins["telem@telem"] = true`.
//  * the plugin itself — the Claude Code plugin, copied by the run planner to a stable
//    directory (Copilot loads a directory plugin live, so an npx cache would not do), with
//    two files derived here: a `plugin.json` WITHOUT `mcpServers`/`userConfig` (Copilot does
//    not fill `${user_config.…}`, and a plugin server named `telem` wins over
//    mcp-config.json's, so the user would get a server that cannot authenticate), and a
//    `hooks.json` whose PreToolUse matcher Copilot matches (it compares the WHOLE tool name,
//    `telem-telem_search`; Claude Code's `^mcp__plugin_…$` never fires there), whose lineage
//    command passes `--harness vscode`, and which records the turn on UserPromptSubmit,
//    because Copilot's PreToolUse payload has no prompt_id.
//  * `<copilot home>/hooks/telem.json` — the same two hooks as a user hook file, for VS Code's
//    LOCAL agent (the Chat view's "Local" session target), which does not load Copilot plugins
//    but runs `~/.copilot/hooks/*.json` with a Claude-style payload (session_id, timestamp,
//    tool_name, tool_input, tool_use_id). Copilot's own format (version 1, camelCase events),
//    which VS Code maps; `CLAUDE_PLUGIN_ROOT` in `env` keeps the turn record in the plugin copy.
//    Copilot itself may run this file too; whatever it passes, the hook writes the same bridge as
//    the plugin's, or nothing.
//
// Both JSON files are Copilot's, not ours: every other key is preserved, and a file that
// does not parse as a JSON object is refused with its path rather than overwritten.

import { join } from "node:path"

import { CODEX_URL, ROUTING_HEADER, type HostedRouting } from "./codex.ts"

/** The hosted Telem MCP endpoint — the one every hosted surface points at. */
export const COPILOT_URL = CODEX_URL
/** Copilot matches a hook's matcher against the whole tool name (`telem-telem_search`);
 * Claude Code would match this too (`mcp__plugin_telem_telem__telem_search`). */
export const COPILOT_HOOK_MATCHER = ".*telem_(search|fetch)"
/** The marketplace and plugin names, as the copied marketplace.json declares them. */
export const COPILOT_MARKETPLACE = "telem"
export const COPILOT_PLUGIN_REF = "telem@telem"
/** Where the run planner copies the plugin, under the user's Telem directory. */
export const COPILOT_PLUGIN_DIRNAME = "copilot-plugin-telem"

const LINEAGE_SCRIPT = "hooks/lineage.mjs"
const HARNESS_FLAG = "--harness vscode"
const TURN_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/window.mjs" user-prompt'

/** The Copilot home: `$COPILOT_HOME` if set, else `~/.copilot`. */
export function copilotHome(env: Record<string, string | undefined>, home: string): string {
  const fromEnv = (env.COPILOT_HOME ?? "").trim()
  return fromEnv || join(home, ".copilot")
}

export function copilotMcpConfigPath(copilotDir: string): string {
  return join(copilotDir, "mcp-config.json")
}

export function copilotSettingsPath(copilotDir: string): string {
  return join(copilotDir, "settings.json")
}

/** Where the plugin copy lives: `~/.telem/plugins/copilot-plugin-telem`. */
export function copilotPluginDir(home: string): string {
  return join(home, ".telem", "plugins", COPILOT_PLUGIN_DIRNAME)
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

function parse(source: string | null): Json | null | "unparseable" {
  if (source === null) return null
  if (!source.trim()) return {}
  try {
    const value: unknown = JSON.parse(source.replace(/^﻿/, ""))
    return isObj(value) ? value : "unparseable"
  } catch {
    return "unparseable"
  }
}

export type CopilotMcpConfigEdit =
  | { status: "unchanged" }
  | {
      status: "write"
      contents: string
      created: boolean
      changes: string[]
      /** This edit added `mcpServers.telem`; "remove it" is correct undo advice only then. */
      addedServer: boolean
      /** An existing hosted entry had its Authorization/routing headers updated. */
      reconciled: boolean
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

/** The `mcpServers.telem` edit of Copilot's mcp-config.json. Pure: source in, edit out. */
export function planCopilotMcpConfig(
  source: string | null,
  input: { apiKey: string | undefined; autoRouting: HostedRouting | undefined },
  path: string,
): CopilotMcpConfigEdit {
  const file = parse(source)
  if (file === "unparseable") {
    return { status: "unparseable", reason: `${path} is not a JSON object; fix or move it, then re-run` }
  }
  const out: Json = { ...(file ?? {}) }
  if (out.mcpServers !== undefined && !isObj(out.mcpServers)) {
    return { status: "unparseable", reason: `${path} has an mcpServers that is not an object; fix it, then re-run` }
  }
  const servers = { ...((out.mcpServers ?? {}) as Json) }
  const telem = servers.telem
  const wanted = headersFor(input.apiKey, input.autoRouting)
  const changes: string[] = []
  let addedServer = false
  let reconciled = false
  if (telem === undefined) {
    servers.telem = { type: "http", url: COPILOT_URL, headers: wanted }
    out.mcpServers = servers
    addedServer = true
    changes.push("add the hosted telem MCP server")
  } else if (isObj(telem) && telem.url === COPILOT_URL) {
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
      servers.telem = { ...telem, headers: next }
      out.mcpServers = servers
      reconciled = true
      changes.push("update the telem server's headers")
    }
  }
  const finalTelem = (out.mcpServers as Json | undefined)?.telem
  const keyless =
    isObj(finalTelem) &&
    finalTelem.url === COPILOT_URL &&
    !Object.keys(isObj(finalTelem.headers) ? finalTelem.headers : {}).some((name) => name.toLowerCase() === "authorization")
  if (!changes.length) return { status: "unchanged" }
  return {
    status: "write",
    contents: `${JSON.stringify(out, null, 2)}\n`,
    created: source === null,
    changes,
    addedServer,
    reconciled,
    keyless,
  }
}

export type CopilotSettingsEdit =
  | { status: "unchanged" }
  | { status: "write"; contents: string; created: boolean; changes: string[]; registered: boolean }
  | { status: "unparseable"; reason: string }

/** The plugin registration in Copilot's settings.json. Pure: source in, edit out. */
export function planCopilotSettings(source: string | null, pluginDir: string, path: string): CopilotSettingsEdit {
  const file = parse(source)
  if (file === "unparseable") {
    return { status: "unparseable", reason: `${path} is not a JSON object; fix or move it, then re-run` }
  }
  const out: Json = { ...(file ?? {}) }
  for (const key of ["extraKnownMarketplaces", "enabledPlugins"]) {
    if (out[key] !== undefined && !isObj(out[key])) {
      return { status: "unparseable", reason: `${path} has a ${key} that is not an object; fix it, then re-run` }
    }
  }
  const changes: string[] = []
  const marketplaces = { ...((out.extraKnownMarketplaces ?? {}) as Json) }
  const wantedSource = { source: { source: "directory", path: pluginDir } }
  const prior = marketplaces[COPILOT_MARKETPLACE]
  const registered = prior === undefined
  if (JSON.stringify(isObj(prior) ? { source: prior.source } : prior) !== JSON.stringify(wantedSource)) {
    marketplaces[COPILOT_MARKETPLACE] = { ...(isObj(prior) ? prior : {}), ...wantedSource }
    out.extraKnownMarketplaces = marketplaces
    changes.push(registered ? "register the telem plugin marketplace" : "point the telem plugin marketplace at the copied plugin")
  }
  const enabled = { ...((out.enabledPlugins ?? {}) as Json) }
  if (enabled[COPILOT_PLUGIN_REF] !== true) {
    enabled[COPILOT_PLUGIN_REF] = true
    out.enabledPlugins = enabled
    changes.push(`enable ${COPILOT_PLUGIN_REF}`)
  }
  if (!changes.length) return { status: "unchanged" }
  return { status: "write", contents: `${JSON.stringify(out, null, 2)}\n`, created: source === null, changes, registered }
}

/**
 * The Copilot plugin.json from the Claude Code one: the same name, version and text, with
 * no `mcpServers` and no `userConfig` (the server lives in mcp-config.json instead).
 * Null when the source is not a JSON object.
 */
export function copilotPluginManifest(claudeManifest: string | null): string | null {
  const manifest = parse(claudeManifest)
  if (!isObj(manifest)) return null
  const rest: Json = { ...manifest }
  delete rest.mcpServers
  delete rest.userConfig
  return `${JSON.stringify(rest, null, 2)}\n`
}

/**
 * The Copilot hooks.json from the Claude Code one: PreToolUse groups that run the lineage
 * hook get Copilot's matcher and `--harness vscode`, and a UserPromptSubmit handler
 * records the turn. Every other event is kept as it is. Null when the source has no
 * lineage hook to adapt.
 */
export function copilotHooksJson(claudeHooks: string | null): string | null {
  const file = parse(claudeHooks)
  if (!isObj(file) || !isObj(file.hooks)) return null
  const hooks = { ...(file.hooks as Json) }
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  let adapted = false
  hooks.PreToolUse = pre.map((group) => {
    if (!isObj(group) || !Array.isArray(group.hooks)) return group
    const handlers = group.hooks.map((handler) => {
      if (!isObj(handler) || typeof handler.command !== "string" || !handler.command.includes(LINEAGE_SCRIPT)) return handler
      adapted = true
      return handler.command.includes(HARNESS_FLAG) ? handler : { ...handler, command: `${handler.command} ${HARNESS_FLAG}` }
    })
    return handlers.some((handler) => isObj(handler) && typeof handler.command === "string" && handler.command.includes(LINEAGE_SCRIPT))
      ? { ...group, matcher: COPILOT_HOOK_MATCHER, hooks: handlers }
      : { ...group, hooks: handlers }
  })
  if (!adapted) return null
  const prompt = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  const hasTurn = prompt.some(
    (group) => isObj(group) && Array.isArray(group.hooks) && group.hooks.some((h) => isObj(h) && h.command === TURN_COMMAND),
  )
  if (!hasTurn) hooks.UserPromptSubmit = [...prompt, { hooks: [{ type: "command", command: TURN_COMMAND }] }]
  return `${JSON.stringify({ ...file, hooks }, null, 2)}\n`
}

/** The plugin files the run planner copies, relative to the Claude Code plugin root. The
 * two manifests are derived (above); the rest are copied as they are. */
export const COPILOT_PLUGIN_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "hooks/lineage.mjs",
  "hooks/telem-config.mjs",
  "hooks/v5hash.mjs",
  "hooks/window.mjs",
  "skills/telem/SKILL.md",
] as const

/** The user hook file VS Code's Local agent runs (see the header). */
export function copilotUserHooksPath(copilotDir: string): string {
  return join(copilotDir, "hooks", "telem.json")
}

/** That file's contents: the lineage hook and the turn record, run from the plugin copy. */
export function copilotUserHooks(pluginDir: string): string {
  const env = { CLAUDE_PLUGIN_ROOT: pluginDir }
  const script = (name: string) => `node "${join(pluginDir, "hooks", name)}"`
  const hooks = {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", command: `${script("lineage.mjs")} ${HARNESS_FLAG}`, env, timeoutSec: 30 }],
      userPromptSubmitted: [{ type: "command", command: `${script("window.mjs")} user-prompt`, env, timeoutSec: 30 }],
    },
  }
  return `${JSON.stringify(hooks, null, 2)}\n`
}

/** How to put mcp-config.json back: one step per change this run made. */
export function copilotMcpUndoLine(
  edit: { created: boolean; addedServer: boolean; reconciled: boolean },
  path: string,
): string {
  if (edit.created) return `rm ${path}`
  const steps: string[] = []
  if (edit.addedServer) steps.push("remove mcpServers.telem")
  if (edit.reconciled) steps.push("restore your previous headers in mcpServers.telem")
  return `in ${path}: ${steps.length ? steps.join("; ") : "undo the edits listed above"}`
}

/** How to put settings.json back. */
export function copilotSettingsUndoLine(edit: { created: boolean; registered: boolean }, path: string, pluginDir: string): string {
  if (edit.created) return `rm ${path} and rm -r ${pluginDir}`
  return edit.registered
    ? `in ${path}: remove extraKnownMarketplaces.telem and enabledPlugins["${COPILOT_PLUGIN_REF}"], and delete ${pluginDir}`
    : `in ${path}: set extraKnownMarketplaces.telem back to its previous source`
}
