// The Claude Code surface: install the `telem` plugin (hosted MCP + PreToolUse
// lineage hook), not a bare `claude mcp add`.
//
// Two things happen for Claude Code, and the KEY is in neither command:
//
//  * `claude plugin marketplace add <dir>` + `claude plugin install telem@telem`
//    register and enable the local the sibling plugin package. Both are
//    env-free and key-free — the key never rides argv.
//  * The plugin declares a required `userConfig.TELEM_API_KEY` that its inline
//    `mcpServers.telem` reads as `${user_config.TELEM_API_KEY}`. A non-interactive
//    install cannot answer that prompt, so the installer STAGES the value into a
//    file inside the Claude config directory instead — a 0600 secret write in the
//    same atomic Plan every other file goes through. This keeps the exposure equal
//    to `~/.telem/credentials.json` (plaintext, in a private dir) and never touches
//    the OS keychain, so an isolated `CLAUDE_CONFIG_DIR` stays self-contained (spec
//
// The plugin ref is `<plugin>@<marketplace>` — both are named `telem` in
// `.claude-plugin/{plugin,marketplace}.json`, so the ref Claude Code keys the
// install/enable state on is `telem@telem` (verified against a real 2.1.233
// `installed_plugins.json` / `enabledPlugins`).
//
// NOTE (pending the real-execution gate): the EXACT filename/shape Claude Code
// reads a non-sensitive plugin `userConfig` value from is not yet pinned by a probe
// artifact — the probe plugin carried no userConfig. `CLAUDE_PLUGIN_CONFIG_FILE`
// and the `{ "<ref>": { KEY: value } }` shape below are the best-supported guess
// (it lives under the same `plugins/` dir Claude Code already keys plugin state on)
// and are the one thing the isolated E2E gate must confirm before merge. Everything
// else here — the two commands, the ref, key-off-argv — is probe-backed.

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
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v)
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
