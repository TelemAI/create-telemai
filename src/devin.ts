// The Devin surface: Devin Desktop (formerly Windsurf) and its local agent, Devin Local, which
// is the Devin CLI's agent harness. Both read the user's config from the Devin config directory
// (`~/.config/devin`, `%APPDATA%\devin` on Windows).
//
// Three writes, and the KEY is in no command:
//
//  * `<devin dir>/mcp_config.json` — `mcpServers.telem`: the hosted Telem MCP (`url` + `headers`,
//    the key as a literal header, 0600). Devin infers Streamable HTTP from `url`. mcp-json.ts has
//    the rules.
//  * `<devin dir>/config.json` — the `hooks` key: one PreToolUse group (matcher a regex on the tool
//    name, `mcp__telem__telem_search`) that runs the lineage hook with `--harness devin`. Devin's
//    payload has session_id and a per-turn prompt_id, no call id and no cwd (DEVIN_PROJECT_DIR);
//    it merges `hookSpecificOutput.updatedInput` into the call. The hook reads the model's thinking
//    for the call from Devin's own session file (`~/.local/share/devin/cli/sessions.db`, read-only,
//    Node 22.13+). The rest of config.json is Devin's and is kept.
//  * the hook scripts and the Telem skill — copied from the Claude Code plugin this package ships:
//    the scripts to `~/.telem/plugins/devin-telem/hooks/`, the skill to
//    `<devin dir>/skills/telem/SKILL.md` (a global skill).
//
// Not `~/.claude/settings.json` (Devin reads Claude Code's hooks from there too, but Claude Code
// would then run the hook as well), and not a Devin plugin: Devin runs plugin hooks best effort.
// Devin Desktop's older agent, Cascade, has hooks of its own format that cannot change a call's
// input; it gets the MCP server through its own config, not this one.

import { join } from "node:path"

import { isObj, parseJsonObject, type Json } from "./mcp-json.ts"

/** Devin matches this regex against the tool name (`mcp__telem__telem_search`). */
export const DEVIN_HOOK_MATCHER = "telem_(search|fetch)$"
/** Seconds Devin waits for the hook. It only reads files. */
const DEVIN_HOOK_TIMEOUT = 30
/** Where the run planner copies the hook scripts, under the user's Telem directory. */
export const DEVIN_HOOK_DIRNAME = "devin-telem"
const HARNESS_FLAG = "--harness devin"

/** The Devin config directory: `%APPDATA%\devin` on Windows, else `~/.config/devin`. */
export function devinConfigDir(env: Record<string, string | undefined>, home: string, platform: string): string {
  if (platform === "win32") return join((env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming"), "devin")
  return join(home, ".config", "devin")
}
export function devinMcpPath(devinDir: string): string {
  return join(devinDir, "mcp_config.json")
}
export function devinConfigPath(devinDir: string): string {
  return join(devinDir, "config.json")
}
export function devinSkillPath(devinDir: string): string {
  return join(devinDir, "skills", "telem", "SKILL.md")
}
/** `~/.telem/plugins/devin-telem`: the copied hook scripts live in its `hooks/`. */
export function devinHookDir(home: string): string {
  return join(home, ".telem", "plugins", DEVIN_HOOK_DIRNAME)
}
/** The command Devin runs before a Telem tool call. */
export function devinHookCommand(hookDir: string): string {
  return `node "${join(hookDir, "hooks", "lineage.mjs")}" ${HARNESS_FLAG}`
}

function isTelemHandler(handler: unknown): boolean {
  return (
    isObj(handler) &&
    typeof handler.command === "string" &&
    handler.command.replaceAll("\\", "/").includes(`${DEVIN_HOOK_DIRNAME}/hooks/lineage.mjs`)
  )
}

/**
 * `hooks.PreToolUse` with our handler in place (the Muse rules): the first group holding one
 * gets our handler there; any other copy of ours is removed (and a group it leaves empty with
 * it); a file without ours gets a new group. A group that shares ours with the user's handlers
 * under another matcher keeps them and that matcher, and ours moves to a group of its own just
 * before it.
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
      if (!others.length || group.matcher === DEVIN_HOOK_MATCHER) {
        const at = group.hooks.findIndex(isTelemHandler)
        const hooks = [...others]
        hooks.splice(at, 0, handler)
        out.push({ ...group, matcher: DEVIN_HOOK_MATCHER, hooks })
        continue
      }
      out.push({ matcher: DEVIN_HOOK_MATCHER, hooks: [handler] })
    }
    if (others.length) out.push({ ...group, hooks: others })
  }
  if (!placed) out.push({ matcher: DEVIN_HOOK_MATCHER, hooks: [handler] })
  return out
}

export type DevinConfigEdit =
  | { status: "unchanged" }
  | { status: "write"; contents: string; created: boolean; changes: string[]; addedHook: boolean }
  | { status: "unparseable"; reason: string }

/** Our PreToolUse hook in Devin's config.json. Pure: source in, edit out. */
export function planDevinConfig(source: string | null, command: string, path: string): DevinConfigEdit {
  const file = parseJsonObject(source)
  if (file === "unparseable") {
    return { status: "unparseable", reason: `${path} is not a JSON object; fix or move it, then re-run` }
  }
  const out: Json = { ...(file ?? {}) }
  if (out.hooks !== undefined && !isObj(out.hooks)) {
    return { status: "unparseable", reason: `${path} has a hooks that is not an object; fix it, then re-run` }
  }
  const hooks = { ...((out.hooks ?? {}) as Json) }
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) {
    return { status: "unparseable", reason: `${path} has a hooks.PreToolUse that is not a list; fix it, then re-run` }
  }
  const prior = (hooks.PreToolUse ?? []) as unknown[]
  const next = withTelemHook(prior, { type: "command", command, timeout: DEVIN_HOOK_TIMEOUT })
  const addedHook = !prior.some((group) => isObj(group) && Array.isArray(group.hooks) && group.hooks.some(isTelemHandler))
  const changes: string[] = []
  if (JSON.stringify(next) !== JSON.stringify(prior)) {
    out.hooks = { ...hooks, PreToolUse: next }
    changes.push(addedHook ? "add the telem PreToolUse hook" : "update the telem PreToolUse hook")
  }
  if (!changes.length) return { status: "unchanged" }
  return { status: "write", contents: `${JSON.stringify(out, null, 2)}\n`, created: source === null, changes, addedHook }
}

/** How to put config.json back. */
export function devinConfigUndoLine(edit: { created: boolean; addedHook: boolean }, path: string, hookDir: string): string {
  if (edit.created) return `rm ${path} and rm -r ${hookDir}`
  return edit.addedHook
    ? `in ${path}: remove the hooks.PreToolUse group that runs ${DEVIN_HOOK_DIRNAME}/hooks/lineage.mjs, and delete ${hookDir}`
    : `in ${path}: undo the edits listed above`
}
