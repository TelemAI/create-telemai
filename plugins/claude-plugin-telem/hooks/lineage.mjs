#!/usr/bin/env node
// Telem PreToolUse lineage hook — session threading by code, zero token.
//
// Channel B — the `telem_bridge` tool parameter — is Claude Code's only lineage
// channel: the host sends no stable conversation id on an MCP call of its own.
//
// Claude Code fires this synchronously before every `telem_search` / `telem_fetch`
// call (matcher in hooks/hooks.json). It reads the PreToolUse payload on stdin,
// derives a trajectory-v5 lineage envelope from what the host already knows —
//   session_id -> conversation_id   (one Claude session -> one Telem swimlane)
//   prompt_id  -> message_id        (one turn -> one node; two calls in a turn share it)
//   tool_use_id -> tool_call_id     (two calls in a turn -> two distinct sibling nodes)
//   window_id  <- hooks/window.mjs' state file ("none" until the first compaction)
//   agent_id   -> subagent swimlane (conversation_id = session_id:agent_id) + a
//                 pre-computed orchestrator ancestor snapshot;
//                 top-level (agent_id absent) keeps ancestors=[] (threading, not
//                 parentage
// — and injects it as `telem_bridge = base64url(JSON(envelope))` by REPLACING the
// tool input with an exact echo of the original plus that one key (updatedInput
// replaces the whole object — probe-proven in
// a host probe).
//
// FAIL-OPEN, ALWAYS. Any error, malformed/empty payload, or a missing session_id /
// prompt_id / tool_input -> emit nothing and exit 0, so Claude Code proceeds with the
// ORIGINAL input and the search still runs goal-only. A hook that emits nothing never
// blocks a tool call. Zero dependencies (node built-ins only). No network. window_id
// comes from the state file, not the transcript. The one transcript touch on the hot
// path is a BOUNDED tail read for the turn's visible assistant text
// (readCurrentReasoning): the last TAIL_BYTES only, fail-open to history:[], inside
// the p95 <= 50 ms budget.
//
// HOSTED OPTIONS:
// emit additionally resolves the user's .telem config (project <cwd>/.telem/telem.json
// > user ~/.telem/telem.json > TELEM_* env — the vendored reader in telem-config.mjs,
// cwd from the PreToolUse payload) into the composed V2 `search` block, strips
// `provider_overrides` (excluded from this channel in v1), and ships the result as the
// envelope's `options` key — INSIDE the bridge, so updatedInput still gains exactly one
// key. The config step has its OWN try/catch degrading to "no options" (D8): a config
// throw must never cost the lineage. Warnings go to stderr (debug-only on this host).

import { readFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { build_snapshot } from "./v5hash.mjs";
import { searchBlockFromConfig } from "./telem-config.mjs";

const HARNESS = "claude-code";
const ENVELOPE_VERSION = 1;
const WINDOW_NONE = "none";
const STATE_FILENAME = "window.json";

// The fixed message_id sentinel every subagent uses for its orchestrator ancestor
// snapshot (, Option A). It is a CONSTANT — not the real orchestrator turn id —
// so all N subagents of one conversation derive the IDENTICAL orchestrator node_key
// (snapshot_node_key(harness, session_id, ORCH_CONST)) and hang off one shared root.
const ORCH_CONST = "orchestrator";

// The visible-reasoning cap: the SAME value every other trajectory-v5 producer applies
// (the Python SDK's trajectory helpers HISTORY_TEXT_CAP, mirrored in the MCP envelope
// validator). A node that emits 40x what its siblings do is the odd shape in one tree.
const HISTORY_TEXT_CAP = 128000;

// The envelope options cap (hosted-options spec D8/the contract), mirrored server-side: the
// composed block is dropped HERE, with a warning, when its compact JSON exceeds this —
// so the server's own 4 KB whitelist cap only ever fires on forged bridges, and the
// honest path warns instead of silently losing config.
const OPTIONS_MAX_BYTES = 4096;

// Hot-path bounds for the transcript read ( p95 <= 50 ms; "bounded tail read").
// We read only the LAST TAIL_BYTES of the transcript via a positioned fd read — O(tail),
// independent of how long the session is — and skip entirely above MAX_TRANSCRIPT_BYTES
// as a pathological-file guard so a giant attachment can never blow the latency budget.
const TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// The window-generation state file hooks/window.mjs maintains. Kept in the plugin's
// own root (writable for a locally installed plugin) so an isolated CLAUDE_CONFIG_DIR
// stays self-contained; TMPDIR is only a last resort when the hook env is bare.
export function stateFilePath() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const dir = root && root.trim() ? root : process.env.TMPDIR || "/tmp";
  return join(dir, STATE_FILENAME);
}

