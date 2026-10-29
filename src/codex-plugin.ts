// The Codex surface's PLUGIN half: the sibling plugin installed as a real Codex
// plugin, the mirror of what claude.ts does for Claude Code.
//
// Two commands, both env-free and key-free — the key never rides argv:
//
//   codex plugin marketplace add <codex-plugin-telem dir>
//   codex plugin add telem@telem
//
// What the plugin carries is the model-facing half (the PreToolUse reasoning hook and
// the telem skill). What it CANNOT carry — proven by probe, not assumed — stays in
// config.toml, written by codex.ts:
//
//   * `[mcp_servers.telem]` + inline auth. Codex silently DROPS a Claude-style
//     `headers` key from a plugin manifest and never substitutes `${user_config.*}`,
//     so a plugin-declared hosted server 401s at runtime with no config-time warning.
//   * `model_reasoning_summary = "detailed"`. No manifest field exists; unknown
//     manifest keys are accepted and ignored silently.
//
// ── Hook trust ───────────────────────────────────────────────────────────────────
//
// Every plugin hook starts UNTRUSTED and is silently skipped until trusted. There is
// no CLI to grant trust — the TUI does it — and a silent no-op is the worst failure
// mode this integration has. So the installer pre-grants trust itself, by writing the
// same state Codex's own TUI writes:
//
//   [hooks.state."telem@telem:hooks/hooks.json:pre_tool_use:0:0"]
//   enabled = true
//   trusted_hash = "sha256:…"
//
// The key is `<pluginId>:<path relative to the plugin root>:<event>:<group>:<handler>`
// and the hash is sha256 over the canonical (recursively key-sorted, compact) JSON of
// a NORMALIZED identity:
//
//   { event_name, matcher?, hooks: [ { type, command, async, timeout, … } ] }
//
// Three properties of that identity are what make pre-granting safe and possible:
//
//   * the command is the RAW, UNEXPANDED string — `${CLAUDE_PLUGIN_ROOT}` is
//     substituted only AFTER the identity is built — so the hash depends solely on
//     the package's own hooks/hooks.json and is IDENTICAL on every machine and in
//     every CODEX_HOME. Nothing about the install path enters it.
//   * plugin id, marketplace, source path and ordering do NOT enter it (verified: the
//     same handler in a second matcher group, and in a different plugin entirely,
//     hashes the same).
//   * editing hooks/hooks.json changes the hash and revokes trust, which is the point.
//
// Getting the hash wrong is FAIL-SAFE: a stale hash reads as `modified`, the hook is
// skipped, and the user is exactly where they would be with no pre-grant at all — so
// the run also prints how to trust it by hand.
//
// ── Content trust (Codex 0.164) ──────────────────────────────────────────────────
//
// Codex also pins a plugin hook to the plugin's installed FILES: approving it in the
// TUI writes `trusted_content_hash` beside `trusted_hash`, a fingerprint of the copy
// `codex plugin add` makes under `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/
// <version>`. An entry with no content hash is pinned to whatever content Codex sees
// first (a baseline file in `<CODEX_HOME>/.hook-trust/`), so the next plugin update
// reads as `modified` and the hook is skipped until the user approves it again —
// silently, under `codex exec`. So the installer also writes `trusted_content_hash`,
// but ONLY for files it ships: the fingerprint of its own plugin dir, and only when
// Codex's cached copy is (or is about to be) a copy of that dir (`planCodexPlugin`).
// A local install copies the dir byte for byte, so the two fingerprints are equal.

import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"

import type { CodexHookTrustEntry } from "./codex.ts"

/** The plugin package's own name (`.codex-plugin/plugin.json` → name). */
export const CODEX_PLUGIN = "telem"
/** The bundled marketplace's name (`.agents/plugins/marketplace.json` → name). */
export const CODEX_MARKETPLACE = "telem"
/** How Codex keys install/enable state: `<plugin>@<marketplace>`. */
export const CODEX_PLUGIN_REF = `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`
/** The hooks file inside the plugin, and the key fragment Codex derives from it. */
export const CODEX_PLUGIN_HOOKS_REL = "hooks/hooks.json"

