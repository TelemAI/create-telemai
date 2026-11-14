// Build presets: one source, more than one published installer.
//
// The default build has no preset and is `@telemai/create`. A preset build is the
// same code with different DEFAULTS for `--base-url` and `--mcp-url`, published under
// its own name, so that `npm create @telemai/<name>` (npm runs `@telemai/create-<name>`)
// sets up that deployment with no flags to type. `scripts/build.mjs --preset <name>`
// selects one at build time; `scripts/hack-package.mjs` builds and stages the package.
//
// A preset is EXACTLY the two flags: it fills `--base-url` and `--mcp-url` when they
// are not given (see `withPreset`), before the saved credentials are read. So a flag
// still wins, and a saved url from an earlier run of the default installer does not.

export type Preset = {
  /** `npm create @telemai/<name>` runs this preset's package, `@telemai/create-<name>`. */
  name: string
  baseUrl: string
  mcpUrl: string
}

export const PRESETS: Record<string, Preset> = {
  // The hackathon stack: the console, the API and the MCP server on one host. Named
  // "event" because npm refuses package names with "hack" in them.
  event: {
    name: "event",
    baseUrl: "https://hack.telem.ai/api",
    mcpUrl: "https://hack.telem.ai/mcp",
  },
}

// Replaced by esbuild's `define` in a preset build. Unset everywhere else (the default
// build, and the tests, which run these sources directly), so `typeof` is "undefined".
declare const __TELEM_PRESET__: string | undefined

/** The preset this bundle was built with, or undefined for `@telemai/create`. */
export const BUILD_PRESET: Preset | undefined = typeof __TELEM_PRESET__ === "string" ? presetNamed(__TELEM_PRESET__) : undefined

// A misspelt `--preset` must not build a package that quietly behaves as the default one.
function presetNamed(name: string): Preset {
  const preset = PRESETS[name]
  if (!preset) throw new Error(`unknown build preset ${JSON.stringify(name)}; known: ${Object.keys(PRESETS).join(", ")}`)
  return preset
}

/** The npm package this build is published as. */
export const PACKAGE_NAME = BUILD_PRESET ? `@telemai/create-${BUILD_PRESET.name}` : "@telemai/create"

/** What the installer's own hints tell the user to run again. */
export const NPX_COMMAND = `npx ${PACKAGE_NAME}`
export const CREATE_COMMAND = BUILD_PRESET ? `npm create @telemai/${BUILD_PRESET.name}` : "npm create @telemai"

/** The flags with the preset's urls filled in where the user gave none. */
export function withPreset<T extends { baseUrl?: string; mcpUrl?: string }>(flags: T, preset: Preset | undefined): T {
  if (!preset) return flags
  return { ...flags, baseUrl: flags.baseUrl ?? preset.baseUrl, mcpUrl: flags.mcpUrl ?? preset.mcpUrl }
}
