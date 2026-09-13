#!/usr/bin/env node
// Codex PreToolUse hook — telem reasoning capture + the hosted options channel.
//
// Two independent payloads ride one `telem_bridge` (built when reasoning OR
// options exist — either half degrading must never suppress the other; spec
// the design notes D8):
//
//  * REASONING — the reasoning SUMMARY (plaintext) that led to THIS telem_search /
//    telem_fetch call, read from the Codex rollout and injected as a lineage
//    history entry keyed under `reasoning` — the one sub-field the Telem backend's session
//    exporter renders as "agent reasoning". Identity still comes from Codex's
//    own `_meta` (Channel A); the bridge supplies reasoning history, which the
//    server grafts on. Design: the design notes.
//    Requires `model_reasoning_summary` != "none" in the Codex config, or
//    summaries are empty.
//  * OPTIONS — the user's resolved `.telem` search options (project > user >
//    env, via the vendored reader in ./telem-config.mjs), carried to the hosted
//    MCP server as the envelope's `options`. The hosted transport has no cwd
//    and no client filesystem, so this bridge is its only path to user config.
//
// Degrade-never-fail: any problem => emit nothing (or emit without the failed
// half); the tool call proceeds unchanged.
import { readFileSync } from "node:fs";

import { searchBlockFromConfig } from "./telem-config.mjs";

const HISTORY_TEXT_CAP = 128_000; // mirror of both MCP servers' _HISTORY_KEYS cap
const OPTIONS_BLOCK_MAX_BYTES = 4096; // mirror of the hosted server's options cap (spec D4/D8)

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The reasoning summaries produced since the LAST search completed (mcp_tool_call_end) or
// the turn began (turn_context / task_started) — the rationale that led to THIS call.
// Per-search deltas: distinct content per step, so the exporter's exact-content dedup
// never blanks or duplicates a later search in the same turn. The exec code-mode wrapper's
// own custom_tool_call is deliberately NOT a boundary, or it would cut off the real
// pre-call reasoning that sits before it.
// FAIL-SAFE: if no TURN boundary is seen at all (delimiter absent or renamed in some Codex
// build), capture NOTHING rather than the whole append-only file (which would attach prior
// turns' — and prior goals' — reasoning to this step).
function reasoningLeadingToThisCall(rolloutPath) {
  let text;
  try {
    text = readFileSync(rolloutPath, "utf8");
  } catch {
    return "";
  }
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* skip a partial trailing line the rollout is mid-write on */
    }
  }
  let start = 0;
  let sawTurnBoundary = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const pt = r && r.payload && typeof r.payload === "object" ? r.payload.type : undefined;
    if (r?.type === "turn_context" || pt === "task_started") {
      start = i + 1;
      sawTurnBoundary = true;
    } else if (pt === "mcp_tool_call_end") {
      start = i + 1; // a prior search: take the delta from here
    }
  }
  if (!sawTurnBoundary) return ""; // no delimiter => refuse to guess the turn
  const out = [];
  for (let i = start; i < recs.length; i++) {
    const r = recs[i];
    if (r?.type !== "response_item") continue;
    const p = r.payload;
    if (!p || p.type !== "reasoning" || !Array.isArray(p.summary)) continue;
    for (const s of p.summary) {
      // Codex writes summaries as `**Header**`; strip the markdown so consoles that don't
      // render markdown show clean prose, not literal asterisks.
      const t = s && typeof s.text === "string" ? s.text.replace(/\*\*/g, "").trim() : "";
      if (t) out.push(t);
    }
  }
  return out.join("\n").slice(0, HISTORY_TEXT_CAP);
}

// Hook warning sink: stderr only (stdout is the hook protocol). Debug-only on
// this host — an accepted, recorded limitation of the surface in v1 (spec D8).
function warn(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* a closed stderr must never fail the hook */
  }
}

// The hosted options channel (spec D2/D3/D8): resolve the user's config over
// project `<cwd>/.telem/telem.json` > user `~/.telem/telem.json` > `TELEM_*`
// env — levels 5/6 only when the payload carries no cwd — compose it into the
// V2 `search` block via the byte-identical vendored reader, then, ABOVE the
// vendored copy: strip `provider_overrides` (excluded from this channel in v1,
// D3) with one warning, and mirror the server's 4 KB cap so the honest path
// warns instead of silently losing config. Own try/catch: a config failure
// costs the options, NEVER the reasoning half of the bridge (D8's layering —
// this must not sit bare inside an outer catch that kills lineage).
function readConfigOptions(cwd, env = process.env) {
  try {
    const projectRoot = typeof cwd === "string" && cwd ? cwd : undefined;
    const block = searchBlockFromConfig(env, projectRoot, warn);
    if (!block) return undefined;
    if (Object.prototype.hasOwnProperty.call(block, "provider_overrides")) {
      delete block.provider_overrides;
      warn(
        "[telem] ignoring provider_overrides: it is not carried over the hosted options " +
          "channel in v1; the other resolved " +
          "options still apply.",
      );
    }
    if (!Object.keys(block).length) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(block), "utf8");
    if (bytes > OPTIONS_BLOCK_MAX_BYTES) {
      warn(
        `[telem] dropping the resolved search options: ${bytes} bytes of compact JSON ` +
          `exceeds the ${OPTIONS_BLOCK_MAX_BYTES}-byte bridge cap, so this call runs on ` +
          "deployment defaults.",
      );
      return undefined;
    }
    return block;
  } catch {
    return undefined; // fail-open: options are a bonus, never a gate
  }
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // no output => no change
  }
  const tool = payload?.tool_name;
  // Only the two tools that DECLARE telem_bridge (server.py). providers/session_history
  // don't, so FastMCP would drop the arg anyway.
  if (typeof tool !== "string" || !/^mcp__telem__telem_(search|fetch)$/.test(tool)) return;
  const toolInput = payload?.tool_input;
  if (!toolInput || typeof toolInput !== "object") return;

  // The reasoning half: degrades to "" (missing transcript_path, unreadable rollout,
  // no turn boundary, no new reasoning) WITHOUT suppressing an options-bearing bridge —
  // before the hosted options channel these were hard early exits (spec D8).
  const rollout = payload?.transcript_path;
  const reasoning =
    typeof rollout === "string" && rollout ? reasoningLeadingToThisCall(rollout) : "";

  // The options half: independently fail-open (its own try/catch inside).
  const options = readConfigOptions(payload?.cwd);

  if (!reasoning && !options) return; // nothing to carry => leave the call untouched

  // `lineage` stays present even without history: the envelope parsers on both
  // servers require a dict there ({v: 1, lineage: {...}}), and an empty history
  // list is never emitted — the key is simply absent.
  const envelope = { v: 1, lineage: {} };
  if (reasoning) envelope.lineage.history = [{ role: "assistant", reasoning }];
  if (options) envelope.options = options;
  const bridge = b64url(envelope);
  // updatedInput is a FULL replacement of the arguments: spread ALL received keys verbatim,
  // add only telem_bridge. Never reconstruct queries/session_id/goal by hand.
  const updatedInput = { ...toolInput, telem_bridge: bridge };
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "telem reasoning capture",
        updatedInput,
      },
    }),
  );
}
main();
