// Zero-dependency JS port of the trajectory-v5 identity hashing.
//
// Byte-for-byte equal to the Python SDK's trajectory helpers — pinned by the
// golden-vector test the sibling plugin own suite, whose expected
// values are generated from the Python. Any drift fails that test loudly.
//
// It also computes a subagent's pure-delegating orchestrator ancestor, so a
// delegated search hangs off the agent that spawned it.
//
// Node built-ins only (node:crypto). No network. Never throws for well-formed
// string input.

import { createHash } from "node:crypto";

// The trajectory namespace UUID (mirror of _trajectory_v5.NS_TRAJECTORY).
export const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810";
const NONE = "none";

// hex sha256 of the utf8 bytes of value — mirror of _sha256.
export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Length-prefix a string by its UTF-8 BYTE length (not code-point length), so
// concatenation of prefixed parts stays injective — mirror of _lp. Python uses
// len(value.encode); Buffer.byteLength(value) defaults to utf8 and matches.
export function _lp(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

// The 16 raw bytes of a canonical UUID string (dashes stripped, hex-decoded).
function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

// Name-based UUIDv5 = SHA-1(namespaceBytes + nameBytes), first 16 bytes, with the
// version nibble forced to 5 and the RFC-4122 variant bits set. Mirror of Python's
// uuid5(namespace, name).
export function uuid5(namespace, name) {
  const ns = uuidBytes(namespace);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1")
    .update(ns)
    .update(nameBytes)
    .digest(); // 20 bytes
  const b = Buffer.from(hash.subarray(0, 16)); // first 16 bytes
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return (
    hex.substring(0, 8) +
    "-" +
    hex.substring(8, 12) +
    "-" +
    hex.substring(12, 16) +
    "-" +
    hex.substring(16, 20) +
    "-" +
    hex.substring(20, 32)
  );
}

// Stable, non-reversible conversation identity — mirror of fingerprint.
export function fingerprint(harness, conversationId) {
  return sha256(_lp(harness) + _lp(conversationId));
}

// Deterministic identity of one context-window generation — mirror of session_key.
export function session_key(harness, conversationId, windowId) {
  const name =
    _lp(harness) + _lp(sha256(conversationId)) + _lp(windowId) + _lp(NONE);
  return uuid5(NS_TRAJECTORY, name);
}

// Identity of an agent snapshot at a delegation boundary — mirror of
// snapshot_node_key.
export function snapshot_node_key(harness, conversationId, messageId) {
  const name =
    _lp(harness) + _lp(sha256(conversationId)) + _lp(messageId) + _lp("snap");
  return uuid5(NS_TRAJECTORY, name);
}

// Freeze one agent at a delegation boundary as an ancestor entry — mirror of
// build_snapshot. parent_node_key is the DIRECT parent's node_key (last ancestor)
// or null when there is no parent.
export function build_snapshot({
  harness,
  conversationId,
  windowId,
  messageId,
  context,
  ancestors,
  spawnedAt = null,
}) {
  const anc = ancestors || [];
  const parent = anc.length ? anc[anc.length - 1] : null;
  return {
    session_key: session_key(harness, conversationId, windowId),
    fingerprint: fingerprint(harness, conversationId),
    node_key: snapshot_node_key(harness, conversationId, messageId),
    parent_node_key: parent ? (parent.node_key ?? null) : null,
    context: context,
    spawned_at: spawnedAt,
  };
}
