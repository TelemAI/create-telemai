// Migration off the OLD Codex reasoning-capture route.
//
// Before the sibling plugin existed, this installer wrote the reasoning hook into
// the Codex home by hand — three files:
//
//   <codex home>/hooks/telem-reasoning.mjs   the hook itself
//   <codex home>/hooks/telem-reasoning.sh    a POSIX launcher that resolved node
//   <codex home>/hooks.json                  a PreToolUse entry pointing at it
//
// The plugin now carries the hook, so an installed plugin PLUS a surviving hooks.json
// entry means the SAME PreToolUse hook fires twice on every telem_search — two
// competing `updatedInput` replacements for one tool call. That is why removing the
// old route is not optional housekeeping: it is a correctness precondition for
// installing the plugin, and the run refuses to install the plugin without it.
//
// It is still CONSENT-GATED and undoable. What it deletes is only ever this
// installer's own three files, matched by exact path — never a hook someone else
// registered, never a `hooks.json` this installer did not write an entry into.
//
// No API key touches any of this — the hook never needed one; identity is Codex's own
// `_meta`, and the key stays in ~/.telem/credentials.json.

/** Files the OLD route wrote under the Codex home, relative to it. */
export const CODEX_HOOKS_DIRNAME = "hooks"
export const CODEX_HOOK_FILENAME = "telem-reasoning.mjs"
export const CODEX_LAUNCHER_FILENAME = "telem-reasoning.sh"
export const CODEX_HOOKS_JSON = "hooks.json"

export type CodexLegacyHooksEdit =
  /** No telem entry in this hooks.json — nothing to migrate. */
  | { status: "absent" }
  /** Remove the telem entry by rewriting the file with this content. */
  | { status: "rewrite"; contents: string }
  /** Our entry was the file's only content: delete the file instead of leaving `{}`. */
  | { status: "remove-file" }
  /** The file will not parse; say so rather than guess at it. */
  | { status: "unparseable"; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Does this ONE handler point at one of OUR old files?
 *
 * Matched on the exact absolute paths this installer would have written, in both the
 * shapes it ever wrote: the launcher as a bare command, and (older, pre-launcher) the
 * hook invoked through node. A command that merely mentions telem is NOT ours.
 *
 * The unit is the HANDLER, not the group that holds it: a user is free to append
 * their own handler to the group this installer created (the shape hooks.json
 * invites — one matcher, several commands), and dropping the whole group because it
 * contains one of ours would silently delete theirs.
 */
function isTelemHandler(hook: unknown, ourCommands: readonly string[]): boolean {
  return (
    isPlainObject(hook) &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    ourCommands.some(
      (ours) => hook.command === ours || hook.command === `node "${ours}"` || hook.command === `node ${ours}`,
    )
  )
}

/**
 * Plan the removal of our PreToolUse handler from an existing `hooks.json`.
 *
 * The removal is filtered at HANDLER level and prunes upward, so nothing that is not
 * ours is ever collateral:
 *
 *   handler → removed when it is one of ours;
 *   group   → removed only once it holds NO handlers at all (a group that still
 *             carries a foreign handler keeps its matcher and every other key);
 *   array   → an emptied `PreToolUse` is pruned rather than left as `[]`;
 *   object  → an emptied `hooks` is pruned too;
 *   file    → removed only when the document is then EMPTY, i.e. it was ours alone.
 *
 * Every other event, every other PreToolUse group, and every unmanaged top-level key
 * is preserved verbatim.
 */
export function planCodexLegacyHooksRemoval(
  source: string | null,
  ourCommands: readonly string[],
  path: string,
): CodexLegacyHooksEdit {
  if (source === null) return { status: "absent" }
  let doc: unknown
  try {
    doc = JSON.parse(source)
  } catch {
    return {
      status: "unparseable",
      reason: `${path} is not valid JSON and will not be rewritten; remove the telem PreToolUse entry from it by hand, then re-run`,
    }
  }
  if (!isPlainObject(doc)) {
    return {
      status: "unparseable",
      reason: `${path} is not a JSON object and will not be rewritten; remove the telem PreToolUse entry from it by hand, then re-run`,
    }
  }
  const hooks = doc.hooks
  if (!isPlainObject(hooks)) return { status: "absent" }
  const preToolUse = hooks.PreToolUse
  if (!Array.isArray(preToolUse)) return { status: "absent" }
  let removedAny = false
  const kept: unknown[] = []
  for (const entry of preToolUse) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry)
      continue
    }
    const keptHandlers = entry.hooks.filter((hook) => !isTelemHandler(hook, ourCommands))
    if (keptHandlers.length === entry.hooks.length) {
      // Untouched: pushed as-is, so a group we do not edit round-trips byte-faithfully.
      kept.push(entry)
      continue
    }
    removedAny = true
    // A group whose OTHER handlers survive keeps everything else about it — its
    // matcher, and any key this installer knows nothing about.
    if (keptHandlers.length) kept.push({ ...entry, hooks: keptHandlers })
  }
  if (!removedAny) return { status: "absent" }

  const nextHooks: Record<string, unknown> = { ...hooks }
  if (kept.length) nextHooks.PreToolUse = kept
  else delete nextHooks.PreToolUse
  const nextDoc: Record<string, unknown> = { ...doc }
  if (Object.keys(nextHooks).length) nextDoc.hooks = nextHooks
  else delete nextDoc.hooks
  if (!Object.keys(nextDoc).length) return { status: "remove-file" }
  return { status: "rewrite", contents: `${JSON.stringify(nextDoc, null, 2)}\n` }
}
