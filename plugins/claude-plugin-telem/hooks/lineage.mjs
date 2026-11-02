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
// FAIL-OPEN, with ONE exception. Any error, malformed/empty payload, or a missing
// session_id / prompt_id / tool_input -> emit nothing and exit 0, so Claude Code
// proceeds with the ORIGINAL input and the search still runs goal-only. A hook that
// emits nothing never blocks a tool call. The exception (owner design, 2026-10-26):
// when the .telem config's providersExclude removes every provider in its
// providersInclude, a telem_search is DENIED with the reason, because running it
// without the provider lists would search the default set, which can hold the
// provider the user excluded. A telem_fetch reads no provider lists and goes on, with
// its fetch options. Zero dependencies (node built-ins only). No network. window_id
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
//
// HOSTED FETCH OPTIONS: the same
// one resolution also yields the fetch block (fetchProviders / fetchTier / fetchNoCache ->
// providers / tier / no_cache), shipped as the envelope's top-level `fetch_options` key on
// EVERY call, search included — each server path reads only its own slot.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, openSync, fstatSync, readSync, closeSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build_snapshot } from "./v5hash.mjs";
import { ConfigRefusal, fetchBlockFromConfig, hostedBlocksFromConfig } from "./telem-config.mjs";

const HARNESS = "claude-code";
const ENVELOPE_VERSION = 1;

// The tools this hook acts on: Telem's own search and fetch, under any host's naming
// (`mcp__plugin_telem_telem__telem_search` in Claude Code, `telem-telem_search` in VS
// Code's Copilot harness). Matched on the suffix, never on a host's prefix.
const TELEM_TOOL = /telem_(search|fetch)$/;

// The hosts this hook knows. Claude Code is the default; the Copilot plugin's hooks.json
// passes `--harness copilot` (GitHub Copilot's agent, in VS Code and Copilot CLI).
// Hosts whose hook command passes `--harness <name>` (their hook files are written by the
// installer, not hooks/hooks.json). Each name is also the router's client name.
const HARNESSES = new Set([HARNESS, "copilot", "cursor", "devin"]);
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

// Copilot gives PreToolUse no prompt_id. Its UserPromptSubmit hook (window.mjs
// "user-prompt") records each prompt's timestamp per session, and that is the turn.
// Fail-open: no record reads as "none". Never throws.
export function readTurnId(sessionId, path = stateFilePath()) {
  try {
    if (typeof sessionId !== "string" || !sessionId) return WINDOW_NONE;
    const state = JSON.parse(readFileSync(path, "utf8"));
    const entry = state && state.sessions ? state.sessions[sessionId] : undefined;
    const turn = entry ? entry.turn : undefined;
    return typeof turn === "string" && turn ? turn : WINDOW_NONE;
  } catch {
    return WINDOW_NONE;
  }
}

// Copilot's PreToolUse payload is Claude-shaped, but it has no prompt_id, tool_use_id or
// transcript_path. Fill the two ids so buildEnvelope can run: the turn from the
// UserPromptSubmit record, and a call id hashed from what tells two calls apart (two
// calls in one assistant message can share a millisecond, so the timestamp alone is not
// enough). An id the host does send is kept (VS Code's Local agent sends tool_use_id).
// History stays [] on purpose (emit): Copilot keeps its model's reasoning encrypted.
export function adaptCopilotPayload(payload, path = stateFilePath()) {
  const out = { ...payload };
  if (typeof out.prompt_id !== "string" || !out.prompt_id) out.prompt_id = readTurnId(out.session_id, path);
  if (typeof out.tool_use_id !== "string" || !out.tool_use_id) {
    const parts = [String(out.timestamp ?? ""), String(out.tool_name ?? ""), JSON.stringify(out.tool_input ?? null)];
    out.tool_use_id = "copilot-" + createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  }
  return out;
}

// Cursor's preToolUse payload (its agent runtime's PreToolUseRequestQuery, lab-read
// 2026-11-02) names the ids its own way: conversation_id (the chat), generation_id (one
// model turn), tool_use_id (the call), plus cwd and workspace_roots. Map them onto the
// Claude names buildEnvelope reads. A tool_input sent as a JSON string is parsed. An id
// already under the Claude name is kept.
export function adaptCursorPayload(payload) {
  const out = { ...payload };
  if (typeof out.session_id !== "string" || !out.session_id) out.session_id = out.conversation_id;
  if (typeof out.prompt_id !== "string" || !out.prompt_id) out.prompt_id = cursorTurnId(out.generation_id);
  if (typeof out.tool_input === "string") {
    try {
      out.tool_input = JSON.parse(out.tool_input);
    } catch {
      // not JSON: buildEnvelope refuses a non-object input, so the call runs unchanged
    }
  }
  if (typeof out.cwd !== "string" || !out.cwd) {
    const root = Array.isArray(out.workspace_roots) ? out.workspace_roots[0] : undefined;
    if (typeof root === "string" && root) out.cwd = root;
  }
  return out;
}

