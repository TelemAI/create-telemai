// Flag parsing. The flags ARE the non-interactive API: everything the
// interview can decide has a flag, because a wizard that can only be driven by a
// human cannot be driven by CI — and CI is where `!process.stdin.isTTY` sends us.
//
// Pure: no process, no env, no IO. `parseFlags` never throws; it returns errors so
// the caller can print all of them at once instead of one per run.

import type { SurfaceId } from "./surfaces.ts"
import { SURFACE_IDS } from "./surfaces.ts"

export type Flags = {
  yes: boolean
  clients: SurfaceId[]
  login: boolean
  baseUrl?: string
  keyEnv?: string
  json: boolean
  dryRun: boolean
  project: boolean
  codexDisableWebSearch: boolean
  /** Codex reasoning capture is ADDITIVE and ON by default; --no-codex-reasoning opts out. */
  codexReasoning: boolean
  /** Non-interactive consent to migrate an existing stdio Codex telem table to the hosted remote. */
  /** Non-interactive consent to replace an OLDER hand-written Codex reasoning hook
   * (hooks.json + ~/.codex/hooks/telem-reasoning.*) with the Codex plugin that now
   * carries it. Without consent the plugin is not installed at all: both hooks would
   * fire on every search. */
  codexMigrateHooks: boolean
  installUv: boolean
  writeUnverified: boolean
  help: boolean
  version: boolean
}

export type ParsedFlags = { flags: Flags; errors: string[] }

const EMPTY: Flags = {
  yes: false,
  clients: [],
  login: false,
  json: false,
  dryRun: false,
  project: false,
  codexDisableWebSearch: false,
  // ON by default: reasoning capture only adds capture, it disables nothing.
  codexReasoning: true,
  codexMigrateHooks: false,
  installUv: false,
  writeUnverified: false,
  help: false,
  version: false,
}

/** Flags that take a value, in both `--flag value` and `--flag=value` spellings. */
const VALUE_FLAGS = new Set(["--client", "--base-url", "--key-env"])

export function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: Flags = { ...EMPTY, clients: [] }
  const errors: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    let name = arg
    let inlineValue: string | undefined
    const equals = arg.indexOf("=")
    if (arg.startsWith("--") && equals > 2) {
      name = arg.slice(0, equals)
      inlineValue = arg.slice(equals + 1)
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue
      if (value === undefined) {
        value = argv[index + 1]
        index += 1
      }
      if (value === undefined || value.startsWith("--")) {
        errors.push(`${name} needs a value`)
        if (value !== undefined) index -= 1
        continue
      }
      if (name === "--client") {
        // Repeatable AND comma-separated: `--client opencode --client codex` and
        // `--client opencode,codex` both work, because both spellings show up in
        // hand-written CI files and rejecting one is a pointless papercut.
        for (const raw of value.split(",")) {
          const id = raw.trim()
          if (!id) continue
          if (!(SURFACE_IDS as readonly string[]).includes(id)) {
            errors.push(`unknown --client ${id}; valid: ${SURFACE_IDS.join(", ")}`)
            continue
          }
          if (!flags.clients.includes(id as SurfaceId)) flags.clients.push(id as SurfaceId)
        }
      } else if (name === "--base-url") {
        const trimmed = value.trim().replace(/\/+$/, "")
        if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
          errors.push(`--base-url must be an http(s) URL; got ${value}`)
        } else {
          flags.baseUrl = trimmed
        }
      } else {
        const trimmed = value.trim()
        if (!trimmed) errors.push("--key-env needs an environment variable name")
        else flags.keyEnv = trimmed
      }
      continue
    }

    if (inlineValue !== undefined) {
      errors.push(`${name} does not take a value`)
      continue
    }

    switch (arg) {
      case "--yes":
      case "-y":
        flags.yes = true
        break
      case "--login":
        flags.login = true
        break
      case "--json":
        flags.json = true
        break
      case "--dry-run":
        flags.dryRun = true
        break
      case "--project":
        flags.project = true
        break
      case "--codex-disable-web-search":
        flags.codexDisableWebSearch = true
        break
      case "--no-codex-reasoning":
        flags.codexReasoning = false
        break
      case "--codex-migrate-hooks":
        flags.codexMigrateHooks = true
        break
      case "--install-uv":
        flags.installUv = true
        break
      case "--write-unverified":
        flags.writeUnverified = true
        break
      case "--help":
      case "-h":
        flags.help = true
        break
      case "--version":
      case "-V":
        flags.version = true
        break
      default:
        errors.push(`unknown option ${arg}`)
    }
  }

  return { flags, errors }
}

/**
 * What a NON-INTERACTIVE run still needs from the command line. Interactive runs
 * ask for all of it, so this is only consulted in flags mode — and it returns the
 * WHOLE list, so a CI author fixes one invocation instead of discovering the
 * requirements one failed run at a time.
 */