/** The Codex home: `$CODEX_HOME` if set, else `~/.codex`. */
export function codexHomeDir(env: Record<string, string | undefined>, home: string): string {
  const override = (env.CODEX_HOME ?? "").trim()
  return override ? override : join(home, ".codex")
}

/** Claude's event names, as Codex spells them in a hook key. */
const EVENT_LABELS: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
}

/** Events whose handlers may declare `additionalContextLimit`; elsewhere it is dropped. */
const ADDITIONAL_CONTEXT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
])

/** Codex's default hook timeout, and the token limit it normalizes away as "unset". */
const DEFAULT_TIMEOUT_SEC = 600
const DEFAULT_ADDITIONAL_CONTEXT_LIMIT = 2500

/** One `[hooks.state."<key>"]` entry the installer will pre-grant. Defined next to
 * the TOML editor that writes it, so there is one name for one shape. */
export type { CodexHookTrustEntry } from "./codex.ts"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Recursively key-sorted, compact JSON — `canonical_json` + `serde_json:to_vec`. */
function canonicalJson(value: unknown): string {
  const canon = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canon)
    if (isPlainObject(input)) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(input).sort()) out[key] = canon(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(canon(value))
}

/**
 * The trust entries for a plugin's `hooks/hooks.json`, or `null` when this installer
 * will not vouch for the result.
 *
 * `null` is returned rather than a guess whenever anything in the file is outside the
 * shape whose normalization is PROVEN: unparseable JSON, a non-command handler, or a
 * `SessionEnd` hook (whose timeout normalization has its own default and clamp that no
 * probe pinned here). The caller then simply skips the pre-grant and tells the user to
 * trust the hook in Codex's `/plugin` UI — the same place they would have been anyway.
 */
export function codexHookTrustEntries(
  source: string | null,
  options: { pluginRef?: string; hooksRelPath?: string; platform?: string } = {},
): CodexHookTrustEntry[] | null {
  if (source === null) return null
  const pluginRef = options.pluginRef ?? CODEX_PLUGIN_REF
  const hooksRel = options.hooksRelPath ?? CODEX_PLUGIN_HOOKS_REL
  const windows = options.platform === "win32"

  let doc: unknown
  try {
    doc = JSON.parse(source)
  } catch {
    return null
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.hooks)) return null

  const entries: CodexHookTrustEntry[] = []
  for (const [event, rawGroups] of Object.entries(doc.hooks)) {
    const label = EVENT_LABELS[event]
    // An event this Codex build does not know, or the one whose normalization is not
    // pinned here: refuse the whole file rather than pre-grant a partial set.
    if (!label || event === "SessionEnd") return null
    if (!Array.isArray(rawGroups)) return null
    for (let groupIndex = 0; groupIndex < rawGroups.length; groupIndex += 1) {
      const group = rawGroups[groupIndex]
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return null
      const matcher = group.matcher
      if (matcher !== undefined && matcher !== null && typeof matcher !== "string") return null
      for (let handlerIndex = 0; handlerIndex < group.hooks.length; handlerIndex += 1) {
        const handler = group.hooks[handlerIndex]
        if (!isPlainObject(handler) || handler.type !== "command") return null
        // An `async: true` handler is NOT registered by Codex at all — it never
        // appears in `hooks/list`, so there is no hook for a trust entry to point at.
        // Pre-granting one writes an orphan `[hooks.state."…"]` table AND makes the
        // run report `hookTrustSatisfied`, i.e. "the hook will run", about a hook
        // that does not exist. Refuse the file, exactly like SessionEnd.
        if (handler.async === true) return null
        const command = windows
          ? typeof handler.commandWindows === "string"
            ? handler.commandWindows
            : handler.command
          : handler.command
        if (typeof command !== "string" || !command.trim()) return null
        const rawTimeout = handler.timeout
        if (rawTimeout !== undefined && typeof rawTimeout !== "number") return null
        // `timeout_sec.unwrap_or(600).max(1)` — the identity always carries a value,
        // even when the file does not.
        const timeout = Math.max(1, rawTimeout ?? DEFAULT_TIMEOUT_SEC)
        // `command_windows` is resolved into `command` and then set to None, so it is
        // never part of the identity on either platform.
        const normalized: Record<string, unknown> = {
          type: "command",
          command,
          async: handler.async === true,
          timeout,
        }
        if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage
        const limit = handler.additionalContextLimit
        if (
          typeof limit === "number" &&
          limit !== DEFAULT_ADDITIONAL_CONTEXT_LIMIT &&
          ADDITIONAL_CONTEXT_EVENTS.has(event)
        ) {
          normalized.additionalContextLimit = limit
        }
        const identity: Record<string, unknown> = { event_name: label, hooks: [normalized] }
        // A `matcher` that is absent or null is OMITTED: TOML has no null, so the
        // serializer drops it rather than writing one.
        if (typeof matcher === "string") identity.matcher = matcher
        entries.push({
          key: `${pluginRef}:${hooksRel}:${label}:${groupIndex}:${handlerIndex}`,
          hash: `sha256:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`,
        })
      }
    }
  }
  return entries.length ? entries : null
}