// Cursor's reasoning. Cursor sends no reasoning in preToolUse, but its afterAgentThought hook
// carries the model's thinking `text` for each step (conversation_id, generation_id; lab,
// 2026-11-02; each thought arrives twice). `lineage.mjs --harness cursor --thought` records the
// thoughts of the conversation's current turn in a small state file next to the hook scripts
// (0600: it holds reasoning text, so never /tmp); the next Telem call takes them, so each call
// carries the reasoning since the turn began or since the previous Telem call (the Codex rule).
// A new turn drops the old turn's thoughts. Fail-open everywhere: a lost thought costs only
// reasoning, never the call.
const THOUGHTS_FILENAME = "cursor-thoughts.json";
const THOUGHTS_MAX_CONVERSATIONS = 20;
const THOUGHTS_MAX_PER_TURN = 200;

/** Cursor's turn id. One of each thought's two copies carries the turn's generation_id with a
 * step suffix (`<uuid>-0-dxxm`, `<uuid>-1-7sr5`, …; lab, 2026-11-02); preToolUse carries the bare
 * uuid. Both mean the same turn. */
export function cursorTurnId(id) {
  if (typeof id !== "string") return id;
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+-[0-9a-z]+$/i.exec(id);
  return m ? m[1] : id;
}

/** `<hook root>/cursor-thoughts.json`: the folder that holds `hooks/`, i.e. the installer's copy. */
export function thoughtsFilePath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), THOUGHTS_FILENAME);
}

function readThoughts(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state && typeof state === "object" && state.conversations && typeof state.conversations === "object") return state;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, conversations: {} };
}