// Read the current context-window generation for a session. Fail-open: any missing
// file, unreadable JSON, or absent/zero generation reads as "none" (the documented
// pre-compaction value). Never throws.
export function readWindowId(sessionId, path = stateFilePath()) {
  try {
    if (typeof sessionId !== "string" || !sessionId) return WINDOW_NONE;
    const state = JSON.parse(readFileSync(path, "utf8"));
    const entry = state && state.sessions ? state.sessions[sessionId] : undefined;
    const generation = entry ? entry.generation : undefined;
    if (typeof generation === "number" && Number.isFinite(generation) && generation > 0) {
      return String(generation);
    }
    return WINDOW_NONE;
  } catch {
    return WINDOW_NONE;
  }
}

// Read the transcript TAIL only — the last TAIL_BYTES bytes via a positioned fd read,
// so the cost is O(tail) no matter how long the session is. Returns the trimmed,
// non-empty JSONL lines (the partial first line, sliced mid-record when we start past
// byte 0, is dropped), or null on any error / an oversized file. Never throws.
function readTranscriptTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    if (size > MAX_TRANSCRIPT_BYTES) return null;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.toString("utf8", 0, got).split("\n");
    if (start > 0 && lines.length) lines.shift(); // first line is a partial record
    return lines.map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// The concatenated visible text of an assistant transcript entry, or "" when it has no
// text block (a redacted `thinking` block carries thinking="" and no text, so it yields
// "" here and is skipped by the caller — that is the redaction case).
function assistantText(obj) {
  if (obj === null || typeof obj !== "object" || obj.type !== "assistant") return "";
  const content = obj.message ? obj.message.content : undefined;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

// Whether an assistant transcript entry emits the given tool_use id.
function containsToolUse(obj, id) {
  if (obj === null || typeof obj !== "object" || obj.type !== "assistant") return false;
  const content = obj.message ? obj.message.content : undefined;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === "tool_use" && b.id === id);
}

// Whether an entry is the START of a user turn — a real user message, as opposed to
// the tool-result record Claude Code also writes with `type: "user"`. Real turns carry
// no `toolUseResult`; a result entry's content is tool_result blocks.
function isUserTurn(obj) {
  if (obj === null || typeof obj !== "object" || obj.type !== "user") return false;
  if (obj.toolUseResult !== undefined) return false;
  const content = obj.message ? obj.message.content : undefined;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && block.type !== "tool_result");
}

// The visible assistant reasoning for the pending tool call, as a v5 message-history
// list: `[{role:"assistant", content:<preamble>}]`, or `[]` when there is none. Under the
// OAuth/subscription harness the model's `thinking` is redacted (empty + signature), but
// the "explain first" preamble it wrote as a `text` block IS complete on disk.
// This reads it from the transcript tail: it finds the entry emitting the
// pending `tool_use_id` (usually not yet written at PreToolUse time), then the most recent
// assistant entry at-or-before it that carries text. FAIL-OPEN — a missing/oversized/
// unreadable transcript or no text at all yields `[]` (v1 behaviour). Never throws.
export function readCurrentReasoning(payload) {
  try {
    if (payload === null || typeof payload !== "object") return [];
    // A subagent PreToolUse carries the ORCHESTRATOR's transcript_path, not the
    // subagent's own. Reading transcript_path for a subagent
    // would attach the orchestrator's most-recent assistant text — the spawn line —
    // to every subagent search node, identically and uniformly wrong. But the
    // subagent's OWN transcript is derivable at fire time and carries its real
    // reasoning: `<dir>/<session_id>/subagents/agent-<agent_id>.jsonl` (the
    // agent_transcript_path SubagentStop reports, minus the wait). Read THAT for a
    // subagent, the orchestrator transcript for a top-level call.
    const parentPath = payload.transcript_path;
    if (typeof parentPath !== "string" || parentPath === "") return [];
    const agentId = payload.agent_id;
    const isSubagent = typeof agentId === "string" && agentId !== "";
    let path = parentPath;
    if (isSubagent) {
      const sessionId = payload.session_id;
      if (typeof sessionId !== "string" || sessionId === "") return [];
      path = join(dirname(parentPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
    }
    const lines = readTranscriptTail(path);
    if (lines === null) return [];

    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip a record we cannot parse */
      }
    }

    // If the pending tool_use is already on disk, do not read text from a later turn:
    // cap the scan at the entry that emits it (inclusive — one entry may hold both the
    // text and the tool_use). Usually it is absent, so the cap is the full tail.
    let cutoff = entries.length;
    const toolUseId = payload.tool_use_id;
    if (typeof toolUseId === "string" && toolUseId !== "") {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (containsToolUse(entries[i], toolUseId)) {
          cutoff = i + 1;
          break;
        }
      }
    }

    // The scan also needs a FLOOR — this turn's own start. Without one the walk leaves
    // the turn on any call the model makes with no preamble (a search as its first
    // action, which is common) and returns the previous turn's text: prose about a
    // different task, attached to a node that says it explains this search. When no
    // turn start is on the tail, send nothing rather than text from a turn we cannot
    // identify.
    let floor = -1;
    for (let i = cutoff - 1; i >= 0; i--) {
      if (isUserTurn(entries[i])) {
        floor = i;
        break;
      }
    }
    if (floor < 0) return [];

    for (let i = cutoff - 1; i > floor; i--) {
      const text = assistantText(entries[i]);
      if (text) {
        return [{ role: "assistant", content: text.slice(0, HISTORY_TEXT_CAP) }];
      }
    }
    return [];
  } catch {
    return [];
  }
}

