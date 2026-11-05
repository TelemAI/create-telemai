// The Claude Code surface: install the `telem` plugin (hosted MCP + PreToolUse
// lineage hook), not a bare `claude mcp add`.
//
// Three things happen for Claude Code, and the KEY is in no command:
//
//  * The plugin is COPIED to `~/.telem/plugins/claude-plugin-telem` — unchanged, except
//    that for a private deployment (`--mcp-url`, or an `mcpUrl` an earlier run saved)
//    the COPY's `.claude-plugin/plugin.json` gets `mcpServers.telem.url` set to that
//    endpoint (`claudePluginManifestFor`). On the hosted endpoint the copy is byte-
//    identical to the source, and a re-run back on it restores that.
//    Claude Code runs a directory-sourced plugin IN PLACE from the folder its
//    marketplace names; the copy it keeps under `~/.claude/plugins/cache/` is not used
//    (live check, Claude Code 2.1.317, 2026-11-03). Under `npx` this package's own
//    folder sits in the npm cache, and registering THAT made the plugin disappear,
//    without a message, the day the cache folder went. The copy is written over file
//    by file and the folder is never removed: the hook keeps its own state there
//    (`window.json`, `config-notice.json`). It is not the Copilot copy
//    (`copilot-plugin-telem`), whose plugin.json has no server and no userConfig.
//  * `claude plugin marketplace add <copy>` + `claude plugin install telem@telem` (+
//    `claude plugin update telem@telem` on a re-run) register and enable that folder.
//    `marketplace add` also repoints an existing `telem` marketplace in place and keeps
//    the key and `enabledPlugins`. `marketplace remove` and `plugin uninstall` delete the
//    key, so a migration never uses them. All three commands are env-free and key-free.
//    A `telem` marketplace the user added from GitHub is left alone (only `plugin
//    update` runs).
//  * The plugin declares a required `userConfig.TELEM_API_KEY` that its inline
//    `mcpServers.telem` reads as `${user_config.TELEM_API_KEY}`. A non-interactive
//    install cannot answer that prompt, so the installer STAGES the value into
//    settings.json `pluginConfigs["telem@telem"].options` inside the Claude config
//    directory instead (Claude Code reads it there: `plugin configure` shows it as
//    set) — a 0600 secret write in the same atomic Plan every other file goes through.
//    This keeps the exposure equal to `~/.telem/credentials.json` (plaintext, in a
//    private dir) and never touches the OS keychain, so an isolated `CLAUDE_CONFIG_DIR`
//    stays self-contained.
//
// The plugin ref is `<plugin>@<marketplace>` — both are named `telem` in
// `.claude-plugin/{plugin,marketplace}.json`, so the ref Claude Code keys the
// install/enable state on is `telem@telem` (verified against a real 2.1.233
// `installed_plugins.json` / `enabledPlugins`).

import { join } from "node:path"

/** The plugin package's own name (`.claude-plugin/plugin.json` → name). */
export const CLAUDE_PLUGIN = "telem"
/** The bundled marketplace's name (`.claude-plugin/marketplace.json` → name). */
export const CLAUDE_MARKETPLACE = "telem"
/** How Claude Code keys install/enable state: `<plugin>@<marketplace>`. */
export const CLAUDE_PLUGIN_REF = `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`
/** The userConfig key the plugin's inline mcpServers reads as the bearer token. */
export const CLAUDE_USER_CONFIG_KEY = "TELEM_API_KEY"
/** File under the Claude config dir that carries plugin userConfig values.
 * Claude reads plugin userConfig from settings.json -> pluginConfigs[ref].options,
 * NOT plugins/config.json (real-execution gate, 2026-08-15). */
export const CLAUDE_PLUGIN_CONFIG_FILE = "settings.json"

/** The Claude config directory: `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined>, home: string): string {
  const override = (env.CLAUDE_CONFIG_DIR ?? "").trim()
  return override ? override : join(home, ".claude")
}

/** The file this installer stages the plugin's `userConfig.TELEM_API_KEY` into. */
export function claudePluginConfigPath(configDir: string): string {
  return join(configDir, CLAUDE_PLUGIN_CONFIG_FILE)
}

/** Where the run planner copies the plugin, under the user's Telem directory. */
export const CLAUDE_PLUGIN_DIRNAME = "claude-plugin-telem"

/** `~/.telem/plugins/claude-plugin-telem`: the folder Claude Code's `telem` marketplace
 * names, and so the folder the plugin runs from. Not the packaged source the copy is
 * made from (`resolveClaudePluginDir` in run.ts). */