function writeThoughts(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Record one afterAgentThought. Never throws. */
export function recordCursorThought(payload, path = thoughtsFilePath(), now = Date.now()) {
  try {
    if (payload === null || typeof payload !== "object") return;
    const conversation = payload.conversation_id || payload.session_id;
    const turn = cursorTurnId(payload.generation_id);
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (typeof conversation !== "string" || !conversation || typeof turn !== "string" || !turn || !text) return;
    const state = readThoughts(path);
    const prior = state.conversations[conversation];
    const entry = prior && prior.turn === turn && Array.isArray(prior.thoughts) ? prior : { turn, thoughts: [] };
    if (!entry.thoughts.includes(text) && entry.thoughts.length < THOUGHTS_MAX_PER_TURN) entry.thoughts.push(text);
    entry.at = now;
    state.conversations[conversation] = entry;
    const ids = Object.keys(state.conversations);
    if (ids.length > THOUGHTS_MAX_CONVERSATIONS) {
      ids.sort((a, b) => (state.conversations[b].at || 0) - (state.conversations[a].at || 0));
      for (const id of ids.slice(THOUGHTS_MAX_CONVERSATIONS)) delete state.conversations[id];
    }
    writeThoughts(path, state);
  } catch {
    // fail-open
  }
}

/** The thoughts recorded for this turn since the last Telem call, joined; then cleared. "" if none. */
export function takeCursorThoughts(conversation, turn, path = thoughtsFilePath()) {
  try {
    if (typeof conversation !== "string" || !conversation || typeof turn !== "string" || !turn) return "";
    turn = cursorTurnId(turn);
    const state = readThoughts(path);
    const entry = state.conversations[conversation];
    if (!entry || entry.turn !== turn || !Array.isArray(entry.thoughts) || !entry.thoughts.length) return "";
    const text = entry.thoughts.join("\n\n").slice(0, HISTORY_TEXT_CAP);
    state.conversations[conversation] = { ...entry, thoughts: [] };
    writeThoughts(path, state);
    return text;
  } catch {
    return "";
  }
}

// Devin's reasoning. Devin's hooks carry no reasoning, but Devin Local / the Devin CLI keep each
// session in a SQLite file (`<data>/devin/cli/sessions.db`, table message_nodes: one JSON chat
// message per node, chained by parent_node_id). An assistant message holds its `thinking.thinking`
// text and its `tool_calls` (ids match the hook's tool_use_id), and it is stored before the tool
// runs (lab, 2026-11-02). From the node with this call, walk the chain back to the turn's user
// message or to the previous Telem call, and send that thinking: the Codex rule. Read-only, through
// Node's built-in SQLite (Node 22.13+); an older Node, a missing file or any error sends none.
export function devinSessionsDbPath(env = process.env, home = homedir(), platform = process.platform) {
  const candidates = [];
  if (env.XDG_DATA_HOME) candidates.push(join(env.XDG_DATA_HOME, "devin", "cli", "sessions.db"));
  candidates.push(join(home, ".local", "share", "devin", "cli", "sessions.db"));
  if (platform === "darwin") candidates.push(join(home, "Library", "Application Support", "devin", "cli", "sessions.db"));
  if (platform === "win32") {
    for (const base of [env.LOCALAPPDATA, env.APPDATA]) if (base) candidates.push(join(base, "devin", "cli", "sessions.db"));
  }
  return candidates.find((path) => existsSync(path));
}

function loadSqlite() {
  // node:sqlite prints an ExperimentalWarning on first load; the hook's stderr stays quiet.
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("node:sqlite") : undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function isTelemCall(call) {
  if (!call || typeof call !== "object") return false;
  if (typeof call.name === "string" && /^mcp__telem__telem_(search|fetch)$/.test(call.name)) return true;
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  return call.name === "mcp_call_tool" && args.server_name === "telem" && /^telem_(search|fetch)$/.test(String(args.tool_name));
}

/** The thinking that led to this call, oldest first, joined; "" when none can be read. */
export function readDevinReasoning(sessionId, toolUseId, dbPath = devinSessionsDbPath()) {
  let db;
  try {
    if (typeof sessionId !== "string" || !sessionId || typeof toolUseId !== "string" || !toolUseId || !dbPath) return "";
    const sqlite = loadSqlite();
    if (!sqlite || typeof sqlite.DatabaseSync !== "function") return "";
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id")
      .all(sessionId);
    const byNode = new Map();
    let start;
    for (const row of rows) {
      let message;
      try {
        message = JSON.parse(row.chat_message);
      } catch {
        continue;
      }
      const node = { parent: row.parent_node_id, message };
      byNode.set(row.node_id, node);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (message.role === "assistant" && calls.some((call) => call && call.id === toolUseId)) start = node;
    }
    if (!start) return "";
    const texts = [];
    const seen = new Set();
    for (let node = start, steps = 0; node && steps < 10000; node = byNode.get(node.parent), steps++) {
      const message = node.message;
      if (message.role === "user" && message.metadata && message.metadata.is_user_input) break;
      if (message.role !== "assistant") continue;
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (node !== start && calls.some(isTelemCall)) break;
      if (seen.has(message.message_id)) continue;
      seen.add(message.message_id);
      const thinking = message.thinking && typeof message.thinking.thinking === "string" ? message.thinking.thinking.trim() : "";
      if (thinking) texts.unshift(thinking);
    }
    return texts.join("\n\n").slice(0, HISTORY_TEXT_CAP);
  } catch {
    return "";
  } finally {
    try {
      if (db) db.close();
    } catch {
      // ignore
    }
  }
}

// Devin's hook payload (Devin Local in Devin Desktop, and the Devin CLI: one harness)
// carries session_id and a per-turn prompt_id, but no call id and no cwd; the project
// root is in DEVIN_PROJECT_DIR. Each call gets a fresh id, so two calls in one turn are
// two sibling nodes. An id the host does send is kept.
export function adaptDevinPayload(payload, env = process.env) {
  const out = { ...payload };
  if (typeof out.tool_use_id !== "string" || !out.tool_use_id) {
    out.tool_use_id = typeof out.tool_call_id === "string" && out.tool_call_id ? out.tool_call_id : "devin-" + randomUUID();
  }
  if ((typeof out.cwd !== "string" || !out.cwd) && typeof env.DEVIN_PROJECT_DIR === "string" && env.DEVIN_PROJECT_DIR) {
    out.cwd = env.DEVIN_PROJECT_DIR;
  }
  return out;
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

// Resolve the user's .telem config into the hosted `options` and `fetch_options` payloads
// (hosted-options the design notes/D8; hosted-fetch-options spec F5). This is the WRAPPER above
// the vendored, unforked reader in telem-config.mjs:
//   1. hostedBlocksFromConfig — ONE resolution, both builders (the search one with the
//      three composition rules, plus the hosted "off"), with an explicit stderr sink for
//      reader/composition warnings;
//   2. search block: STRIP `provider_overrides` — excluded from this channel in v1 (D3);
//      one warning naming the hosted surface, only when the key was actually present;
//   3. each block on its own: drop it, with a warning, when its compact JSON exceeds
//      OPTIONS_MAX_BYTES (D8 mirrors the server cap hook-side) — the other block stays;
//   4. return `{ options?, fetchOptions?, refusal? }`, each key present only when
//      non-empty. `refusal` is set when the config can run no search (a ConfigRefusal:
//      exclude removes every provider in include); then there is no search block, and
//      the fetch block comes from its own resolution (`fetchSource`), so a telem_fetch
//      keeps its fetch options.
//
// `cwd` comes from the PreToolUse payload; absent/non-string cwd -> the user + env
// levels only (D2). `env`/`warn` are the injectable seams the tests need; production
// callers pass (payload.cwd, env) and keep the defaults. `blocksSource` exists ONLY so
// tests can drive the wrapper's own guards (a throwing reader, a lone block) — never pass
// it in production code; `fetchSource` is the same kind of seam for the refusal path.
//
// OWN try/catch, deliberately (D8): emit's outer catch returns "" — the no-envelope
// path — and a config failure must degrade to "lineage without options", never to
// "no lineage". A resolution throw costs both blocks, with one warning. A refusal is
// returned, not thrown: emit turns it into a deny for telem_search. Never throws.
export function readConfigBlocks(
  cwd,
  env = process.env,
  warn = warnToStderr,
  blocksSource = hostedBlocksFromConfig,
  fetchSource = fetchBlockFromConfig,
) {
  const projectRoot = typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  let blocks;
  let refusal;
  try {
    blocks = blocksSource(env, projectRoot, warn);
  } catch (error) {
    if (!(error instanceof ConfigRefusal)) {
      warn(
        `[telem] ignoring the Telem config: reading it failed (${error?.message || String(error)}), ` +
          "so this call carries no search or fetch options.",
      );
      return {};
    }
    refusal = error.message;
    blocks = { search: null, fetch: fetchBlockAfterRefusal(fetchSource, env, projectRoot, warn) };
  }
  const out = refusal === undefined ? {} : { refusal };
  const options = searchOptionsOf(blocks?.search, warn);
  if (options !== undefined) out.options = options;
  const fetchOptions = cappedBlock(blocks?.fetch, "fetch", "fetchProviders list", warn);
  if (fetchOptions !== undefined) out.fetchOptions = fetchOptions;
  return out;
}

// The fetch block when the search half refused: its own resolution, with the reader's
// warnings silenced, because the first pass already printed them. Never throws.
function fetchBlockAfterRefusal(fetchSource, env, projectRoot, warn) {
  try {
    return fetchSource(env, projectRoot, () => {});
  } catch (error) {
    warn(
      `[telem] ignoring the fetch options in the Telem config: building them failed ` +
        `(${error?.message || String(error)}), so this call carries none.`,
    );
    return null;
  }
}

// The search block, ready for the envelope's `options`, or undefined. Never throws.
function searchOptionsOf(block, warn) {
  try {
    if (block === null || typeof block !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(block, "provider_overrides")) {
      delete block.provider_overrides;
      warn(
        "[telem] ignoring provider_overrides from .telem config: the hosted MCP transport " +
          "does not carry provider_overrides in v1, so it is stripped from the lineage " +
          "envelope; the rest of the resolved search options still apply.",
      );
    }
    return cappedBlock(block, "search", "fields/providers lists", warn);
  } catch {
    return undefined;
  }
}

// A non-empty block within the 4 KB cap, or undefined (dropped with a warning when over).
function cappedBlock(block, name, trim, warn) {
  try {
    if (block === null || typeof block !== "object" || Object.keys(block).length === 0) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(block), "utf8");
    if (bytes > OPTIONS_MAX_BYTES) {
      warn(
        `[telem] dropping the resolved ${name} options: the composed block is ${bytes} bytes ` +
          `as compact JSON, over the ${OPTIONS_MAX_BYTES}-byte cap for the hosted lineage ` +
          `envelope. Trim the .telem config (${trim}) to restore it.`,
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
// readConfigBlocks, attached as the envelope's `options` key when present; `fetchOptions`
// (hosted-fetch-options F4) rides as the top-level `fetch_options` key the same way. Both
// ride INSIDE the bridge — the model-facing tool schema gains nothing (D9), and
// updatedInput still adds exactly one key.
export function buildEnvelope(payload, windowId, history = [], options = undefined, fetchOptions = undefined, harness = HARNESS) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const host = HARNESSES.has(harness) ? harness : HARNESS;

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
    harness: host,
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
          harness: host,
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
  if (fetchOptions !== undefined) envelope.fetch_options = fetchOptions;
  return envelope;
}

export function encodeBridge(envelope) {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

// The PreToolUse hookSpecificOutput, or null to emit nothing. updatedInput REPLACES
// the whole tool input, so it MUST echo the original verbatim and add only
// telem_bridge.
export function buildHookOutput(payload, windowId, history = [], options = undefined, fetchOptions = undefined, harness = HARNESS) {
  const envelope = buildEnvelope(payload, windowId, history, options, fetchOptions, harness);
  if (envelope === null) return null;
  const telem_bridge = encodeBridge(envelope);
  // Cursor reads a flat updated_input (merged over the call's input) and never needs a
  // permission answer for it: none is sent, so the user's approval settings still apply.
  if (harness === "cursor") return { updated_input: { ...payload.tool_input, telem_bridge } };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...payload.tool_input, telem_bridge },
    },
  };
}

// The PreToolUse output that refuses a call: Claude Code shows the reason to the model
// and the tool call is not made.
export function buildDenyOutput(reason, harness = HARNESS) {
  // Cursor answers in its own flat shape; Devin documents a top-level decision.
  if (harness === "cursor") return { permission: "deny", user_message: reason, agent_message: reason };
  if (harness === "devin") return { decision: "block", reason };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// The full hot path: payload object -> the JSON string to print, or "" for "emit
// nothing". Resolves window_id from the state file, then the .telem config into the
// envelope's `options` and `fetch_options` (readConfigBlocks fail-opens on its own — a
// config throw can never take the "" path here, D8; a config that refuses every search
// denies a telem_search). The hook does not otherwise branch by tool: telem_fetch and
// telem_search calls carry both blocks alike (spec the contract; hosted-fetch-options F5). `env`
// is the injectable seam for hermetic tests; the CLI path keeps process.env. Never
// throws.
export function emit(payload, env = process.env, harness = HARNESS) {
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
    // hooks.json's matcher limits this hook to the Telem tools in Claude Code, but a host
    // that reads Claude-format hooks and ignores matchers (VS Code's Local agent harness
    // does) runs it before EVERY tool call, and the updatedInput below would then add
    // telem_bridge to that tool's input. So the tool is checked here too: any other tool,
    // or a payload with no tool name, gets no output and runs unchanged.
    if (!TELEM_TOOL.test(String(payload.tool_name ?? ""))) return "";
    if (harness === "copilot") payload = adaptCopilotPayload(payload);
    else if (harness === "cursor") payload = adaptCursorPayload(payload);
    else if (harness === "devin") payload = adaptDevinPayload(payload, env);
    const blocks = readConfigBlocks(payload.cwd, env);
    if (blocks.refusal !== undefined && /telem_search$/.test(String(payload.tool_name))) {
      return JSON.stringify(buildDenyOutput(blocks.refusal, harness));
    }
    const windowId = readWindowId(payload.session_id);
    // Claude Code: the turn's visible text from its transcript. Cursor: the thoughts its
    // afterAgentThought hook recorded. Devin: the thinking in its session file (both above).
    // Copilot keeps its reasoning encrypted, and VS Code's Local agent passes a transcript_path to
    // its own chat log, which is not Claude Code's JSONL: those send none.
    let history = [];
    if (harness === HARNESS) history = readCurrentReasoning(payload);
    else if (harness === "cursor" || harness === "devin") {
      const reasoning =
        harness === "cursor"
          ? takeCursorThoughts(payload.session_id, payload.prompt_id)
          : readDevinReasoning(payload.session_id, payload.tool_use_id, devinSessionsDbPath(env, env.HOME || env.USERPROFILE || homedir()));
      if (reasoning) history = [{ role: "assistant", reasoning }];
    }
    const out = buildHookOutput(payload, windowId, history, blocks.options, blocks.fetchOptions, harness);
    return out === null ? "" : JSON.stringify(out);
  } catch {
    return "";
  }
}

// `--harness <name>` from the hook command; a missing or unknown name is Claude Code.
export function harnessArg(argv) {
  const i = argv.indexOf("--harness");
  const name = i >= 0 ? argv[i + 1] : undefined;
  return HARNESSES.has(name) ? name : HARNESS;
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
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // `--harness cursor --thought`: Cursor's afterAgentThought hook. It records, and answers nothing.
      if (process.argv.includes("--thought")) recordCursorThought(payload);
      else output = emit(payload, process.env, harnessArg(process.argv));
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
