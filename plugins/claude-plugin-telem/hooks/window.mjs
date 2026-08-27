#!/usr/bin/env node
// Telem window-generation state hook — the cheap companion to hooks/lineage.mjs.
//
// Three hook events, selected by argv[2], all keyed by session_id in a single JSON
// file — so the lineage hook can read window_id WITHOUT scanning the transcript on
// the hot path:
//
//   session-start: seed the session at generation 0 (window_id "none"). Idempotent —
//                   a resumed session keeps its generation, never resets to 0.
//   pre-compact: bump the context-window generation (a compaction begins).
//   post-compact: record the compaction. If pre-compact fired it just closes the
//                   in-flight bump; if it did NOT (only post-compact reached us) it
//                   bumps here instead — so exactly one increment happens per
//                   compaction whichever of the two events the host delivers.
//
// window_id is the generation as a string, and "none" while generation is 0 (the
// lineage hook maps a 0/absent generation to "none"). FAIL-OPEN: any error emits
// nothing and never blocks a compaction or session start. Zero dependencies.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_FILENAME = "window.json";
const STATE_VERSION = 1;

// MUST resolve to the exact same file hooks/lineage.mjs reads.
export function stateFilePath() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const dir = root && root.trim() ? root : process.env.TMPDIR || "/tmp";
  return join(dir, STATE_FILENAME);
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state && typeof state === "object" && state.sessions && typeof state.sessions === "object") {
      return state;
    }
  } catch {
    // A missing or corrupt file starts a fresh map — never fatal.
  }
  return { version: STATE_VERSION, sessions: {} };
}

function writeState(path, state) {
  // Atomic: write a pid-tagged temp then rename, so a reader never sees a half file.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}

// Apply one window event to the state file. Never throws (fail-open). Exported so the
// suite drives it directly rather than spawning three processes.
export function applyEvent(phase, payload, path = stateFilePath()) {
  try {
    const sessionId = payload && typeof payload === "object" ? payload.session_id : null;
    if (typeof sessionId !== "string" || sessionId === "") return;

    const state = readState(path);
    const existing = state.sessions[sessionId];

    if (phase === "session-start") {
      if (existing) return; // resumed session: keep its generation, do not reseed
      state.sessions[sessionId] = { generation: 0, open: false };
    } else if (phase === "pre-compact") {
      const entry = existing || { generation: 0, open: false };
      if (!entry.open) {
        entry.generation += 1;
        entry.open = true;
      }
      state.sessions[sessionId] = entry;
    } else if (phase === "post-compact") {
      const entry = existing || { generation: 0, open: false };
      if (entry.open) {
        entry.open = false; // pre-compact already bumped; just close it
      } else {
        entry.generation += 1; // pre-compact never reached us; bump here
      }
      state.sessions[sessionId] = entry;
    } else {
      return; // unknown phase: nothing to do
    }

    writeState(path, state);
  } catch {
    // Never let a state-file failure block a compaction or session start.
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
  const phase = process.argv[2];
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    try {
      applyEvent(phase, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      // fail-open
    }
    process.exit(0);
  });
  process.stdin.on("error", () => process.exit(0));
}
