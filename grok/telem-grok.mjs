#!/usr/bin/env node
// Grok Build PreToolUse hook — lineage, reasoning and the hosted options channel.
//
// The Codex hook's job, for Grok Build. Grok runs it from `~/.grok/hooks/telem.json`
// (the installer copies this directory to `~/.grok/telem/`) before every telem_search /
// telem_fetch, and sends `updatedInput` on to the hosted MCP. One `telem_bridge` carries
// three independent parts — any one failing never costs the others, and a hook that
// emits nothing never blocks the call:
//
//  * LINEAGE — Grok gives a remote MCP server no session identity, so it comes from the
//    hook payload: sessionId -> conversation, the turn -> message (two calls in a turn
//    share it), toolUseId -> tool call. The payload has no turn id; the session log does,
//    on this call's `tool_call` record (`_meta.promptId`), and the payload names the log.
//  * REASONING — what led to THIS call, from the same log: the turn's thought text since
//    the previous MCP tool result, under `reasoning` (the Codex shape); when the model
//    gave none, the visible text it wrote before the call, under `content`.
//  * OPTIONS — the resolved `.telem` search and fetch blocks, through the Codex hook's
//    `readConfigBlocks`, unchanged: the same order, caps, and the one deny (an exclude
//    that removes every included provider refuses a telem_search).
//
// The model reaches an MCP tool through Grok's `use_tool`, so the hook's input is that
// wrapper, `{tool_name, tool_input}`, and `updatedInput` must be the whole wrapper with
// the same `tool_name`: Grok blocks a rewrite that changes the target or fails the tool's
// schema. So the output is the wrapper with one key, `telem_bridge`, set in `tool_input`.
// It carries no permission decision: the hook never approves a call Grok would ask about.
// Grok can run the hook twice for one call; setting the key (never appending) keeps that
// harmless. The hook writes nothing to stderr.
//
// Usage: node telem-grok.mjs
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readConfigBlocks } from "./telem-reasoning.mjs";

const HARNESS = "grok";
const TOOL = /^telem__telem_(search|fetch)$/;
const HISTORY_TEXT_CAP = 128_000; // mirror of both MCP servers' _HISTORY_KEYS cap
// The session log grows with every streamed chunk, but only this turn's records matter
// and they sit at the end. Read a bounded tail.
const TAIL_BYTES = 8 * 1024 * 1024;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
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

function updates(logPath) {
  const out = [];
  for (const line of readTail(logPath)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      const params = record?.params;
      if (params?.update && typeof params.update === "object") out.push({ update: params.update, meta: params._meta ?? {} });
    } catch {
      /* a record Grok is still writing */
    }
  }
  return out;
}

// The turn id of this call and its history entry, or {}. The turn is the promptId on the
// `tool_call` record whose toolCallId is this call's. Reasoning is that turn's thought text
// from after the last completed MCP tool result up to this call, so two telem calls in one
// turn each carry their own; a shell command between them cuts nothing. Streamed chunks of
// one kind join as they came, and a record of another kind starts a new segment. Never
// throws.
export function turnAndHistory(logPath, toolUseId) {
  try {
    if (!logPath || typeof toolUseId !== "string" || !toolUseId) return {};
    const records = updates(logPath);
    const at = records.findIndex(
      (r) => r.update.sessionUpdate === "tool_call" && r.update.toolCallId === toolUseId,
    );
    if (at === -1) return {};
    const turnId = records[at].meta.promptId;
    if (typeof turnId !== "string" || !turnId) return {};
    let thoughts = [];
    let texts = [];
    let last = null;
    for (const { update, meta } of records.slice(0, at)) {
      if (meta.promptId !== turnId) continue;
      const kind = update.sessionUpdate;
      if (kind === "tool_call_update" && update.status === "completed" && update.rawOutput?.type === "MCP") {
        thoughts = [];
        texts = [];
        last = null;
        continue;
      }
      const text = typeof update.content?.text === "string" ? update.content.text : "";
      if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
        const list = kind === "agent_thought_chunk" ? thoughts : texts;
        if (last === kind && list.length) list[list.length - 1] += text;
        else list.push(text);
      }
      last = kind;
    }
    const join = (list) => list.map((s) => s.trim()).filter(Boolean).join("\n").slice(0, HISTORY_TEXT_CAP);
    const reasoning = join(thoughts);
    const content = join(texts);
    if (reasoning) return { turnId, history: [{ role: "assistant", reasoning }] };
    if (content) return { turnId, history: [{ role: "assistant", content }] };
    return { turnId, history: [] };
  } catch {
    return {};
  }
}

const pick = (payload, camel, snake) => payload?.[camel] ?? payload?.[snake];

// The hook's stdout for one payload, or "" to leave the call untouched. Never throws.
export function emit(payload, env = process.env) {
  try {
    const tool = pick(payload, "toolName", "tool_name");
    if (typeof tool !== "string" || !TOOL.test(tool)) return "";
    // A cut input cannot be echoed back whole; leave the call as it is.
    if (pick(payload, "toolInputTruncated", "tool_input_truncated") === true) return "";
    const wrapper = pick(payload, "toolInput", "tool_input");
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return "";
    const inner = wrapper.tool_input;
    if (wrapper.tool_name !== tool || !inner || typeof inner !== "object" || Array.isArray(inner)) return "";

    const { options, fetchOptions, refusal } = readConfigBlocks(payload.cwd, env, () => {});
    if (refusal !== undefined && tool.endsWith("telem_search")) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal },
      });
    }

    const lineage = {};
    const sessionId = pick(payload, "sessionId", "session_id");
    const toolUseId = pick(payload, "toolUseId", "tool_use_id");
    const { turnId, history } = turnAndHistory(pick(payload, "transcriptPath", "transcript_path"), toolUseId);
    if (typeof sessionId === "string" && sessionId && turnId) {
      Object.assign(lineage, { harness: HARNESS, conversation_id: sessionId, window_id: "none", message_id: turnId });
      if (typeof toolUseId === "string" && toolUseId) lineage.tool_call_id = toolUseId;
      lineage.ancestors = [];
      if (history.length) lineage.history = history;
    }
    if (!Object.keys(lineage).length && !options && !fetchOptions) return "";

    const envelope = { v: 1, lineage };
    if (options) envelope.options = options;
    if (fetchOptions) envelope.fetch_options = fetchOptions;
    const telem_bridge = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...wrapper, tool_input: { ...inner, telem_bridge } },
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
  const output = emit(payload);
  if (output) process.stdout.write(output);
}