export function claudePluginCopyDir(home: string): string {
  return join(home, ".telem", "plugins", CLAUDE_PLUGIN_DIRNAME)
}

/** The manifest whose copy carries the MCP server's url. */
export const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json"

/**
 * The plugin manifest for the copy, with `mcpServers.telem.url` set to `mcpUrl`. The
 * source is re-serialized in its own indentation (and keeps or omits its final newline
 * as it had it); every other key, and the order of all of them, stays. Null when the
 * source is not a JSON object with a `mcpServers.telem` object: the caller then copies
 * it as it is and says the endpoint could not be set.
 */
export function claudePluginManifestFor(source: string, mcpUrl: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  if (!isObj(parsed) || !isObj(parsed.mcpServers) || !isObj(parsed.mcpServers.telem)) return null
  if (parsed.mcpServers.telem.url === mcpUrl) return source
  parsed.mcpServers.telem.url = mcpUrl
  const indent = /^[ \t]+(?=")/m.exec(source)?.[0] ?? "  "
  // Keep the source's line endings too: a Windows checkout (git autocrlf) has CRLF.
  // JSON.stringify escapes newlines inside strings, so only structural ones change.
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const body = JSON.stringify(parsed, null, indent).replace(/\n/g, eol)
  return `${body}${source.endsWith("\n") ? eol : ""}`
}

/** The plugin files the run planner copies, relative to the plugin root: every manifest,
 * hook and skill file, unchanged but for the manifest's url on a private deployment. Not the tests or the docs, and not the hook's own state
 * (`window.json`, `config-notice.json`), which the copy leaves where it is. */
export const CLAUDE_PLUGIN_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "hooks/lineage.mjs",
  "hooks/telem-config.mjs",
  "hooks/v5hash.mjs",
  "hooks/window.mjs",
  "skills/telem/SKILL.md",
] as const

/** Claude Code's own record of the marketplaces it knows. Read only: it is Claude Code's
 * private file, and a hand edit of it is reverted by the next session. */
export function claudeKnownMarketplacesPath(configDir: string): string {
  return join(configDir, "plugins", "known_marketplaces.json")
}

/** Where Claude Code's `telem` marketplace comes from: nowhere yet, a local folder (ours,
 * the npx cache, or a checkout), or anything else (`from` names it for the user). */
export type ClaudeMarketplaceSource =
  | { kind: "absent" }
  | { kind: "directory"; path: string }
  | { kind: "other"; from: string }

/**
 * The registered `telem` marketplace's source: settings.json
 * `extraKnownMarketplaces.telem` first (the declaration Claude Code reconciles its own
 * record toward), else `known_marketplaces.json`. Only a `directory` source is ours to
 * repoint; a GitHub or git source (the public mirror, added by hand) is the user's.
 * Pure: the two files' text in, the answer out. A file that does not parse says nothing.
 */
export function claudeMarketplaceSource(settings: string | null, known: string | null): ClaudeMarketplaceSource {
  const entryIn = (file: ClaudePluginConfigFile, from: (value: Record<string, unknown>) => unknown): unknown =>
    file.status === "parsed" ? from(file.value) : undefined
  const declared = entryIn(readClaudePluginConfig(settings), (value) =>
    isObj(value.extraKnownMarketplaces) ? value.extraKnownMarketplaces[CLAUDE_MARKETPLACE] : undefined,
  )
  const entry = declared ?? entryIn(readClaudePluginConfig(known), (value) => value[CLAUDE_MARKETPLACE])
  if (entry === undefined) return { kind: "absent" }
  const source = isObj(entry) && isObj(entry.source) ? entry.source : {}
  const text = (key: string): string => (typeof source[key] === "string" ? (source[key] as string) : "")
  if (source.source === "directory") return { kind: "directory", path: text("path") }
  const where = text("repo") || text("url") || text("path")
  const label = source.source === "github" ? "GitHub" : typeof source.source === "string" ? source.source : "a source that is not a local folder"
  return { kind: "other", from: where ? `${label} (${where})` : label }
}

/** How to take the plugin off again, in the order that works: Claude Code's own two
 * commands (the first also removes the key from settings.json), then the copy. */
export function claudePluginUndoLine(pluginDir: string): string {
  return (
    `claude plugin uninstall ${CLAUDE_PLUGIN_REF}, then claude plugin marketplace remove ${CLAUDE_MARKETPLACE}, ` +
    `then rm -r ${pluginDir}`
  )
}

/**
 * An existing plugin-config file, classified for a WRITE — the credentials.json
 * rule: a genuinely absent file is safe to create; a present file that does not
 * parse as a JSON object is `unparseable` and the caller must ABORT naming the
 * path rather than clobber whatever another plugin stored there.
 */