// Default warning sink for the config step: stderr, never stdout (stdout is the hook
// protocol). Hook stderr is debug-only on this host — an accepted, recorded limitation
// of the v1 surface (spec D8); the server-side notices cover the forged/drifted cases.
function warnToStderr(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* a broken stderr must not cost the envelope */
  }
}

// Resolve the user's .telem config into the hosted `options` payload, or undefined for
// "no options key" (hosted-options the design notes/D8). This is the WRAPPER above the
// vendored, unforked reader in telem-config.mjs:
//   1. searchBlockFromConfig (vendored resolve + the three composition rules) with an
//      explicit stderr sink for reader/composition warnings;
//   2. STRIP `provider_overrides` — excluded from this channel in v1 (D3); one warning
//      naming the hosted surface, only when the key was actually present;
//   3. drop the whole block, with a warning, when its compact JSON exceeds
//      OPTIONS_MAX_BYTES (D8 mirrors the server cap hook-side);
//   4. return the non-empty block, or undefined.
//
// `cwd` comes from the PreToolUse payload; absent/non-string cwd -> the user + env
// levels only (D2). `env`/`warn` are the injectable seams the tests need; production
// callers pass (payload.cwd, env) and keep the defaults. `blockSource` exists ONLY so
// tests can drive the wrapper's own guards (a throwing reader, an empty-after-strip
// block) — never pass it in production code.
//
// OWN try/catch, deliberately (D8): emit's outer catch returns "" — the no-envelope
// path — and a config failure must degrade to "lineage without options", never to
// "no lineage". Never throws.
export function readConfigOptions(cwd, env = process.env, warn = warnToStderr, blockSource = searchBlockFromConfig) {
  try {
    const projectRoot = typeof cwd === "string" && cwd !== "" ? cwd : undefined;
    const block = blockSource(env, projectRoot, warn);
    if (block === null || typeof block !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(block, "provider_overrides")) {
      delete block.provider_overrides;
      warn(
        "[telem] ignoring provider_overrides from .telem config: the hosted MCP transport " +
          "does not carry provider_overrides in v1, so it is stripped from the lineage " +
          "envelope; the rest of the resolved search options still apply.",
      );
    }
    if (Object.keys(block).length === 0) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(block), "utf8");
    if (bytes > OPTIONS_MAX_BYTES) {
      warn(
        `[telem] dropping the resolved search options: the composed block is ${bytes} bytes ` +
          `as compact JSON, over the ${OPTIONS_MAX_BYTES}-byte cap for the hosted lineage ` +
          "envelope. Trim the .telem config (fields/providers lists) to restore it.",
      );
      return undefined;
    }
    return block;
  } catch {
    return undefined;
  }
}

