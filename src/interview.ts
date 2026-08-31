// The options interview, GENERATED from config-core's option table.
//
// `TELEM_OPTIONS` is the single place a config key is defined — the JSON
// Schema, both readers, the shared corpus and now this interview all derive from
// it. So there is no hand-written question list here: one question per entry, in
// table order, carrying that entry's own description as its help text. A key added
// to the table appears in the wizard with no edit to this file, and
// `interview.test.ts` pins that by comparing the generated keys to the table.
//
// Answers are coerced by the SAME coercers the readers use, so a value the wizard
// accepts is a value every surface will resolve — the wizard cannot write a file
// that its own readers treat as absent.

import type { CoercionClass, JsonType, TelemOptionSpec } from "../config-core/options.ts"
import { COERCERS, TELEM_OPTIONS } from "../config-core/options.ts"

export type Question = {
  key: string
  jsonType: JsonType
  coercion: CoercionClass
  description: string
  /** Fixed choices, when the key has a closed vocabulary. Empty otherwise. */
  suggestions: readonly string[]
  /** The current value from existing config, or `undefined` when unset. */
  initial: unknown
  /** How a text answer is typed in. */
  inputHint: string
}

/**
 * Closed vocabularies the table cannot express as data yet. Kept minimal and
 * pinned: `interview.test.ts` asserts every key here exists in TELEM_OPTIONS and
 * every value here appears verbatim in that option's own description, so a tier
 * rename in the option table fails this file loudly instead of shipping a select
 * whose choices the server rejects.
 */
export const SUGGESTIONS: Record<string, readonly string[]> = {
  tier: ["minimalist", "default", "extended", "max"],
}

/**
 * The option keys the WIZARD asks about. The table still defines six — every one of
 * them is read from `~/.telem/telem.json` by every surface — but three of them
 * (`fields`, `providersExclude`, `providerOverrides`) are config-file-only: they are
 * refinements of an answer the wizard already collects (`tier` and
 * `providersInclude`), and asking a first-run user to type a JSON blob of raw
 * per-provider request parameters cost six screens of "leave unset" for nothing.
 * `interview.test.ts` pins these against the table, so a rename fails loudly.
 */
export const WIZARD_KEYS: readonly string[] = ["tier", "providersInclude", "fullContent"]

/**
 * What each tier actually costs the user, in the user's terms. The keys are exactly
 * `SUGGESTIONS.tier` (pinned by a test), and the text is the the Telem backend search contract's
 * own field ladder — the wizard must not invent a tier the server does not serve.
 */
export const TIER_LABELS: Record<string, string> = {
  minimalist: "minimalist — URLs, titles, rank only (cheapest)",
  default: "default — + a short summary per result (recommended)",
  extended: "extended — + excerpts, publish dates, usage stats · engages some paid provider options",
  max: "max — everything providers return · ⚠ highest cost, varies by provider",
}

/** The tier a fresh run lands on when the user opens the defaults screen. */
export const DEFAULT_TIER = "default"

/**
 * The providers a deployment can run, for the "choose specific providers" screen.
 * `providersInclude` REPLACES the deployment's default set, so this list is the
 * whole vocabulary — a name not here cannot be picked in the wizard (it can still be
 * written into telem.json by hand, which the readers accept unchanged).
 */
export const SEARCH_PROVIDERS: readonly string[] = [
  "exa",
  "tavily",
  "brave",
  "serpapi",
  "parallel",
  "linkup",
  "ceramic",
  "seltz",
  "you",
]

/**
 * Pre-checked on the provider screen: the deployment's own fast default roster
 * (seven sub-1.4s providers), so opening "choose specific" starts from what runs
 * by default and the user trims rather than rebuilds. serpapi and linkup are the
 * two left out for latency; they are still one checkbox away.
 */
export const DEFAULT_PROVIDER_PICKS: readonly string[] = [
  "exa",
  "tavily",
  "brave",
  "parallel",
  "ceramic",
  "seltz",
  "you",
]

const INPUT_HINTS: Record<CoercionClass, string> = {
  name: "one name, or empty to leave unset",
  nameList: "comma-separated, or empty to leave unset",
  flag: "yes or no",
  overridesMap: 'JSON object, e.g. {"exa": {"numResults": 2}} — empty to leave unset',
}

export function buildInterview(existing: Record<string, unknown> = {}): Question[] {
  return TELEM_OPTIONS.map((spec: TelemOptionSpec) => ({
    key: spec.key,
    jsonType: spec.jsonType,
    coercion: spec.coercion,
    description: spec.description,
    suggestions: SUGGESTIONS[spec.key] ?? [],
    initial: COERCERS[spec.coercion](existing[spec.key]),
    inputHint: INPUT_HINTS[spec.coercion],
  }))
}

export type AnswerResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Turn one typed answer into a config value, or `undefined` for "leave unset".
 *
 * Everything goes through the shipped coercer, including the empty-means-absent
 * rule — so `""`, `[]` and `{}` all come back as `undefined` here exactly as they
 * would resolve on every reader.
 */
export function answerToValue(question: Question, raw: string): AnswerResult {
  const text = raw.trim()
  if (!text) return { ok: true, value: undefined }
  const coerce = COERCERS[question.coercion]
  if (question.coercion === "nameList") {
    return { ok: true, value: coerce(text.split(",")) }
  }
  if (question.coercion === "overridesMap") {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { ok: false, error: `not valid JSON: ${(error as Error)?.message ?? "parse error"}` }
    }
    const value = coerce(parsed)
    if (value === undefined) {
      return { ok: false, error: 'expected {"provider": {"param": value}} with at least one entry' }
    }
    return { ok: true, value }
  }
  if (question.coercion === "flag") {
    if (/^(y|yes|true|1)$/i.test(text)) return { ok: true, value: true }
    if (/^(n|no|false|0)$/i.test(text)) return { ok: true, value: false }
    return { ok: false, error: "expected yes or no" }
  }
  const value = coerce(text)
  if (value === undefined) return { ok: true, value: undefined }
  if (question.suggestions.length && !question.suggestions.includes(value as string)) {
    return { ok: false, error: `expected one of: ${question.suggestions.join(", ")}` }
  }
  return { ok: true, value }
}

/** Render a resolved value back into the text a prompt should be pre-filled with. */
export function initialText(question: Question): string {
  const value = question.initial
  if (value === undefined) return ""
  if (Array.isArray(value)) return value.join(",")
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "object" && value !== null) return JSON.stringify(value)
  return String(value)
}