export type ClaudePluginConfigFile =
  | { status: "absent" }
  | { status: "parsed"; value: Record<string, unknown> }
  | { status: "unparseable" }

export function readClaudePluginConfig(source: string | null): ClaudePluginConfigFile {
  if (source === null) return { status: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.replace(/^﻿/, ""))
  } catch {
    return { status: "unparseable" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unparseable" }
  return { status: "parsed", value: parsed as Record<string, unknown> }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

/** The permission rules that switch Claude Code's default web search and fetch to Telem:
 * its built-in `WebSearch` and `WebFetch` tools, so searches go to telem_search and page
 * reads to telem_fetch. */
export const CLAUDE_WEB_RULES: readonly string[] = ["WebSearch", "WebFetch"]

/** The rules of CLAUDE_WEB_RULES that settings.json does not deny yet, in that order (all
 * of them for a missing or unreadable file). Empty: the switch is already made. */
export function claudeWebRulesMissing(source: string | null): string[] {
  const file = readClaudePluginConfig(source)
  const permissions = file.status === "parsed" ? file.value.permissions : undefined
  const deny = isObj(permissions) ? permissions.deny : undefined
  return CLAUDE_WEB_RULES.filter((rule) => !(Array.isArray(deny) && deny.includes(rule)))
}

export type ClaudePluginConfigEdit =
  | { status: "unchanged" }
  | { status: "write"; contents: string; created: boolean }
  | { status: "unparseable"; reason: string }

/**
 * Stage `TELEM_API_KEY` into the plugin's `userConfig`, keyed by the plugin ref.
 * Every other plugin's entry, and every other key inside our own entry, is
 * PRESERVED — this file is Claude Code's, not ours, so we only ever add/replace
 * the one value. Idempotent: if the value is already ours the edit is `unchanged`,
 * so a re-run writes byte-identical content (or nothing).
 */
export function planClaudePluginConfig(source: string | null, apiKey: string, path: string): ClaudePluginConfigEdit {
  const existing = readClaudePluginConfig(source)
  if (existing.status === "unparseable") {
    return {
      status: "unparseable",
      reason: `${path} is not valid JSON and will not be overwritten; fix or remove it, then re-run`,
    }
  }
  // settings.json is Claude's own file: preserve every sibling key, the whole
  // pluginConfigs map, our own entry's other fields, and options' other keys.
  const base: Record<string, unknown> = existing.status === "parsed" ? { ...existing.value } : {}
  const pluginConfigs = isObj(base.pluginConfigs) ? { ...base.pluginConfigs } : {}
  const priorEntry = isObj(pluginConfigs[CLAUDE_PLUGIN_REF]) ? { ...(pluginConfigs[CLAUDE_PLUGIN_REF] as Record<string, unknown>) } : {}
  const priorOptions = isObj(priorEntry.options) ? { ...(priorEntry.options as Record<string, unknown>) } : {}
  if (priorOptions[CLAUDE_USER_CONFIG_KEY] === apiKey) return { status: "unchanged" }
  const nextOptions = { ...priorOptions, [CLAUDE_USER_CONFIG_KEY]: apiKey }
  const nextEntry = { ...priorEntry, options: nextOptions }
  const out = { ...base, pluginConfigs: { ...pluginConfigs, [CLAUDE_PLUGIN_REF]: nextEntry } }
  return { status: "write", created: source === null, contents: `${JSON.stringify(out, null, 2)}\n` }
}

/**
 * Add `"WebSearch"` and `"WebFetch"` to `permissions.deny`, so Claude Code's default web
 * search and fetch is Telem (owner design, 2026-10-26; WebFetch and the "switch the
 * default" wording, owner 2026-11-03; the same step Codex has for
 * `web_search = "disabled"`). Only with the user's consent, never as a side effect of
 * installing. Every other key and every existing permission rule is PRESERVED, and only
 * the rules that are absent are added. A plugin cannot ship these rules itself: Claude
 * Code keeps only `agent` and `subagentStatusLine` from a plugin's settings.
 */
export function planClaudeWebDeny(source: string | null, path: string): ClaudePluginConfigEdit {
  const existing = readClaudePluginConfig(source)
  if (existing.status === "unparseable") {
    return {
      status: "unparseable",
      reason: `${path} is not valid JSON and will not be overwritten; fix or remove it, then re-run`,
    }
  }
  const missing = claudeWebRulesMissing(source)
  if (!missing.length) return { status: "unchanged" }
  const base: Record<string, unknown> = existing.status === "parsed" ? { ...existing.value } : {}
  const permissions = isObj(base.permissions) ? { ...base.permissions } : {}
  if (permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
    return {
      status: "unparseable",
      reason: `${path} has a permissions.deny that is not a list and will not be overwritten; fix it, then re-run`,
    }
  }
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : []
  const out = { ...base, permissions: { ...permissions, deny: [...deny, ...missing] } }
  return { status: "write", created: source === null, contents: `${JSON.stringify(out, null, 2)}\n` }
}

/** How Claude Code names the plugin's MCP server in a permission rule:
 * `mcp__plugin_<plugin>_<server>`, and `mcp__plugin_<plugin>_<server>__<tool>` for one tool. */
export const CLAUDE_TELEM_SERVER_RULE = `mcp__plugin_${CLAUDE_PLUGIN}_telem`

/** The permission rules that let Claude Code run Telem search and page reads without
 * asking (owner, 2026-11-03). Only these two read-only tools: never the monitor tools,
 * and never the whole server. A plugin cannot ship allow rules, so the installer writes
 * them. */
export const CLAUDE_ALLOW_RULES: readonly string[] = [
  `${CLAUDE_TELEM_SERVER_RULE}__telem_search`,
  `${CLAUDE_TELEM_SERVER_RULE}__telem_fetch`,
]

/** An allow rule the installer leaves out because the user's own deny or ask rule covers
 * the same tool. That rule wins in Claude Code anyway; an allow beside it only adds noise. */
export type ClaudeAllowBlocked = { rule: string; list: "deny" | "ask"; by: string }

/** Does the user's rule `entry` cover the tool `rule`? The exact name, the bare server
 * (`mcp__plugin_telem_telem`), or a trailing-`*` pattern that the name starts with
 * (`mcp__plugin_telem_telem__*`). */
function ruleCovers(entry: unknown, rule: string): boolean {
  if (typeof entry !== "string") return false
  const value = entry.trim()
  if (value === rule || value === CLAUDE_TELEM_SERVER_RULE) return true
  return value.endsWith("*") && value.startsWith("mcp__") && rule.startsWith(value.slice(0, -1))
}

/** The rules of CLAUDE_ALLOW_RULES to add (absent from `permissions.allow` and not covered
 * by a deny or ask rule), and the ones a deny or ask rule blocks. A missing or unreadable
 * file adds both. */
export function claudeAllowRulesMissing(source: string | null): { add: string[]; blocked: ClaudeAllowBlocked[] } {
  const file = readClaudePluginConfig(source)
  const permissions = file.status === "parsed" && isObj(file.value.permissions) ? file.value.permissions : {}
  const allow = Array.isArray(permissions.allow) ? permissions.allow : []
  const add: string[] = []
  const blocked: ClaudeAllowBlocked[] = []
  for (const rule of CLAUDE_ALLOW_RULES) {
    let by: ClaudeAllowBlocked | undefined
    for (const list of ["deny", "ask"] as const) {
      const entries = permissions[list]
      const hit = Array.isArray(entries) ? entries.find((entry) => ruleCovers(entry, rule)) : undefined
      if (hit !== undefined) {
        by = { rule, list, by: String(hit) }
        break
      }
    }
    if (by) blocked.push(by)
    else if (!allow.includes(rule)) add.push(rule)
  }
  return { add, blocked }
}

/**
 * Add the Telem search and fetch tools to `permissions.allow`, so Claude Code runs them
 * without a prompt (owner, 2026-11-03). Done on every install and update, with no
 * question: the two tools only read the web. Every other key and rule is PRESERVED, only
 * the absent rules are added, and a rule the user's own deny or ask rule covers is never
 * added. A `permissions.allow` that is not a list is not overwritten.
 */
export function planClaudeTelemAllow(source: string | null, path: string): ClaudePluginConfigEdit {
  const existing = readClaudePluginConfig(source)
  if (existing.status === "unparseable") {
    return {
      status: "unparseable",
      reason: `${path} is not valid JSON and will not be overwritten; fix or remove it, then re-run`,
    }
  }
  const base: Record<string, unknown> = existing.status === "parsed" ? { ...existing.value } : {}
  const permissions = isObj(base.permissions) ? { ...base.permissions } : {}
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    return {
      status: "unparseable",
      reason: `${path} has a permissions.allow that is not a list and will not be overwritten; fix it, then re-run`,
    }
  }
  const { add } = claudeAllowRulesMissing(source)
  if (!add.length) return { status: "unchanged" }
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : []
  const out = { ...base, permissions: { ...permissions, allow: [...allow, ...add] } }
  return { status: "write", created: source === null, contents: `${JSON.stringify(out, null, 2)}\n` }
}
