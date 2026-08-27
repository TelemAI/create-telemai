// Entry point. Everything real lives in `run.ts`; this file only builds the real
// ports out of the real process, so that the whole wizard can be driven from a
// test by handing `run` a different set.
//
// NODE, NEVER BUN. The shipped bundle carries a `#!/usr/bin/env node` shebang and
// the README pins node, because the prompt library is broken under Bun (oven-sh/bun
// arrow keys stop working in a select that follows a text prompt, and the
// terminal is left unresponsive). opencode is a Bun binary, so `bunx` is a
// plausible thing for one of our own users to reach for — hence the pin.

import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { exec } from "./exec.ts"
import { existsSync, readTextSync } from "./fsops.ts"
import { run } from "./run.ts"
import { loadClackUi } from "./ui.ts"

export const VERSION = "0.1.15"

/** Where `scripts/copy-plugins.mjs` puts the plugin packages inside this one. */
export const PACKAGED_PLUGINS_DIR = "plugins"

/**
 * The the sibling plugin source the Claude planner registers as a local
 * marketplace. `TELEM_CLAUDE_PLUGIN_DIR` wins (the E2E gate / an unusual layout).
 */
function resolveClaudePluginDir(): string | undefined {
  return resolvePluginDir("TELEM_CLAUDE_PLUGIN_DIR", "claude-plugin-telem")
}

/**
 * The same for the sibling plugin, which the Codex surface registers as a local
 * Codex marketplace. `TELEM_CODEX_PLUGIN_DIR` overrides it.
 */
function resolveCodexPluginDir(): string | undefined {
  return resolvePluginDir("TELEM_CODEX_PLUGIN_DIR", "codex-plugin-telem")
}

/**
 * Where a plugin package lives, in the order the three answers can be true.
 *
 *   1. `TELEM_<HOST>_PLUGIN_DIR` — an explicit override: the E2E gate, an unusual
 *      layout, a plugin checkout somewhere else entirely. Never second-guessed, not
 *      even for existence: if the user named a directory, the failure they get should
 *      be about the directory they named.
 *   2. `<package>/plugins/<name>` — the copy `prepack` puts INSIDE this package. On an
 *      `npx @telemai/create` this is the ONLY one that can exist, and it is what makes
 *      the two plugin surfaces work for anybody who is not us: the published tarball
 *      used to ship `dist/` alone, so the resolver returned undefined on every user
 *      machine and both plugin routes degraded to "install it by hand" for a directory
 *      the user does not have. It ranks above the sibling because on a stranger's
 *      machine a sibling directory of this name is a coincidence, not our package.
 *   3. `<package>/./<name>` — the sibling in a monorepo checkout: how the repo runs
 *      it, and (with `postpack` cleaning the copy up again) still what a dev run
 *      resolves to, so an edit to a plugin is live rather than a stale copy.
 *
 * `undefined` means none of them exist, and the planners then guide the user by hand
 * rather than planning a command that cannot work.
 */
export function resolvePluginDir(
  envVar: string,
  dirName: string,
  deps: {
    env?: Record<string, string | undefined>
    /** The module this package runs from: `dist/index.js` published, `src/index.ts` here. */
    entry?: string
    exists?: (path: string) => boolean
  } = {},
): string | undefined {
  const env = deps.env ?? process.env
  const override = (env[envVar] ?? "").trim()
  if (override) return override
  const exists = deps.exists ?? existsSync
  // dist/index.js -> dist -> the package root. src/index.ts sits one level down too,
  // so the same arithmetic holds in the checkout and in the tarball.
  const packageRoot = dirname(dirname(deps.entry ?? fileURLToPath(import.meta.url)))
  const packaged = join(packageRoot, PACKAGED_PLUGINS_DIR, dirName)
  if (exists(packaged)) return packaged
  // create-telemai -> the monorepo root; the plugin is its sibling.
  const sibling = join(dirname(packageRoot), dirName)
  return exists(sibling) ? sibling : undefined
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return run({
    argv,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    // `isTTY` is undefined, not false, on a piped stdin — hence the Boolean.
    isTTY: Boolean(process.stdin.isTTY),
    version: VERSION,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readText: readTextSync,
    exists: existsSync,
    exec,
    fetchImpl: (input, init) => fetch(input, init),
    loadUi: loadClackUi,
    claudePluginDir: resolveClaudePluginDir(),
    codexPluginDir: resolveCodexPluginDir(),
  })
}

/**
 * Run only as a program, never on import.
 *
 * `argv[1]` stays the path AS INVOKED — for an npm bin, that is the
 * `node_modules/.bin/create-telemai` SYMLINK, not its target — while
 * `import.meta.url` is already the real path node loaded. Comparing them without
 * realpath never matches through the symlink, so the bin would silently do
 * nothing. (This is the exact bug the sibling plugin
 * documents at its own bottom; same fix.
 */
function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
