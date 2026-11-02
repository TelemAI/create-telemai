// The Cursor surface: Cursor's own agent (the editor's agent chat), which reads the user's
// MCP servers from `~/.cursor/mcp.json` and the user's hooks from `~/.cursor/hooks.json`.
//
// Three writes, and the KEY is in no command:
//
//  * `~/.cursor/mcp.json` — `mcpServers.telem`: the hosted Telem MCP (`url` + `headers`, the
//    key as a literal header, 0600). mcp-json.ts has the rules.
//  * `~/.cursor/hooks.json` — two handlers of the lineage hook: `preToolUse` with
//    `--harness cursor` (the bridge), and `afterAgentThought` with `--harness cursor --thought`,
//    which records the model's thinking so the next Telem call carries it as reasoning. Cursor's
//    format (version 1, camelCase events, flat handlers with an optional regex `matcher` on the
//    tool name, `timeout` in seconds). Cursor's payload names its ids conversation_id /
//    generation_id / tool_use_id, and it reads a flat `updated_input`; the hook maps both
//    (lineage.mjs adaptCursorPayload). The thoughts wait in `cursor-thoughts.json` (0600) in the
//    hook folder until a Telem call takes them; a new turn drops the old turn's.
//  * the hook scripts and the Telem skill — copied from the Claude Code plugin this package
//    ships: the scripts to `~/.telem/plugins/cursor-telem/hooks/`, the skill to
//    `~/.cursor/skills/telem/SKILL.md` (a user skill Cursor loads in every project).
//
// Not `~/.claude/settings.json`: Cursor reads Claude Code's hooks from there too, but Claude Code
// would then run the hook as well. Cursor's CLOUD agents ignore `updated_input` for HTTP MCP tools
// (Cursor's docs); the search still runs there, with the model's goal and context only.

import { join } from "node:path"

import { isObj, parseJsonObject, type Json } from "./mcp-json.ts"

/** Cursor matches this regex against the tool name; the hook checks the name again itself. */
export const CURSOR_HOOK_MATCHER = "telem_(search|fetch)"
/** Seconds Cursor waits for the hook. It only reads files. */
const CURSOR_HOOK_TIMEOUT = 30
/** Where the run planner copies the hook scripts, under the user's Telem directory. */
export const CURSOR_HOOK_DIRNAME = "cursor-telem"
const HARNESS_FLAG = "--harness cursor"

/** Cursor's per-user directory. */
export function cursorHome(home: string): string {
  return join(home, ".cursor")
}
export function cursorMcpPath(cursorDir: string): string {
  return join(cursorDir, "mcp.json")
}
export function cursorHooksPath(cursorDir: string): string {
  return join(cursorDir, "hooks.json")
}
export function cursorSkillPath(cursorDir: string): string {
  return join(cursorDir, "skills", "telem", "SKILL.md")
}
/** `~/.telem/plugins/cursor-telem`: the copied hook scripts live in its `hooks/`. */
export function cursorHookDir(home: string): string {
  return join(home, ".telem", "plugins", CURSOR_HOOK_DIRNAME)
}
/** The command Cursor runs before a Telem tool call. */
export function cursorHookCommand(hookDir: string): string {
  return `node "${join(hookDir, "hooks", "lineage.mjs")}" ${HARNESS_FLAG}`
}
/** The command Cursor runs after each model thought: it records the thought. */
export function cursorThoughtCommand(hookDir: string): string {
  return `${cursorHookCommand(hookDir)} --thought`
}

function isTelemHandler(handler: unknown): boolean {
  return (
    isObj(handler) &&
    typeof handler.command === "string" &&
    handler.command.replaceAll("\\", "/").includes(`${CURSOR_HOOK_DIRNAME}/hooks/lineage.mjs`)
  )
}

export type CursorHooksEdit =
  | { status: "unchanged" }
  | { status: "write"; contents: string; created: boolean; changes: string[]; addedHook: boolean }
  | { status: "unparseable"; reason: string }

/** `prior` with `handler` in place of our first handler; any other copy of ours removed. */
function placed(prior: unknown[], handler: Json): unknown[] {
  const next: unknown[] = []
  let done = false
  for (const entry of prior) {
    if (!isTelemHandler(entry)) next.push(entry)
    else if (!done) {
      next.push(handler)
      done = true
    }
  }
  if (!done) next.push(handler)
  return next
}

/** Our two handlers in Cursor's hooks.json (`preToolUse` for the bridge, `afterAgentThought` for
 * the reasoning). Pure: source in, edit out. Every other handler and event stays as it was. */
export function planCursorHooks(source: string | null, hookDir: string, path: string): CursorHooksEdit {
  const file = parseJsonObject(source)
  if (file === "unparseable") {
    return { status: "unparseable", reason: `${path} is not a JSON object; fix or move it, then re-run` }
  }
  const out: Json = { ...(file ?? {}) }
  if (out.version === undefined) out.version = 1
  else if (out.version !== 1) {
    return { status: "unparseable", reason: `${path} has version ${JSON.stringify(out.version)}, not 1; fix it, then re-run` }
  }
  if (out.hooks !== undefined && !isObj(out.hooks)) {
    return { status: "unparseable", reason: `${path} has a hooks that is not an object; fix it, then re-run` }
  }
  const hooks = { ...((out.hooks ?? {}) as Json) }
  const wanted: [string, Json][] = [
    ["preToolUse", { command: cursorHookCommand(hookDir), matcher: CURSOR_HOOK_MATCHER, timeout: CURSOR_HOOK_TIMEOUT }],
    ["afterAgentThought", { command: cursorThoughtCommand(hookDir), timeout: CURSOR_HOOK_TIMEOUT }],
  ]
  for (const [event] of wanted) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      return { status: "unparseable", reason: `${path} has a hooks.${event} that is not a list; fix it, then re-run` }
    }
  }
  const addedHook = !(hooks.preToolUse as unknown[] | undefined)?.some(isTelemHandler)
  const changes: string[] = []
  for (const [event, handler] of wanted) {
    const prior = (hooks[event] ?? []) as unknown[]
    const next = placed(prior, handler)
    if (JSON.stringify(next) !== JSON.stringify(prior)) {
      hooks[event] = next
      changes.push(prior.some(isTelemHandler) ? `update the telem ${event} hook` : `add the telem ${event} hook`)
    }
  }
  if (!changes.length) return { status: "unchanged" }
  out.hooks = hooks
  return { status: "write", contents: `${JSON.stringify(out, null, 2)}\n`, created: source === null, changes, addedHook }
}

/** How to put hooks.json back. */
export function cursorHooksUndoLine(edit: { created: boolean; addedHook: boolean }, path: string, hookDir: string): string {
  if (edit.created) return `rm ${path} and rm -r ${hookDir}`
  return edit.addedHook
    ? `in ${path}: remove the hooks.preToolUse and hooks.afterAgentThought handlers that run ${CURSOR_HOOK_DIRNAME}/hooks/lineage.mjs, and delete ${hookDir}`
    : `in ${path}: undo the edits listed above`
}
