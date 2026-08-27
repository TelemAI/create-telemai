// Credentials: verify a key against the deployment, then write it to the ONE
// place every surface falls back to — `~/.telem/credentials.json`, 0600.
//
// Verification has to use the SAME auth a `tlm_` product key actually carries:
// its authority is API-key introspection, which gates the Search operation,
// NOT the `/v1/me/*` routes (those are OIDC/human-session only — a valid `tlm_`
// key gets "Invalid bearer token" 401 there, so they would reject every real
// key). `/v1/preprocessors` is unauthenticated, so it verifies nothing.
//
// So we probe `POST /v1/search` — but with a body that is rejected BEFORE
// any provider is called, spending zero search budget. Auth is a route
// dependency resolved ahead of body validation, so:
//   bad/absent key  -> 401 (auth fails first)          => unauthorized
//   good key        -> 422 (the retired `preprocessor_names` field is rejected
//                           after auth passes, before any search runs)          => ok
// Verified live against router.telem.ai 2026-08-12 (good=422, bad=401), and again
// 2026-08-21 on `/v1/search` after the alias landed: `/v1/interactions` and
// `/v1/search` answer this probe identically (good=422, bad=401, no key=401).
// The path moved to `/v1/search` with that check, not on the assumption.
//
// This auth-before-body ordering is a the Telem backend contract the verify RELIES on: the key's
// authority is resolved as a route dependency ahead of request-body validation, so
// a 401/403 can only come from auth and a 400 OR a 422 can only come from body
// validation that auth already passed. Both 400 and 422 therefore mean "the key is
// good"; only 401/403 mean "the key is bad". If the Telem backend ever validated the body before
// auth this probe would misread a bad key as good, so the contract is load-bearing.
export const DEFAULT_BASE_URL = "https://router.telem.ai"
export const CONSOLE_URL = "https://app.telem.ai"
export const VERIFY_PATH = "/v1/search"
// A body that authenticates but is refused before search: the retired V1 field
// makes the request a guaranteed 422 on any valid key, so no provider is billed.
const VERIFY_BODY = JSON.stringify({ user_input: { query: "x" }, preprocessor_names: ["_verify"] })

export type Credentials = { apiKey?: string; baseUrl?: string }

export type VerifyResult =
  | { status: "ok" }
  | { status: "unauthorized"; detail: string }
  // The server is transiently unhappy (busy, overloaded, a bad gateway) — this says
  // nothing about the KEY, so it is treated like a network failure: offer to write
  // the key unverified, never a hard block.
  | { status: "transient"; detail: string }
  | { status: "unexpected"; detail: string }
  | { status: "unreachable"; detail: string }

// Status codes that mean "try again later", not "your key is bad": rate limiting
// and the 5xx family a proxy or a restarting deployment emits. A VALID key must not
// be blocked because the router happened to be busy for a second.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])

export type VerifyInput = {
  baseUrl: string
  apiKey: string
  fetchImpl: typeof fetch
  timeoutMs?: number
}

export async function verifyKey(input: VerifyInput): Promise<VerifyResult> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}${VERIFY_PATH}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
  try {
    const response = await input.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: VERIFY_BODY,
      signal: controller.signal,
    })
    // Auth passed and the request was refused after it (422, or a 400 if the
    // contract shifts the retired-field rejection): the KEY is good, which is
    // all we are testing. Anything 2xx is fine too (a future build that stops
    // 422ing this body still means the key worked).
    if (response.status === 422 || response.status === 400 || (response.status >= 200 && response.status < 300)) {
      return { status: "ok" }
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized", detail: `${input.baseUrl} rejected the key (HTTP ${response.status})` }
    }
    if (TRANSIENT_STATUSES.has(response.status)) {
      return {
        status: "transient",
        detail: `${input.baseUrl} is temporarily unavailable (HTTP ${response.status}); the key was not checked`,
      }
    }
    return { status: "unexpected", detail: `${url} answered HTTP ${response.status}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: "unreachable", detail: `could not reach ${url}: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The file's contents. Unknown keys in an existing file are PRESERVED — this file
 * is machine-written today, but "we only wrote apiKey and baseUrl last time" is
 * not a reason to delete whatever a later version put there.
 */
export function credentialsContents(existing: unknown, next: Credentials): string {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const out: Record<string, unknown> = {}
  if (next.apiKey !== undefined) out.apiKey = next.apiKey
  else if (typeof base.apiKey === "string") out.apiKey = base.apiKey
  if (next.baseUrl !== undefined) out.baseUrl = next.baseUrl
  else if (typeof base.baseUrl === "string") out.baseUrl = base.baseUrl
  for (const [key, value] of Object.entries(base)) {
    if (key === "apiKey" || key === "baseUrl") continue
    out[key] = value
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * The existing credentials file, classified for a WRITE. `null` from `readText`
 * means genuinely absent (safe to treat as empty); a present file that does not
 * parse as a JSON object is `unparseable` — and the caller must ABORT naming the
 * path, exactly like the three sibling editors (configfile/opencode/codex), rather
 * than rebuild the file from only apiKey+baseUrl and silently drop whatever it held.
 */
export type CredentialsFile =
  | { status: "absent" }
  | { status: "parsed"; value: Record<string, unknown> }
  | { status: "unparseable" }

export function readCredentialsFile(source: string | null): CredentialsFile {
  if (source === null) return { status: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.replace(/^﻿/, ""))
  } catch {
    return { status: "unparseable" }
  }
  // Present but not a JSON object (a bare string/number/array): the same class as a
  // parse error — refuse rather than clobber it, matching the sibling editors.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unparseable" }
  return { status: "parsed", value: parsed as Record<string, unknown> }
}

/** Read an existing credentials file. Never throws: an unreadable one is simply absent. */
export function parseCredentials(source: string | null): Credentials {
  if (source === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(source.replace(/^﻿/, ""))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const out: Credentials = {}
  if (typeof record.apiKey === "string" && record.apiKey.trim()) out.apiKey = record.apiKey.trim()
  if (typeof record.baseUrl === "string" && record.baseUrl.trim()) out.baseUrl = record.baseUrl.trim()
  return out
}

/**
 * `tlm_a…z9` — enough to recognize a key you already have, never enough to use one.
 * Short keys collapse entirely rather than leaking most of themselves.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 10) return "*".repeat(Math.max(trimmed.length, 1))
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-2)}`
}
