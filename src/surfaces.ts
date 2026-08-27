// The surface catalog: every thing this wizard can install, and the one
// executable whose presence on PATH means the host is already here.
//
// This table is the ONLY place a surface is defined. `--client <name>` validates
// against it, the groupMultiselect is built from it, and the per-surface planners
// in `plan.ts` are keyed by its ids — so adding a surface is one entry plus one
// planner, never a scattered edit.

/**
 * The one host with a documented minimum: openclaw below this cannot load the Telem
 * plugin. It lives here, next to the entry whose hint quotes it, so the number the
 * user reads in the picker and the number `openclawBelowFloor` enforces are the same
 * one. No floor is invented for opencode, codex or claude — none has a documented
 * minimum, and a missing floor is not a bug.
 */
export const MIN_OPENCLAW_VERSION = "2026.7.1"

export type SurfaceId =
  | "opencode"
  | "claude-code"
  | "codex"
  | "pi"
  | "openclaw"
  | "claude-skill"
  | "mcp-json"

export type SurfaceGroup = "Agent hosts" | "Needs the Telem Python SDK" | "Copy-paste setup"

export type Surface = {
  id: SurfaceId
  label: string
  group: SurfaceGroup
  /**
   * Not offered in the interactive picker (still reachable via --client). The Claude
   * Agent Skill sits here pending the owner's universal-skill redesign (2026-08-18):
   * the Python-based per-host skill is being replaced, so the wizard stops advertising
   * it — removing it from the picker also removes the wizard's only Python path.
   */
  hiddenFromPicker?: boolean
  /**
   * Executable that proves the host is installed, or `null` for a surface that
   * needs no host of its own (a printed snippet, or one that rides the Python SDK).
   */
  probe: string | null
  /** One line shown next to the choice. */
  hint: string
  /**
   * Needs `telem-sdk` on the machine (pip/uv), not an npm package — i.e. this
   * surface runs a console script the distribution provides (`telem-mcp` for the
   * MCP clients, `telem-install-skill` for the skill). It is what gates the
   * Python bootstrap offer, so a surface that needs NO local process must be false:
   * Codex talks to the HOSTED remote over https and never runs `telem-mcp`, and
   * offering `uv tool install telem-sdk` on a codex-only run installs a
   * package nothing will execute.
   */
  needsPython: boolean
}

export const SURFACES: readonly Surface[] = [
  {
    id: "opencode",
    label: "opencode",
    group: "Agent hosts",
    probe: "opencode",
    hint: "Adds Telem search to opencode",
    needsPython: false,
  },
  {
    id: "claude-code",
    label: "Claude Code (plugin)",
    group: "Agent hosts",
    probe: "claude",
    hint: "Adds Telem search to Claude Code, and records what it searched",
    // Hosted plugin: the tools come from https://mcp.telem.ai/mcp, so no local
    // telem-mcp binary and no Python are needed.
    needsPython: false,
  },
  {
    id: "codex",
    label: "Codex (plugin)",
    group: "Agent hosts",
    probe: "codex",
    hint: "Adds Telem search to Codex, and records its reasoning",
    // The hosted remote: a url + an auth header in config.toml. No local telem-mcp
    // process is ever spawned, so this surface needs no Python at all.
    needsPython: false,
  },
  {
    id: "pi",
    label: "pi",
    group: "Agent hosts",
    probe: "pi",
    hint: "Adds Telem search to pi",
    needsPython: false,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    group: "Agent hosts",
    probe: "openclaw",
    // The planner deliberately does NOT delegate to telem-openclaw-setup any more
    // (that is a source-checkout dev tool): it installs the published plugin and
    // widens the tool policy, and the wizard itself owns the version gate.
    hint: `Adds Telem search to OpenClaw (needs OpenClaw ${MIN_OPENCLAW_VERSION} or newer)`,
    needsPython: false,
  },
  {
    id: "claude-skill",
    hiddenFromPicker: true,
    label: "Claude Agent Skill (needs Python)",
    group: "Needs the Telem Python SDK",
    probe: "telem-install-skill",
    hint: "Adds a Telem search skill to Claude Code",
    needsPython: true,
  },
  {
    id: "mcp-json",
    label: "Other MCP clients (Cursor, Windsurf, …)",
    group: "Copy-paste setup",
    probe: null,
    hint: "prints a ready-to-paste config for the hosted Telem server",
    // The printed snippet is the HOSTED server (a url + an Authorization header), so
    // nothing local is ever spawned and no Python is needed to paste it.
    needsPython: false,
  },
]

export const SURFACE_IDS: readonly SurfaceId[] = SURFACES.map((surface) => surface.id)

export function surfaceById(id: string): Surface | undefined {
  return SURFACES.find((surface) => surface.id === id)
}

/** Groups in catalog order, each with its surfaces — the shape groupMultiselect wants. */
export function surfaceGroups(): { group: SurfaceGroup; surfaces: Surface[] }[] {
  const groups: { group: SurfaceGroup; surfaces: Surface[] }[] = []
  for (const surface of SURFACES) {
    const existing = groups.find((entry) => entry.group === surface.group)
    if (existing) existing.surfaces.push(surface)
    else groups.push({ group: surface.group, surfaces: [surface] })
  }
  return groups
}

/** The npm package names the wizard installs, by surface. */
export const OPENCODE_PLUGIN_PACKAGE = "@telemai/opencode-plugin"
export const PI_PACKAGE = "@telemai/pi-telem"
export const OPENCLAW_PACKAGE = "@telemai/openclaw-plugin"
/** The pip distribution behind every Python surface. The base package: the only Python
 *  surface is the Claude Agent Skill, whose `telem-install-skill` ships in it. The `[mcp]`
 *  extra is gone from telem-sdk — asking for it would fail the install outright. */
export const PYTHON_PACKAGE = "telem-sdk"
/** The console script every MCP client runs. Env-free on purpose: the key lives in the credentials file. */
export const MCP_COMMAND = "telem-mcp"
/** What proves the Python SDK is installed. NOT `telem-mcp`: that console script went
 *  away with the `[mcp]` extra, so looking for it would report "not installed" forever
 *  — including on a machine that has the SDK. `telem-install-skill` ships in the base
 *  package and is what the one Python surface actually runs. */
export const PYTHON_PROBE = "telem-install-skill"