export function missingRequiredFlags(flags: Flags, env: Record<string, string | undefined>): string[] {
  const missing: string[] = []
  if (!flags.login && flags.clients.length === 0) {
    missing.push(
      `--client <name> (one or more of: ${SURFACE_IDS.join(", ")}) — or --login for credentials only`,
    )
  }
  if (flags.login && !flags.keyEnv) {
    missing.push("--key-env <VAR> — --login writes a key, so it needs one to read")
  }
  if (flags.keyEnv && !(env[flags.keyEnv] ?? "").trim()) {
    missing.push(`--key-env ${flags.keyEnv}, but ${flags.keyEnv} is unset or empty in the environment`)
  }
  return missing
}

/**
 * Flags an INTERACTIVE run silently discards, because the wizard asks the same
 * question instead. `--client opencode` on its own is the trap: the help text used to
 * label it "non-interactive", but interactivity is decided by `--yes`/`CI`/`!isTTY`
 * alone, so at a terminal the flag is parsed, validated, and then thrown away while
 * the user picks surfaces by hand. Naming them beats leaving the user to notice.
 */
export function ignoredInteractiveFlags(flags: Flags): string[] {
  const ignored: string[] = []
  if (flags.clients.length) ignored.push("--client (the wizard asks which surfaces)")
  if (flags.project) ignored.push("--project (the wizard asks about the project config)")
  if (flags.codexDisableWebSearch) ignored.push("--codex-disable-web-search (the wizard asks)")
  if (flags.codexMigrateHooks) ignored.push("--codex-migrate-hooks (the wizard asks)")
  if (flags.installUv) ignored.push("--install-uv (the wizard asks)")
  if (flags.writeUnverified) ignored.push("--write-unverified (the wizard asks)")
  return ignored
}

export const HELP_TEXT = `create-telemai — set up Telem web search in your coding agents

Telem routes your agent's web searches through one API across nine search
providers, and records what it searched. This installer finds the agents you have,
takes your API key, and wires Telem into each one you pick.

Usage:
  npm create @telemai                              interactive
  npm create @telemai -- --yes --client opencode   non-interactive
  npx @telemai/create --login                      add or replace your API key (prompts)
  npx @telemai/create --login --key-env TELEM_API_KEY   the same, from the environment

Flags (they double as the non-interactive API):
  --yes, -y                     never prompt: run from flags only (it still needs
                                --client or --login), and consent to the Python SDK
                                install
  --client <name>               tool to install into; repeatable or comma-separated
                                one or more of:
                                ${SURFACE_IDS.join(", ")}
  --login                       credentials only: verify a key, write it, exit
  --base-url <url>              Telem deployment to configure and verify against
  --key-env <VAR>               read the API key from this environment variable
                                instead of prompting (the CI path)
  --project                     also write <cwd>/.telem/telem.json
  --codex-disable-web-search    also set web_search = "disabled" in Codex's config
  --no-codex-reasoning          skip the Codex telem plugin (reasoning hook AND
                                telem skill) and model_reasoning_summary; capture
                                is on by default
  --codex-migrate-hooks         replace an older hand-written Codex reasoning hook
                                with the telem Codex plugin (non-interactive
                                consent; without it the plugin is not installed,
                                because both hooks would fire)
  --install-uv                  consent to the whole Python bootstrap: install
                                telem-sdk with whatever package manager is
                                found and, if none is, install uv itself
                                (user-level, no sudo). Non-interactive consent —
                                at a terminal the wizard asks instead. --yes
                                consents to the first half only: installing uv is
                                a curl|sh from the network, so it always needs
                                this flag
  --write-unverified            write a key whose verification could not be
                                completed (unreachable, 429/5xx, or an unexpected
                                status). It never bypasses a 401/403 — those mean
                                the key is bad
  --json                        machine-readable summary on stdout; implies a
                                non-interactive run (flags only, never prompts)
  --dry-run                     print the staged plan; write nothing
  --help, -h                    this text
  --version, -V                 print the version

Exit codes: 0 done, 1 error, 130 cancelled.

Nothing is written until every question is answered: cancel at any prompt, or
pass --dry-run, and the machine is untouched. The commit is not atomic across
files, though — if it fails part way it names the files that already landed.

The API key never goes on a command line and is never printed. It is written to
exactly three files, all 0600 — which of them depends on what you install:
  ~/.telem/credentials.json   always; every surface falls back to it
  ~/.codex/config.toml        with --client codex: the Authorization header of
                              [mcp_servers.telem], which the hosted Telem MCP
                              authenticates per request
  ~/.claude/settings.json     with --client claude-code:
                              pluginConfigs["telem@telem"].options.TELEM_API_KEY,
                              which the plugin's inline MCP server reads`
