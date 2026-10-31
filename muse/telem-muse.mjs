#!/usr/bin/env node
// Muse CLI PreToolUse hook — lineage, reasoning and the hosted options channel.
//
// The Codex hook's job, for Muse. Muse runs it as a user hook from
// `~/.config/muse/settings.json` (the installer copies this directory there), before
// every telem_search / telem_fetch, and sends `updatedInput` on to the hosted MCP. One
// `telem_bridge` carries three independent parts — any one failing never costs the
// others, and a hook that emits nothing never blocks the call:
//
//  * LINEAGE — Muse gives a remote MCP server nothing to thread a session on (its
//    `_meta` carries trace ids only), so, like the Claude Code hook, the identity comes
//    from the hook payload: session_id -> conversation, turn_id -> message (two calls in
//    a turn share it), tool_use_id -> tool call.
//  * REASONING — what led to THIS call, read from Muse's session log: the turn's
//    reasoning summaries since the previous telem call returned, under `reasoning`
//    (the Codex shape); when the model gave no summary, the visible text it wrote
//    before the call, under `content` (the Claude Code shape).
//  * OPTIONS — the resolved `.telem` search and fetch blocks, through the Codex hook's
//    `readConfigBlocks`, unchanged: the same order, caps, and the one deny (an exclude
//    that removes every included provider refuses a telem_search).
//
// Muse clears the hook's environment down to PATH, HOME and a few of its own, so the
// `TELEM_*` variables never arrive here: the project and user config files do. And
// Muse saves a hook's stdout and stderr in its session log, so this hook writes
// nothing to stderr: a config warning can quote the file it could not read.
//
// Usage: node telem-muse.mjs [<muse sessions dir>]. The installer passes the
// directory, because Muse's XDG_DATA_HOME, which can move it, never reaches a hook.
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfigBlocks } from "./telem-reasoning.mjs";

const HARNESS = "muse";
const HISTORY_TEXT_CAP = 128_000; // mirror of both MCP servers' _HISTORY_KEYS cap
// The session log is verbose (one model request record can be 100 kB), but only this
// turn's records matter and they sit at the end. Read a bounded tail.
const TAIL_BYTES = 8 * 1024 * 1024;
// Ids become a path below; anything else is not a Muse id.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Muse keeps each session at <sessions dir>/YYYY/MM/DD/<id>/ — the local date it
// started — and passes no transcript_path to a hook in `muse exec`. Never throws.
export function findSessionLog(sessionId, root) {
  try {
    if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId) || !root) return null;
    const dirs = (path) => readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    // Newest first: an active session is almost always under one of the latest days.
    for (const year of dirs(root).sort().reverse()) {
      for (const month of dirs(join(root, year)).sort().reverse()) {
        for (const day of dirs(join(root, year, month)).sort().reverse()) {
          const dir = join(root, year, month, day, sessionId);
          try {
            closeSync(openSync(join(dir, "session.jsonl"), "r"));
            return join(dir, "session.jsonl");
          } catch {
            /* not this day */
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.toString("utf8", 0, got).split("\n");
    if (start > 0) lines.shift(); // a partial first record
    return lines;
  } catch {
    return [];
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

// Muse writes some records wrapped in a frame whose children carry the record as a JSON
// string, at any depth. Yields the plain records.
function* records(value) {
  if (Array.isArray(value?.children)) {
    for (const child of value.children) {
      try {
        yield* records(JSON.parse(child?.record_json));
      } catch {
        /* not a record */
      }
    }
  } else if (value && typeof value === "object") {
    yield value;
  }
}

// The history entry for THIS call, or [] — from this turn's records only (every run
// record names its turn), starting after the last MCP tool result the turn received
// (Codex's boundary: its mcp_tool_call_end), so two telem calls in one turn each carry
// their own reasoning, and a shell command between them cuts nothing. Never throws.
export function reasoningForCall(logPath, turnId) {
  try {
    if (!logPath || typeof turnId !== "string" || !turnId) return [];
    let summaries = [];
    let preamble = [];
    const mcpCalls = new Set();
    for (const line of readTail(logPath)) {
      if (!line.includes(turnId)) continue; // cheap filter before JSON.parse
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a record Muse is still writing
      }
      for (const record of records(parsed)) {
        const payload = record.payload;
        if (payload?.kind !== "run" || payload.run_id !== turnId) continue;
        const event = payload.event;
        const text = typeof event?.text === "string" ? event.text.trim() : "";
        if (event?.kind === "assistant_tool_calls_committed" && Array.isArray(event.tool_calls)) {
          for (const call of event.tool_calls) {
            if (typeof call?.name === "string" && call.name.startsWith("mcp__")) mcpCalls.add(call.call_id);
          }
        } else if (
          event?.kind === "tool_result_batch_committed" &&
          Array.isArray(event.results) &&
          event.results.some((result) => mcpCalls.has(result?.tool_call_id))
        ) {
          summaries = [];
          preamble = [];
        } else if (event?.kind === "reasoning_summary_committed" && text) {
          // Summaries come as `**Header**` markdown; strip it for consoles that show plain text.
          summaries.push(text.replace(/\*\*/g, ""));
        } else if (event?.kind === "assistant_message_committed" && text) {
          preamble.push(text);
        }
      }
    }
    if (summaries.length) return [{ role: "assistant", reasoning: summaries.join("\n").slice(0, HISTORY_TEXT_CAP) }];
    if (preamble.length) return [{ role: "assistant", content: preamble.join("\n").slice(0, HISTORY_TEXT_CAP) }];
    return [];
  } catch {
    return [];
  }
}

// The hook's stdout for one payload, or "" to leave the call untouched. Never throws.
export function emit(payload, sessionsDir, env = process.env) {
  try {
    const tool = payload?.tool_name;
    if (typeof tool !== "string" || !/^mcp__telem__telem_(search|fetch)$/.test(tool)) return "";
    const toolInput = payload.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";

    const { options, fetchOptions, refusal } = readConfigBlocks(payload.cwd, env, () => {});
    if (refusal !== undefined && tool.endsWith("telem_search")) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal },
      });
    }

    const lineage = {};
    const sessionId = payload.session_id;
    const turnId = payload.turn_id;
    if (typeof sessionId === "string" && sessionId && typeof turnId === "string" && turnId) {
      Object.assign(lineage, { harness: HARNESS, conversation_id: sessionId, window_id: "none", message_id: turnId });
      if (typeof payload.tool_use_id === "string" && payload.tool_use_id) lineage.tool_call_id = payload.tool_use_id;
      lineage.ancestors = [];
      const logPath =
        typeof payload.transcript_path === "string" && payload.transcript_path
          ? payload.transcript_path
          : findSessionLog(sessionId, sessionsDir || (env.HOME && join(env.HOME, ".local", "share", "muse", "sessions")));
      const history = reasoningForCall(logPath, turnId);
      if (history.length) lineage.history = history;
    }
    if (!Object.keys(lineage).length && !options && !fetchOptions) return "";

    const envelope = { v: 1, lineage };
    if (options) envelope.options = options;
    if (fetchOptions) envelope.fetch_options = fetchOptions;
    const telem_bridge = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    // updatedInput replaces the arguments: echo every key, add only telem_bridge.
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "telem lineage",
        updatedInput: { ...toolInput, telem_bridge },
      },
    });
  } catch {
    return "";
  }
}

function isMain() {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }
  const output = emit(payload, process.argv[2]);
  if (output) process.stdout.write(output);
}