// Build the contract lineage envelope, or null when the payload cannot yield a
// well-formed one. The three load-bearing fields are session_id (conversation),
// prompt_id (turn), and an echo-able tool_input object; without any one of them the
// hook stays silent and the call goes out unmodified.
//
// Subagent delegation. `agent_id` is null/absent at top level and a
// stable id per subagent; `session_id` is SHARED across orchestrator + subagents so
// it does NOT distinguish them — `agent_id` does. The subagent's own lineage stays
// RAW ids (the Telem backend derives), with two differences from a top-level turn:
//   - conversation_id = `${session_id}:${agent_id}` — a DISTINCT session_key per
//     subagent = its own swimlane (session_id alone would flatten all N into one).
//   - ancestors = [ ONE full orchestrator snapshot ] so the swimlane hangs off the
//     parent conversation. The ancestor is a pre-computed build_snapshot keyed on
//     the RAW session_id + the ORCH_CONST sentinel (Option A: the hook computes it in
//     JS, golden-pinned to Python) — a FULL snapshot, because a bare id / missing
//     node_key makes the backend drop the WHOLE envelope. Every subagent of
//     one conversation emits the identical orchestrator node_key, so 5 subagents = 5
//     sibling swimlanes under one shared orchestrator root, not one flat session.
// A top-level turn keeps ancestors:[] — an ancestor is a delegation to a DIFFERENT
// agent, which a turn is not.
// `options` (hosted-options spec D1): the composed V2 `search` block from
// readConfigOptions, attached as the envelope's `options` key when present. It rides
// INSIDE the bridge — the model-facing tool schema gains nothing (D9), and updatedInput
// still adds exactly one key.
export function buildEnvelope(payload, windowId, history = [], options = undefined) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const sessionId = payload.session_id;
  const promptId = payload.prompt_id;
  const toolUseId = payload.tool_use_id;
  const toolInput = payload.tool_input;
  const agentId = payload.agent_id;

  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof promptId !== "string" || promptId === "") return null;
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return null;
  }

  const resolvedWindow = typeof windowId === "string" && windowId ? windowId : WINDOW_NONE;
  const isSubagent = typeof agentId === "string" && agentId !== "";

  const lineage = {
    harness: HARNESS,
    conversation_id: isSubagent ? `${sessionId}:${agentId}` : sessionId,
    window_id: resolvedWindow,
    message_id: promptId,
  };
  if (typeof toolUseId === "string" && toolUseId !== "") {
    lineage.tool_call_id = toolUseId;
  }
  lineage.ancestors = isSubagent
    ? [
        build_snapshot({
          harness: HARNESS,
          conversationId: sessionId,
          windowId: resolvedWindow,
          messageId: ORCH_CONST,
          context: [],
          ancestors: [],
        }),
      ]
    : [];
  lineage.history = Array.isArray(history) ? history : [];

  const envelope = { v: ENVELOPE_VERSION, lineage };
  if (options !== undefined) envelope.options = options;
  return envelope;
}

export function encodeBridge(envelope) {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

// The PreToolUse hookSpecificOutput, or null to emit nothing. updatedInput REPLACES
// the whole tool input, so it MUST echo the original verbatim and add only
// telem_bridge.
export function buildHookOutput(payload, windowId, history = [], options = undefined) {
  const envelope = buildEnvelope(payload, windowId, history, options);
  if (envelope === null) return null;
  const telem_bridge = encodeBridge(envelope);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...payload.tool_input, telem_bridge },
    },
  };
}

// The full hot path: payload object -> the JSON string to print, or "" for "emit
// nothing". Resolves window_id from the state file, then the .telem config into the
// envelope's `options` (readConfigOptions fail-opens on its own — a config throw can
// never take the "" path here, D8). The hook does not branch by tool: telem_fetch
// calls carry options exactly as telem_search calls do (spec the contract). `env` is the
// injectable seam for hermetic tests; the CLI path keeps process.env. Never throws.
export function emit(payload, env = process.env) {
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
    const windowId = readWindowId(payload.session_id);
    const history = readCurrentReasoning(payload);
    const options = readConfigOptions(payload.cwd, env);
    const out = buildHookOutput(payload, windowId, history, options);
    return out === null ? "" : JSON.stringify(out);
  } catch {
    return "";
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let output = "";
    try {
      output = emit(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      output = "";
    }
    // Exit only once stdout has actually drained. `process.exit` does not flush a
    // pipe, and stdout IS a pipe here — an output larger than the pipe buffer (64 KB
    // on macOS) was being cut mid-JSON, so a long preamble made the hook emit a
    // half-object instead of degrading to no envelope. The callback fires after the
    // write completes; the timer is the belt for a host that never drains us.
    if (!output) process.exit(0);
    const bail = setTimeout(() => process.exit(0), 2000);
    bail.unref();
    process.stdout.write(output, () => process.exit(0));
  });
  process.stdin.on("error", () => process.exit(0));
}
