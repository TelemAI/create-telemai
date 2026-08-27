// Host detection: which of the things we can install are already on this machine.
//
// Detection is a PATH lookup first and an exec second. The lookup is what decides
// whether a surface is offered — it cannot hang, cannot run a stranger's code with
// our arguments, and is trivially stubbable with a directory of fake binaries,
// which is exactly how `detect.test.ts` drives it. The exec only fetches a version
// string for the summary, runs with a short timeout, and its failure is never
// fatal: a host that is on PATH but will not answer `--version` is still installed.

import { accessSync, constants } from "node:fs"
import { spawnSync } from "node:child_process"
import { delimiter, isAbsolute, join } from "node:path"

import { MIN_OPENCLAW_VERSION, SURFACES } from "./surfaces.ts"

export type Env = Record<string, string | undefined>

export type ToolInfo = {
  name: string
  path: string | null
  version?: string
}

export type ExecResult = { status: number | null; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[]) => ExecResult

export type DetectDeps = {
  env: Env
  platform?: string
  isExecutable?: (path: string) => boolean
  exec?: ExecFn
  /** Probe versions as well as presence. Off in tests that only stub PATH. */
  probeVersions?: boolean
}

/** Everything the wizard ever asks about, PATH-wise. */
export const PROBE_NAMES: readonly string[] = [
  ...SURFACES.map((surface) => surface.probe).filter((probe): probe is string => probe !== null),
  "node",
  "npm",
  "python3",
  "python",
  "pip3",
  "pip",
  "uv",
  "telem-mcp",
  "telem-install-skill",
]

export function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function defaultExec(command: string, args: string[]): ExecResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    // No shell: the command comes from our own table, and a shell would give a
    // directory name with a space in it a second meaning.
    shell: false,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

/**
 * `which`, without the subprocess. Returns the first executable match on PATH, or
 * `null`. On Windows every `PATHEXT` extension is tried, because `claude` there is
 * `claude.cmd` and a bare-name check finds nothing.
 */
export function whichSync(name: string, deps: DetectDeps): string | null {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const platform = deps.platform ?? process.platform
  const pathValue = deps.env.PATH ?? deps.env.Path ?? deps.env.path ?? ""
  const extensions =
    platform === "win32"
      ? ["", ...(deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""]

  if (name.includes("/") || name.includes("\\")) {
    const candidate = isAbsolute(name) ? name : null
    return candidate && isExecutable(candidate) ? candidate : null
  }

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

export function detectTools(names: readonly string[], deps: DetectDeps): Record<string, ToolInfo> {
  const exec = deps.exec ?? defaultExec
  const out: Record<string, ToolInfo> = {}
  for (const name of names) {
    const path = whichSync(name, deps)
    const info: ToolInfo = { name, path }
    if (path && deps.probeVersions) {
      try {
        const result = exec(path, ["--version"])
        const text = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0]?.trim()
        if (text) info.version = text.slice(0, 80)
      } catch {
        // A host that will not answer --version is still installed.
      }
    }
    out[name] = info
  }
  return out
}

/** Surface ids whose probe binary is present (a surface with no probe is always offered). */
export function detectedSurfaceIds(tools: Record<string, ToolInfo>): string[] {
  return SURFACES.filter((surface) => surface.probe === null || tools[surface.probe]?.path).map(
    (surface) => surface.id,
  )
}

/** Is the Python SDK reachable — and if not, what could install it? */
export function pythonInstaller(tools: Record<string, ToolInfo>): string[] | null {
  if (tools["telem-install-skill"]?.path) return null
  if (tools.uv?.path) return ["uv", "tool", "install"]
  if (tools.pip3?.path) return ["pip3", "install"]
  if (tools.pip?.path) return ["pip", "install"]
  if (tools.python3?.path) return [tools.python3.path, "-m", "pip", "install"]
  return null
}

/**
 * The user-level, no-sudo command that installs `uv` itself, when no Python package
 * manager exists at all (design). Astral's official one-line scripts land in
 * `~/.local/bin` (POSIX) / `%USERPROFILE%\.local\bin` (Windows) — never system-wide.
 * The `.sh` form is POSIX-only, so the platform picks the pipeline: `process.platform`
 * decides here, and the argv is a shell invocation because the install is a piped
 * one-liner, not a single binary. Returns the argv the plan should run.
 */
export function uvInstallCommand(platform: string): string[] {
  return platform === "win32"
    ? ["powershell", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
    : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]
}

// ---------------------------------------------------------------------------
// Host version floors (absorbed from `version_at_least` + `MIN_*`)
// ---------------------------------------------------------------------------

// `MIN_OPENCLAW_VERSION` lives in the surface catalog beside the openclaw entry
// whose picker hint quotes it — one definition, so the number the user reads and the
// number the gate enforces cannot drift. Re-exported here because this is where the
// gate lives and where every caller already imports it from.
export { MIN_OPENCLAW_VERSION } from "./surfaces.ts"

/**
 * Component-by-component "major.minor.patch" compare — a direct port of
 * `version_at_least`. A missing or non-numeric component reads as 0, so a version
 * string this cannot fully parse degrades to "too old" rather than silently passing
 * the gate. Returns true when `have` >= `want`.
 */
export function versionAtLeast(have: string, want: string): boolean {
  const component = (value: string | undefined): number =>
    value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : 0
  const haveParts = have.split(".")
  const wantParts = want.split(".")
  for (let index = 0; index < 3; index += 1) {
    const a = component(haveParts[index])
    const b = component(wantParts[index])
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

/**
 * Pull the first "X.Y.Z" out of a host's `--version` output (openclaw prints more
 * than the bare number), mirroring `grep -oE '[0-9]+\.[0-9]+\.[0-9]+'`.
 */
export function extractSemver(text: string): string | null {
  const match = text.match(/[0-9]+\.[0-9]+\.[0-9]+/)
  return match ? match[0] : null
}

/**
 * Is a detected openclaw below the floor? An unparsable `--version` output is NOT a
 * block (: the floor gates a KNOWN-bad version, it is not a whitelist of
 * known-good output shapes), so `found: null` returns `below: false`.
 */
export function openclawBelowFloor(versionText: string | undefined): {
  below: boolean
  found: string | null
} {
  const found = versionText ? extractSemver(versionText) : null
  if (!found) return { below: false, found: null }
  return { below: !versionAtLeast(found, MIN_OPENCLAW_VERSION), found }
}
