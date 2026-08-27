// The command port: spawn a program, capture its result, and NEVER throw.
//
// On POSIX this is a bare `spawnSync(command, args, { shell: false })`. A shell is
// deliberately off — it would give a home directory with a space in it a second
// meaning — and every argv element already comes from our own tables (the API key
// is never among them, by construction).
//
// On Windows that same shell:false spawn cannot run the tools we install through.
// `claude`/`npx`/`pi` resolve (via PATHEXT, in `whichSync`) to `.cmd` shims, and
// Node >= 20 REFUSES to spawn a `.cmd`/`.bat` without a shell (CVE-2024-27980 →
// EINVAL) while a bare name ENOENTs. So on win32:
//
//   * a `.cmd`/`.bat` target is run through `cmd.exe /d /s /c` with EVERY element
//     quoted the cross-spawn / qntm.org way (see the escapers). The spaced-home-dir
//     property is preserved by QUOTING, not by turning a shell on blind, and no
//     element can break out of the quoting: metacharacters are caret-neutralised so
//     cmd's own tokenizer never interprets `& | > …`, and the API key is never in
//     argv to begin with;
//   * a real `.exe`/`.com` (powershell, uv, …) is spawned DIRECTLY, shell:false, so
//     Node's own argv encoder handles it and the cmd.exe metacharacter layer is
//     never involved at all.
//
// And it never throws. A spawn failure — the EINVAL Node raises for a bare `.cmd`,
// an ENOENT for a missing binary — comes back as a captured null status, so the
// surface is reported "failed" instead of a PRE-COMMIT probe (e.g. `claude mcp
// list`) unwinding `drive` and aborting the whole run with nothing written.

import { spawnSync } from "node:child_process"

import { whichSync } from "./detect.ts"
import type { Env, ExecResult } from "./detect.ts"

// cmd.exe metacharacters (www.robvanderwoude.com/escapechars.php) — the cross-spawn
// set. Space is included so an unquoted token can never split, and `^`/`"` so the
// escaping cannot itself be escaped away.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Caret-escape cmd.exe metacharacters in a bare command token (cross-spawn's `command`). */
export function escapeCmdCommand(arg: string): string {
  return arg.replace(CMD_META, "^$1")
}

/**
 * Quote one argument for a `cmd.exe /d /s /c` command line, the cross-spawn /
 * qntm.org way, in two layers that peel apart cmd's parse from the program's parse:
 *
 *   1. Encode it for the TARGET program's CommandLineToArgvW — double the
 *      backslashes that precede a quote, escape the quote, then wrap in quotes so a
 *      space groups as one argument.
 *   2. Caret-escape every cmd metacharacter (including the wrapping quotes) so cmd's
 *      OWN tokenizer never enters quote-mode and never interprets `& | > …`; it just
 *      strips carets and hands the literal quotes through to the program.
 *
 * `doubleEscape` adds a second caret pass for a `.cmd`/`.bat` target, whose body
 * re-parses `%*` a second time through cmd.
 */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let out = `${arg}`
  // Backslashes that precede a quote: double them, then escape the quote.
  out = out.replace(/(\\*)"/g, '$1$1\\"')
  // Backslashes at the end (which land before the closing quote we add): double them.
  out = out.replace(/(\\*)$/, "$1$1")
  out = `"${out}"`
  out = out.replace(CMD_META, "^$1")
  if (doubleEscape) out = out.replace(CMD_META, "^$1")
  return out
}

type SpawnExtra = { windowsVerbatimArguments?: boolean }

/** Normalise a spawnSync result (or an errored one) into the captured shape. */
function capture(result: ReturnType<typeof spawnSync>): ExecResult {
  const stdout = (result.stdout as string | null) ?? ""
  const stderr = (result.stderr as string | null) ?? ""
  // A failed spawn reports on `.error` with a null status; surface its message so
  // the summary can say WHY the surface failed, but keep the status null/​non-zero.
  const detail = result.error ? `${result.error.message}${stderr ? `\n${stderr}` : ""}` : stderr
  return { status: result.status, stdout, stderr: detail }
}

function safeSpawn(command: string, args: string[], extra: SpawnExtra = {}): ExecResult {
  try {
    return capture(
      spawnSync(command, args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10 * 60_000,
        ...extra,
      }),
    )
  } catch (error) {
    // Node >= 20 THROWS (rather than reporting on `.error`) when asked to spawn a
    // `.cmd`/`.bat` without a shell. Whatever the shape, a spawn failure is a failed
    // surface — never a throw that unwinds the run and loses the file-based surfaces
    // that would have succeeded.
    return { status: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run `argv`, capturing `{ status, stdout, stderr }`. `ctx` defaults to the real
 * process; tests pass an explicit platform/env. Never throws.
 */
export function exec(
  argv: string[],
  ctx: { platform: string; env: Env } = { platform: process.platform, env: process.env },
): ExecResult {
  const [command, ...args] = argv
  if (command === undefined) return { status: null, stdout: "", stderr: "no command given" }

  if (ctx.platform !== "win32") {
    // POSIX: unchanged. shell:false — a space in a path is safe with no shell to
    // reinterpret it.
    return safeSpawn(command, args)
  }

  // win32: resolve so we know whether we are looking at a batch shim or a real exe.
  const resolved = whichSync(command, { env: ctx.env, platform: "win32" }) ?? command
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = ctx.env.ComSpec ?? ctx.env.COMSPEC ?? "cmd.exe"
    const line = [escapeCmdCommand(resolved), ...args.map((a) => escapeCmdArgument(a, true))].join(" ")
    // /d: no AutoRun. /s: strip exactly the outer quote pair. verbatim: hand cmd our
    // command line as-is, since we have already done every layer of quoting.
    return safeSpawn(comspec, ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true })
  }
  // A real .exe/.com (or an unresolved name that will ENOENT into a captured
  // failure): spawn directly. Node's own argv encoder quotes spaces safely and no
  // cmd.exe metacharacter layer is in play.
  return safeSpawn(resolved, args)
}
