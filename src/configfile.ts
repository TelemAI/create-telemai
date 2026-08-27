// Writing `telem.json` — the unified options file.
//
// The file belongs to the user, not to the wizard, so:
//
//  * UNMANAGED KEYS SURVIVE. Anything that is not one of the six option keys is
//    copied through untouched, in its original order.
//  * INVALID EXISTING JSON ABORTS. A file we cannot parse is a file we cannot
//    merge into, and overwriting it would destroy config we never read. The abort
//    names the path — that is the openclaw installer's rule, applied here.
//  * A key answered as "leave unset" is REMOVED, not written as `""`/`[]`/`{}`.
//    Empty means absent on every reader, so writing an empty value would
//    be a no-op that reads like a setting.

import { TELEM_OPTIONS } from "../config-core/options.ts"

export const SCHEMA_URL = "https://telem.ai/schemas/config-v1.json"
export const SCHEMA_KEY = "$schema"

export type ConfigMerge =
  | { status: "unchanged"; reason: string }
  | { status: "write"; contents: string; created: boolean }
  | { status: "abort"; reason: string }

const OPTION_KEYS: readonly string[] = TELEM_OPTIONS.map((option) => option.key)

export function mergeTelemConfig(
  source: string | null,
  answers: Record<string, unknown>,
  path: string,
): ConfigMerge {
  let existing: Record<string, unknown> = {}
  const created = source === null || source.trim() === ""
  if (!created) {
    let parsed: unknown
    try {
      parsed = JSON.parse((source as string).replace(/^﻿/, ""))
    } catch (error) {
      return {
        status: "abort",
        reason: `${path} is not valid JSON (${(error as Error)?.message ?? "parse error"}); fix or move it and re-run — it will not be overwritten`,
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "abort",
        reason: `${path} does not contain a JSON object; fix or move it and re-run — it will not be overwritten`,
      }
    }
    existing = parsed as Record<string, unknown>
  }

  const out: Record<string, unknown> = {}
  out[SCHEMA_KEY] = typeof existing[SCHEMA_KEY] === "string" ? existing[SCHEMA_KEY] : SCHEMA_URL
  for (const key of OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(answers, key)) {
      const value = answers[key]
      if (value !== undefined) out[key] = value
      continue
    }
    if (Object.prototype.hasOwnProperty.call(existing, key)) out[key] = existing[key]
  }
  for (const [key, value] of Object.entries(existing)) {
    if (key === SCHEMA_KEY || OPTION_KEYS.includes(key)) continue
    out[key] = value
  }

  const contents = `${JSON.stringify(out, null, 2)}\n`
  if (!created && contents === source) {
    return { status: "unchanged", reason: `${path} is already what the answers describe` }
  }
  return { status: "write", contents, created }
}