/** Where `codex plugin add` puts its copy of a plugin, whose files Codex fingerprints. */
export function codexPluginCacheDir(codexHome: string, version: string): string {
  return join(codexHome, "plugins", "cache", CODEX_MARKETPLACE, CODEX_PLUGIN, version)
}

/** Entries Codex leaves out of the fingerprint, by name: generated Python files. */
function fingerprintSkips(name: string): boolean {
  return name === "__pycache__" || name === ".venv" || name.endsWith(".pyc") || name.endsWith(".egg-info")
}

function u64le(value: number): Buffer {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}

/**
 * Codex's fingerprint of a plugin's files, `sha256:<hex>`: a port of
 * `plugin_content_hash` (codex-rs/hooks/src/engine/plugin_fingerprint.rs, 0.164).
 *
 * Depth-first from the root, children in byte order of their names; each entry adds
 * its path relative to the root (length-prefixed, the platform's separators, the root
 * itself as ""), then "directory", or "file" with the length and the bytes. `null` when
 * Codex would refuse the tree too (a symlink or any entry that is neither a file nor a
 * directory) or it cannot be read: the caller then vouches for nothing.
 */
export function codexPluginContentHash(root: string): string | null {
  try {
    if (!lstatSync(root).isDirectory()) return null
    const hash = createHash("sha256").update("codex-plugin-bundle-v1")
    const pending = [root]
    while (pending.length) {
      const path = pending.pop() as string
      const rel = path === root ? "" : relative(root, path)
      if (rel && fingerprintSkips(basename(rel))) continue
      const name = Buffer.from(rel, "utf8")
      hash.update(u64le(name.length)).update(name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        hash.update("directory")
        const children = readdirSync(path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        for (let index = children.length - 1; index >= 0; index -= 1) pending.push(join(path, children[index]))
      } else if (stat.isFile()) {
        const data = readFileSync(path)
        hash.update("file").update(u64le(data.length)).update(data)
      } else {
        return null
      }
    }
    return `sha256:${hash.digest("hex")}`
  } catch {
    return null
  }
}

/** `telem@telem  installed, enabled  0.1.0  /path` → `"0.1.0"`; null when not installed. */
export function installedCodexPluginVersion(listOutput: string, ref = CODEX_PLUGIN_REF): string | null {
  for (const line of listOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${ref} `) && trimmed !== ref) continue
    const rest = trimmed.slice(ref.length).trim()
    // "not installed" also contains "installed", so the status is anchored, not searched.
    if (!/^installed\b/.test(rest)) continue
    const version = rest.split(/\s{2,}/).map((cell) => cell.trim()).find((cell) => /^\d+\.\d+\.\d+/.test(cell))
    return version ?? ""
  }
  return null
}

/** The `version` out of a `.codex-plugin/plugin.json`; null when unreadable. */
export function codexPluginVersion(manifestSource: string | null): string | null {
  if (manifestSource === null) return null
  try {
    const parsed: unknown = JSON.parse(manifestSource)
    if (isPlainObject(parsed) && typeof parsed.version === "string") return parsed.version
  } catch {
    /* an unreadable manifest simply means "cannot compare versions" */
  }
  return null
}
