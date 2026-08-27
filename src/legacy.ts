// Legacy host config files, and why the wizard has to look at them.
//
// The ladder puts the DEPRECATED per-host files ABOVE the generic user
// file, deliberately: `.opencode/telem.json` (level 3) and
// `~/.config/opencode/telem.json` (level 4) both outrank `~/.telem/telem.json`
// (level 5), because a setting someone made for one surface must not invert when
// a cross-surface default arrives.
//
// The consequence for an installer is an earlier review named: a user with
// `~/.config/opencode/telem.json` = `{"tier": "max"}` answers "minimalist" in the
// interview, the wizard writes it to the file it manages, reports success — and
// opencode keeps sending `max` forever, because the legacy file wins.
//
// The wizard does NOT migrate or delete those files: they belong to the surfaces
// that shipped them, and silently moving another tool's config is exactly the kind
// of help nobody asked for. It reads them and SAYS SO — visibility, not a gate,
// the same call the plugins' own once-per-edit notices make.

import { coerceOption, type TelemOptionKey } from "../config-core/options.ts"

export type LegacyFile = {
  path: string
  /** Which surface shipped it, for the message. */
  surface: string
  /** Option keys this file actually supplies (already coerced). */
  keys: string[]
}

const LEGACY_USER_PATHS: readonly { surface: string; segments: readonly string[] }[] = [
  { surface: "opencode", segments: [".config", "opencode", "telem.json"] },
  { surface: "pi", segments: [".config", "pi", "telem.json"] },
]

const LEGACY_PROJECT_PATHS: readonly { surface: string; segments: readonly string[] }[] = [
  { surface: "opencode", segments: [".opencode", "telem.json"] },
  { surface: "pi", segments: [".pi", "telem.json"] },
]

function keysIn(source: string | null): string[] {
  if (source === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(source.replace(/^﻿/, ""))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>
  return Object.keys(record).filter(
    (key) => coerceOption(key as TelemOptionKey, record[key]) !== undefined,
  )
}

/**
 * Every legacy file that is in force and supplies at least one option key.
 * `home`/`projectRoot` are passed in so this stays pure and testable.
 */
export function findLegacyFiles(
  readText: (path: string) => string | null,
  join: (...parts: string[]) => string,
  locations: { home: string; projectRoot?: string },
): LegacyFile[] {
  const found: LegacyFile[] = []
  for (const entry of LEGACY_USER_PATHS) {
    const path = join(locations.home, ...entry.segments)
    const keys = keysIn(readText(path))
    if (keys.length) found.push({ path, surface: entry.surface, keys })
  }
  if (locations.projectRoot) {
    for (const entry of LEGACY_PROJECT_PATHS) {
      const path = join(locations.projectRoot, ...entry.segments)
      const keys = keysIn(readText(path))
      if (keys.length) found.push({ path, surface: entry.surface, keys })
    }
  }
  return found
}

/**
 * One warning per legacy file whose keys OVERLAP what we just wrote to the user
 * file — i.e. the cases where the user's answer will not take effect. A legacy
 * file that sets keys nobody answered is not a surprise and is not mentioned.
 */
export function legacyWarnings(files: readonly LegacyFile[], writtenKeys: readonly string[]): string[] {
  const warnings: string[] = []
  for (const file of files) {
    const shadowed = file.keys.filter((key) => writtenKeys.includes(key))
    if (!shadowed.length) continue
    warnings.push(
      `${file.path} is a deprecated ${file.surface} config that OUTRANKS ~/.telem/telem.json, ` +
        `so it still decides ${shadowed.join(", ")} for ${file.surface}. ` +
        "Move those keys into the Telem config and delete that file.",
    )
  }
  return warnings
}
