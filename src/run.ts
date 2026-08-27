// The wizard itself: detect → choose surfaces → credentials → options → per-surface
// steps → commit → summary.
//
// Everything the run touches arrives through `Ports`, so the whole flow is
// drivable from a test without a terminal, a network, or a filesystem. The two
// rules that shape the code more than anything else:
//
//  * NOTHING IS WRITTEN UNTIL THE END. Every step appends to a `Plan`; the commit
//    is one call at the bottom. Cancel, an abort, or `--dry-run` all just return
//    before it.
//  * THE KEY NEVER GOES ON A COMMAND LINE AND IS NEVER PRINTED. No argv, no note,
//    no warning, no summary field ever carries it; `assertNoSecretInCommands` and
//    `assertNoSecretInText` turn that from a convention into a check.
//    It reaches exactly three FILES, all written 0600, and which of them depends on
//    the surfaces selected (`keyTargetFiles` is the one list):
//      ~/.telem/credentials.json — every surface falls back to it;
//      ~/.codex/config.toml — the `http_headers` Authorization line of
//        [mcp_servers.telem], because the hosted remote authenticates per request
//        and has no credentials.json to read;
//      ~/.claude/settings.json — pluginConfigs["telem@telem"].options.TELEM_API_KEY,
//        which the Claude Code plugin's inline MCP server reads.

import { dirname, join } from "node:path"

import { credentialsPath, resolveTelemDir, userConfigPath } from "../config-core/files.ts"
import {
  CLAUDE_MARKETPLACE,
  CLAUDE_PLUGIN_REF,
  CLAUDE_USER_CONFIG_KEY,
  claudeConfigDir,
  claudePluginConfigPath,
  planClaudePluginConfig,
} from "./claude.ts"
import { mergeTelemConfig } from "./configfile.ts"
import type { CodexHookTrustEntry } from "./codex.ts"
import {
  CODEX_HOOK_STATE_PATH,
  CODEX_TABLE,
  CODEX_URL,
  classifyCodexTelemTable,
  codexWebSearchDisabled,
  planCodexConfig,
} from "./codex.ts"
import {
  CODEX_HOOKS_DIRNAME,
  CODEX_HOOKS_JSON,
  CODEX_HOOK_FILENAME,
  CODEX_LAUNCHER_FILENAME,
  planCodexLegacyHooksRemoval,
} from "./codex-legacy-hooks.ts"
import {
  CODEX_PLUGIN_HOOKS_REL,
  CODEX_PLUGIN_REF,
  codexHomeDir,
  codexHookTrustEntries,
  codexPluginVersion,
  installedCodexPluginVersion,
} from "./codex-plugin.ts"
import {
  CONSOLE_URL,
  DEFAULT_BASE_URL,
  credentialsContents,
  maskKey,
  parseCredentials,
  readCredentialsFile,
  verifyKey,
} from "./credentials.ts"
import type { ExecResult, ToolInfo } from "./detect.ts"
import {
  PROBE_NAMES,
  detectTools,
  detectedSurfaceIds,
  openclawBelowFloor,
  pythonInstaller,
  uvInstallCommand,
} from "./detect.ts"
import type { InstallErrorContext } from "./errors.ts"
import { translateInstallError } from "./errors.ts"
import type { Flags } from "./flags.ts"
import { HELP_TEXT, ignoredInteractiveFlags, missingRequiredFlags, parseFlags } from "./flags.ts"
import type { Question } from "./interview.ts"
import {
  DEFAULT_PROVIDER_PICKS,
  DEFAULT_TIER,
  SEARCH_PROVIDERS,
  SUGGESTIONS,
  TIER_LABELS,
  WIZARD_KEYS,
  answerToValue,
  buildInterview,
  initialText,
} from "./interview.ts"
import { findLegacyFiles, legacyWarnings } from "./legacy.ts"
import { pickOpencodeConfigPath, planOpencodePlugin } from "./opencode.ts"
import type { FileRemoval, FileWrite, Plan, PlannedCommand, SurfaceOutcome, SurfaceStatus } from "./plan.ts"
import {
  addFile,
  assertNoSecretInCommands,
  assertNoSecretInText,
  commitPlan,
  emptyPlan,
  setOutcome,
  undoLine,
} from "./plan.ts"
import { findProjectRoot } from "./project.ts"
import type { Surface, SurfaceId } from "./surfaces.ts"
import {
  MCP_COMMAND,
  PYTHON_PROBE,
  OPENCLAW_PACKAGE,
  OPENCODE_PLUGIN_PACKAGE,
  PI_PACKAGE,
  PYTHON_PACKAGE,
  SURFACES,
  surfaceById,
  surfaceGroups,
} from "./surfaces.ts"
import type { Ui } from "./ui.ts"
import { isCancelledError } from "./ui.ts"

export type Env = Record<string, string | undefined>

export type Ports = {
  argv: readonly string[]
  env: Env
  cwd: string
  platform: string
  isTTY: boolean
  version: string
  stdout: (line: string) => void
  stderr: (line: string) => void
  readText: (path: string) => string | null
  exists: (path: string) => boolean
  exec: (argv: string[]) => ExecResult
  fetchImpl: typeof fetch
  loadUi: () => Promise<Ui>
  /**
   * Absolute path to the the sibling plugin source the Claude Code planner
   * registers as a local marketplace. The composition root (index.ts) fills this
   * in from the package layout; a run without it (or without the plugin dir on
   * disk) falls back to printing the two install commands for the user to run by
   * hand. `TELEM_CLAUDE_PLUGIN_DIR` in the env overrides it (the E2E gate path).
   */
  claudePluginDir?: string
  /**
   * The same thing for the sibling plugin, which the Codex surface registers as a
   * local Codex marketplace. `TELEM_CODEX_PLUGIN_DIR` overrides it.
   */
  codexPluginDir?: string
}

export type Summary = {
  version: string
  /**
   * The one field a consumer branches on. Every `--json` document carries it,
   * including the error documents, so a pipeline never has to infer success from
   * the presence or absence of other keys.
   */
  ok: boolean
  mode: "interactive" | "flags"
  dryRun: boolean
  baseUrl: string
  credentials: { status: string; path?: string; masked?: string }
  files: { path: string; created: boolean; reason: string; undo: string }[]
  /** Files this run DELETES (a migration off an older Telem install). */
  removals: { path: string; reason: string; undo: string }[]
  commands: { argv: string[]; status?: number | null; reason: string; skipped?: boolean }[]
  surfaces: SurfaceOutcome[]
  notes: string[]
  warnings: string[]
}

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_CANCELLED = 130

/**
 * What `--json` says when the run ends before it has a summary to print.
 *
 * `--json` is documented as "machine-readable summary on stdout", and every abort
 * used to return before `emit` — so a bad `--key-env`, a missing `--client`, an
 * unparseable config, a rejected key all produced a human line on stderr, exit 1,
 * and ZERO bytes on stdout: the flag failed exactly on the runs a pipeline needs it
 * to diagnose. Now every terminal path emits a document, and success and failure
 * share the `version`/`ok` prefix.
 *
 * `code` is the stable field: match on it, never on `message`.
 */
export type RunError = { code: string; message: string; remedy: string }

/** Emit the `--json` failure document, if `--json` is on, and return the exit code. */
function fail(ports: Ports, flags: Flags, error: RunError, exitCode = EXIT_ERROR): number {
  if (flags.json) {
    ports.stdout(JSON.stringify({ version: ports.version, ok: false, error }, null, 2))
  }
  return exitCode
}

/**
 * What the commit got through before it threw.
 *
 * "NOTHING IS WRITTEN UNTIL THE END" is true — one `commitPlan` call at the bottom —
 * but that call is not atomic ACROSS files: it can write credentials.json and
 * ~/.codex/config.toml and then die on an EACCES under ~/.codex/hooks. Printing
 * "Nothing was written." there tells the user their key is not on disk when it is,
 * which is the one thing this epilogue exists to be honest about. `commitPlan`
 * reports each path as it lands — written or removed — so the failure path can name
 * them; the verb does not matter here, "the disk already changed" does.
 */
export type CommitProgress = { started: boolean; written: string[] }

/**
 * `$HOME/x` → `~/x`, for HUMAN output only.
 *
 * Applied to whole LINES rather than to paths, because the paths are already embedded
 * in prose by the time they are printed. Both separators are handled: a Windows HOME
 * is `C:\\Users\\x` and the paths built from it use backslashes.
 */
export function abbreviateHome(text: string, home: string): string {
  const root = home.replace(/[\\/]+$/, "")
  if (!root || root === "/") return text
  return text.split(`${root}/`).join("~/").split(`${root}\\`).join("~\\")
}

function commitEpilogue(progress: CommitProgress): string {
  if (!progress.started) return "Nothing was written."
  if (!progress.written.length) return "Nothing was written before the failure."
  return `Some files on disk WERE already changed before the failure: ${progress.written.join(", ")}`
}

export async function run(ports: Ports): Promise<number> {
  const parsed = parseFlags(ports.argv)
  const flags = parsed.flags

  if (flags.help) {
    ports.stdout(HELP_TEXT)
    return EXIT_OK
  }
  if (flags.version) {
    ports.stdout(ports.version)
    return EXIT_OK
  }
  if (parsed.errors.length) {
    for (const error of parsed.errors) ports.stderr(`error: ${error}`)
    ports.stderr("run with --help for the full flag list")
    return fail(ports, flags, {
      code: "bad-flags",
      message: parsed.errors.join("; "),
      remedy: "run `npx @telemai/create --help` for the full flag list",
    })
  }

  // The no-TTY guard. Anything that is not a real terminal — a pipe, a CI runner,
  // `curl | sh` — takes the flags-only path, and from here on `ui` stays null so
  // clack is never imported, let alone called.
  //
  // `--json` is one of them. Its whole contract is "stdout carries exactly one JSON
  // document"; at a TTY the old hybrid ran the full clack interview and interleaved
  // its frames with that document on the same stream. A flag that promises a machine
  // its output therefore forces the machine path: flags only, no prompts.
  const nonInteractiveReason = flags.yes
    ? "--yes was passed"
    : flags.json
      ? "--json was passed, which runs from flags only"
      : ports.env.CI
        ? "CI is set in the environment"
        : !ports.isTTY
          ? "stdin is not a terminal"
          : null
  const interactive = nonInteractiveReason === null

  if (!interactive) {
    const missing = missingRequiredFlags(flags, ports.env)
    if (missing.length) {
      ports.stderr(`This is a non-interactive run (${nonInteractiveReason}), so nothing can be asked.`)
      ports.stderr("Missing:")
      for (const item of missing) ports.stderr(`  - ${item}`)
      ports.stderr("Nothing was written. Run with --help for the full flag list.")
      return fail(ports, flags, {
        code: "missing-flags",
        message: `this is a non-interactive run (${nonInteractiveReason}), so nothing can be asked; missing: ${missing.join("; ")}`,
        remedy: "pass the missing flags, or run in a terminal without --yes and without CI set",
      })
    }
  }

  const progress: CommitProgress = { started: false, written: [] }

  try {
    return await drive(ports, flags, interactive, progress)
  } catch (error) {
    if (isCancelledError(error)) {
      // A cancel can only come from a prompt, and every prompt is answered before the
      // commit — but the epilogue reads the record rather than assuming that.
      ports.stderr(`Cancelled. ${commitEpilogue(progress)}`)
      return fail(
        ports,
        flags,
        { code: "cancelled", message: commitEpilogue(progress), remedy: "re-run when you are ready" },
        EXIT_CANCELLED,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    ports.stderr(`error: ${message}`)
    ports.stderr(commitEpilogue(progress))
    return fail(ports, flags, {
      code: "internal",
      message: `${message} — ${commitEpilogue(progress)}`,
      remedy: "fix the error above and re-run; the installer skips whatever is already in place",
    })
  }
}

async function drive(
  ports: Ports,
  flags: Flags,
  interactive: boolean,
  progress: CommitProgress,
): Promise<number> {
  // With --json, every human line goes to stderr so stdout carries exactly one
  // JSON document and nothing else — the summary here, or the `ok: false` error
  // document `fail` prints on any path that ends before this one.
  //
  // Every human line also gets `$HOME` abbreviated to `~`. Every path this installer
  // prints lives under the home directory, and a summary row carrying the same
  // 40-character prefix three times is unreadable. The --json document is deliberately
  // NOT abbreviated — a consumer needs the real path.
  const home = ports.env.HOME ?? ports.env.USERPROFILE ?? ""
  const ui = interactive ? await ports.loadUi() : null
  const say = (line: string) => {
    const text = abbreviateHome(line, home)
    if (flags.json) return ports.stderr(text)
    // At a terminal, human lines go through clack. A plain stdout line inside the
    // frame has no `│` gutter: it visibly breaks the frame and leaves a stray gutter
    // hanging above the outro.
    if (ui) return ui.info(text)
    return ports.stdout(text)
  }
  const plan = emptyPlan()

  if (ui) ui.intro("Telem installer")

  // An interactive run answers these by asking, so a flag that set one is dead
  // weight. Say so rather than parsing it, validating it, and dropping it silently.
  if (interactive) {
    const ignored = ignoredInteractiveFlags(flags)
    if (ignored.length) {
      plan.warnings.push(
        `this is an interactive run, so ${ignored.join(", ")} ${
          ignored.length === 1 ? "was" : "were"
        } ignored — add --yes to run from flags only`,
      )
    }
  }

  // Detection walks PATH for every probe and, interactively, runs `--version` on each
  // one it finds: up to fifteen child processes before the first question. That used
  // to be a blank terminal.
  const detecting = ui?.spinner()
  detecting?.start("Looking for installed agents…")
  const tools = detectTools(PROBE_NAMES, {
    env: ports.env,
    platform: ports.platform,
    probeVersions: interactive,
  })
  const detected = detectedSurfaceIds(tools)
  const detectedHosts = SURFACES.filter(
    (surface) => surface.probe !== null && detected.includes(surface.id),
  ).map((surface) => appName(surface.label))
  detecting?.stop(
    detectedHosts.length
      ? `Found: ${detectedHosts.join(", ")}`
      : "No agent hosts found on PATH — every tool is still listed below",
  )

  const project = findProjectRoot(ports.cwd, ports.exists, {
    home: ports.env.HOME ?? ports.env.USERPROFILE,
    join,
    dirname,
  })

  const telemDir = resolveTelemDir(ports.env, project?.root)
  if (telemDir.warning) plan.warnings.push(telemDir.warning)
  const credsPath = credentialsPath(ports.env, project?.root).path
  const userPath = userConfigPath(ports.env, project?.root).path

  // ---- surfaces -----------------------------------------------------------
  const selected: SurfaceId[] = flags.login
    ? []
    : interactive
      ? await chooseSurfaces(ui as Ui, detected, plan)
      : flags.clients

  // ---- credentials --------------------------------------------------------
  const existingCredentials = parseCredentials(ports.readText(credsPath))
  // No prompt for the deployment URL. Only a self-hoster ever changes it, and a
  // self-hoster already has `--base-url`; asking everyone else to confirm a URL they
  // have no basis to change was one screen that never changed an answer. The key
  // note names the flag for the people it is for.
  const baseUrl = flags.baseUrl ?? existingCredentials.baseUrl ?? DEFAULT_BASE_URL

  const credential = await resolveCredential(ports, flags, ui, {
    baseUrl,
    existing: existingCredentials,
    say,
    plan,
    // Named from the ACTUAL selection: the note the user reads before pasting a
    // secret has to list the files this run will really put it in, not a count
    // that was right for some other selection.
    keyFiles: keyTargetFiles(selected, ports, home, credsPath, tools),
  })
  if (credential.abort) {
    ports.stderr("Nothing was written.")
    return fail(ports, flags, credential.error ?? UNKNOWN_CREDENTIAL_ERROR)
  }

  if (credential.apiKey) {
    const credsSource = ports.readText(credsPath)
    // A present-but-unparseable credentials.json is NOT treated as empty (which would
    // rebuild it from only apiKey+baseUrl and discard its unknown keys) — it aborts
    // naming the path, exactly like the sibling config editors. Only a genuinely
    // absent file is empty. Aborting here, before any file is staged, writes nothing.
    const existingCreds = readCredentialsFile(credsSource)
    if (existingCreds.status === "unparseable") {
      ports.stderr(`error: ${credsPath} is not valid JSON and will not be overwritten; fix or remove it, then re-run`)
      ports.stderr("Nothing was written.")
      return fail(ports, flags, {
        code: "credentials-unparseable",
        message: `${credsPath} is not valid JSON and will not be overwritten`,
        remedy: `fix or remove ${credsPath}, then re-run`,
      })
    }
    const contents = credentialsContents(
      existingCreds.status === "parsed" ? existingCreds.value : null,
      { apiKey: credential.apiKey, baseUrl },
    )
    // A byte-identical rewrite is not a write. Re-running with the same key used to
    // stage credentials.json every time, so the summary said `wrote …` and the undo
    // told the user to restore a previous version of a file whose content had not
    // changed. Every sibling editor already reports `unchanged` in this situation.
    if (contents !== credsSource) {
      const delta: string[] = []
      if (existingCredentials.apiKey && existingCredentials.apiKey !== credential.apiKey) {
        delta.push("the apiKey was replaced")
      } else if (!existingCredentials.apiKey) delta.push("the apiKey was added")
      if (existingCredentials.baseUrl && existingCredentials.baseUrl !== baseUrl) delta.push("baseUrl was changed")
      addFile(plan, {
        path: credsPath,
        contents,
        secret: true,
        created: credsSource === null,
        reason: `store the API key for every surface (${maskKey(credential.apiKey)})`,
        undo: undoLine(credsPath, credsSource === null, delta.join(", ") || undefined),
      })
    }
  }

  if (flags.login) {
    return finish(ports, flags, plan, {
      say,
      ui,
      baseUrl,
      credential,
      // The key already on disk is scanned too: --login is exactly the rotation
      // path, where the SUPERSEDED key is still live and still a secret to guard.
      existingApiKey: existingCredentials.apiKey,
      credsPath,
      interactive,
      verifyAgain: true,
      progress,
    })
  }

  // ---- options interview --------------------------------------------------
  const existingUser = safeJson(ports.readText(userPath))
  const answers = interactive
    ? await askOptions(ui as Ui, (existingUser ?? {}) as Record<string, unknown>)
    : {}

  const userMerge = mergeTelemConfig(ports.readText(userPath), answers, userPath)
  if (userMerge.status === "abort") {
    ports.stderr(`error: ${userMerge.reason}`)
    ports.stderr("Nothing was written.")
    return fail(ports, flags, {
      code: "config-unparseable",
      message: userMerge.reason,
      remedy: `fix or remove ${userPath}, then re-run`,
    })
  }
  if (userMerge.status === "write") {
    addFile(plan, {
      path: userPath,
      contents: userMerge.contents,
      secret: false,
      created: userMerge.created,
      reason: "user-level Telem options, read by every surface",
      undo: undoLine(userPath, userMerge.created),
    })
  }

  // The deprecated per-host files sit ABOVE the file we just wrote (spec
  // levels 3/4 vs 5), so an answer they also set will never take effect. Say so
  // rather than reporting a success the user will not observe.
  plan.warnings.push(
    ...legacyWarnings(
      findLegacyFiles(ports.readText, join, {
        home: ports.env.HOME ?? ports.env.USERPROFILE ?? "",
        projectRoot: project?.root,
      }),
      Object.keys(answers).filter((key) => answers[key] !== undefined),
    ),
  )

  const wantProject = flags.login
    ? false
    : interactive
      ? project !== null &&
        (await (ui as Ui).confirm({
          message: `Also write a project config in ${project.root}/.telem/telem.json? (${project.marker} is here — commit it and the team inherits it)`,
          initialValue: false,
        }))
      : flags.project
  if (wantProject) {
    const root = project?.root ?? ports.cwd
    const projectPath = join(root, ".telem", "telem.json")
    const projectMerge = mergeTelemConfig(ports.readText(projectPath), answers, projectPath)
    if (projectMerge.status === "abort") {
      ports.stderr(`error: ${projectMerge.reason}`)
      ports.stderr("Nothing was written.")
      return fail(ports, flags, {
        code: "project-config-unparseable",
        message: projectMerge.reason,
        remedy: `fix or remove ${projectPath}, then re-run`,
      })
    }
    if (projectMerge.status === "write") {
      addFile(plan, {
        path: projectPath,
        contents: projectMerge.contents,
        secret: false,
        created: projectMerge.created,
        reason: "project-level Telem options, shared with everyone who clones this repo",
        undo: undoLine(projectPath, projectMerge.created),
      })
    }
  }

  // ---- per-surface steps --------------------------------------------------
  // The effective key a surface can carry inline (the hosted Codex remote writes it
  // into config.toml's http_headers): a freshly provided one, else the one already
  // on disk. Undefined when neither exists (a --dry-run, or a keyless run).
  //
  // A key the SERVER REFUSED is threaded NOWHERE. `rejected` is the outcome of both
  // 401 paths — the key just pasted, and the one already in credentials.json — and
  // both end with a warning saying no API key was saved. The fallback above used to
  // resolve that same refused key straight back out of `existingCredentials` and write
  // it into Codex's Authorization header and Claude's pluginConfigs, so the run
  // configured every surface with a credential the deployment had already rejected,
  // two lines under a warning that said it had not. `unverified` is deliberately NOT
  // in this set: a network failure says nothing about the key, and that path keeps it.
  const surfaceApiKey =
    credential.status === "rejected" ? undefined : (credential.apiKey ?? existingCredentials.apiKey)
  await planSurfaces(ports, flags, ui, { plan, selected, tools, interactive, apiKey: surfaceApiKey })

  return finish(ports, flags, plan, {
    say,
    ui,
    baseUrl,
    credential,
    // The EFFECTIVE key actually threaded into surfaces and written inline (e.g. into
    // Codex's config.toml http_headers) — a freshly resolved one, else the kept key
    // already on disk. The secret-scan guard must cover this, not just credential.apiKey.
    effectiveApiKey: surfaceApiKey,
    // And the key that was on disk BEFORE this run. On a rotation it is superseded
    // but usually still live — a secret this run must not print either.
    existingApiKey: existingCredentials.apiKey,
    credsPath,
    interactive,
    verifyAgain: Boolean(credential.apiKey),
    progress,
  })
}

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

/**
 * The tool picker. Every surface in the catalog is listed, always — the old
 * "show the N surface(s) that aren't installed?" confirm made the user answer a
 * question about a list they had not seen yet, to hide entries they might well
 * want (a host they are about to install). Instead an entry whose host binary is
 * not on PATH keeps its place and carries a dimmed "(not detected on this
 * machine)" suffix, sorted after the detected ones inside its own group.
 *
 * The detected AGENT HOSTS are pre-checked: a trusting Enter should produce a
 * working install rather than an installer that configured nothing. A surface with
 * no probe of its own (the copy-paste MCP snippet) is neither tagged — there is no
 * host for it to be missing — nor pre-checked, since it only prints something.
 */
async function chooseSurfaces(ui: Ui, detected: string[], plan: Plan): Promise<SurfaceId[]> {
  const missingHost = (surface: Surface) => surface.probe !== null && !detected.includes(surface.id)
  const options: Record<string, { value: string; label: string; hint?: string }[]> = {}
  for (const { group, surfaces: allSurfaces } of surfaceGroups()) {
    const surfaces = allSurfaces.filter((s) => !s.hiddenFromPicker)
    if (surfaces.length === 0) continue // a group of only hidden surfaces vanishes whole
    const ordered = [...surfaces.filter((s) => !missingHost(s)), ...surfaces.filter(missingHost)]
    options[group] = ordered.map((surface) => ({
      value: surface.id,
      label: surface.label,
      hint: missingHost(surface) ? `${surface.hint} (not detected on this machine)` : surface.hint,
    }))
  }
  const chosen = await ui.groupMultiselect({
    message: "Which tools should Telem be installed into?",
    options,
    // Pre-checked: the hosts this machine actually has. Space still deselects any
    // of them, and the group header toggles a whole group.
    initialValues: SURFACES.filter((surface) => surface.probe !== null && detected.includes(surface.id)).map(
      (surface) => surface.id,
    ),
    required: false,
  })
  const selected = chosen.filter((id): id is SurfaceId => surfaceById(id) !== undefined)
  if (!selected.length) {
    // Deselecting everything is a legitimate answer (the key and the shared options
    // are still worth writing) — but it is indistinguishable from a mis-keyed
    // Space, and silence would let the run end with "Telem is set up" having
    // connected Telem to nothing.
    plan.notes.push(
      "No tool was selected — only your key and ~/.telem/telem.json were written. " +
        "Re-run and press Space on a tool to connect one.",
    )
  }
  return selected
}

type SurfaceContext = {
  plan: Plan
  selected: SurfaceId[]
  tools: Record<string, ToolInfo>
  interactive: boolean
  /**
   * The resolved credential a surface may write into its OWN store: the hosted Codex
   * remote's `http_headers` in config.toml, and Claude's `pluginConfigs` in settings.json.
   */
  apiKey?: string
}

async function planSurfaces(
  ports: Ports,
  flags: Flags,
  ui: Ui | null,
  context: SurfaceContext,
): Promise<void> {
  const { plan, selected, tools } = context
  const home = ports.env.HOME ?? ports.env.USERPROFILE ?? ""

  // Python bootstrap, once, for every Python surface that was chosen — the surfaces
  // that actually RUN a telem-sdk console script, which is what `needsPython` marks.
  // That is `claude-skill` alone now (`telem-install-skill`): Codex points at the
  // HOSTED remote over https, and so does the copy-paste snippet, so neither spawns
  // anything locally and neither must offer to install a Python package nothing will
  // execute. The `telem-mcp` binary is still what the check LOOKS for, because it is
  // the console script the SDK provides. The missing dependency is handled the SAME
  // way node is in install.sh (design): detect → ASK → install-or-guide. There
  // are two shapes:
  //   * a Python package manager exists (uv/pip) → offer to install telem-sdk;
  //   * none exists → offer to install `uv` ITSELF (astral, user-level, no sudo),
  //     and — because detection is a start-of-run snapshot and installs are deferred
  //     to one commit at the end (design idempotence) — the SDK-dependent surfaces
  //     finish on a RE-RUN, which the summary says plainly. We do NOT fake a within-run
  //     re-detect by chaining `uv tool install` onto a uv that is not yet on PATH.
  const needsPython = selected.some((id) => surfaceById(id)?.needsPython)
  if (needsPython && !tools[PYTHON_PROBE]?.path) {
    const installer = pythonInstaller(tools)
    if (installer) {
      const line = `${installer.join(" ")} "${PYTHON_PACKAGE}"`
      // Two branches, one consent question — "may I install what the Python surfaces
      // need?". Non-interactively that used to read `--yes` here and `--install-uv`
      // below, so `--install-uv` alone could not consent to THIS branch even though
      // its help text said it covered "the Python surfaces". `--install-uv` now
      // consents to both. `--yes` deliberately still does NOT reach the uv branch:
      // that one is a `curl … | sh` from the network, which is not something a bare
      // "take the defaults" should trigger in CI.
      //
      // AT A TERMINAL THE QUESTION IS ALWAYS ASKED. The flags used to short-circuit it,
      // so `--install-uv` silently consented to an install in the same run that warned
      // the user the flag had been ignored because the wizard asks. Same shape as the
      // uv branch below: `ui ? ask: flags`.
      const consented = ui
        ? await ui.confirm({ message: `${PYTHON_PROBE} is not on PATH. Run \`${line}\`?`, initialValue: true })
        : flags.yes || flags.installUv
      if (consented) {
        plan.commands.push({
          surface: "python",
          argv: [...installer, PYTHON_PACKAGE],
          reason: `install the Python SDK, which provides ${PYTHON_PROBE}`,
          optional: false,
        })
      } else {
        plan.notes.push(
          `The Python surfaces need the Telem SDK. Install it first:\n\n    ${line}\n\nthen re-run this installer.`,
        )
        plan.warnings.push(`${PYTHON_PROBE} is not installed; the Python surfaces will not start until it is`)
      }
    } else {
      // No Python package manager at all — offer to install uv (design).
      const uvCommand = uvInstallCommand(ports.platform)
      const consented = ui
        ? await ui.confirm({
            message: "No Python package manager (uv/pip) was found. Install uv for you? (user-level, no sudo)",
            initialValue: true,
          })
        : flags.installUv
      if (consented) {
        plan.commands.push({
          surface: "python",
          argv: uvCommand,
          reason: "install uv (user-level, no sudo) to provide the Telem Python SDK",
          optional: false,
        })
        plan.notes.push(
          `Installing uv now. The Python surfaces (the Claude Agent Skill) need ${PYTHON_PACKAGE}, which uv then installs — ` +
            `re-run \`npm create @telemai\` after this to finish them (this run installs uv; the next detects it).`,
        )
        plan.warnings.push(
          `${PYTHON_PROBE} is not installed yet; the Python surfaces finish on a re-run, once uv has installed ${PYTHON_PACKAGE}`,
        )
      } else {
        plan.notes.push(
          `The Python surfaces need a Python package manager. Install uv (user-level, no sudo):\n\n` +
            `    ${uvCommand.join(" ")}\n\nthen \`uv tool install "${PYTHON_PACKAGE}"\` and re-run this installer.`,
        )
        plan.warnings.push(`no Python package manager found; the Python surfaces will not start until ${PYTHON_PROBE} is installed`)
      }
    }
  }

  for (const id of selected) {
    // No `default:` arm. The switch covers every SurfaceId, so the arm that used to
    // sit here — reporting `skipped`, "no planner for X" — could never run; its only
    // effect was a status in the vocabulary that no user ever saw. Exhaustiveness is
    // now the compiler's job: adding a SurfaceId without a planner fails typecheck.
    switch (id) {
      case "opencode":
        planOpencode(ports, plan, home)
        break
      case "claude-code":
        planClaudeCode(ports, plan, tools, home, context.apiKey)
        break
      case "codex":
        await planCodex(ports, flags, ui, plan, home, tools, context.apiKey)
        break
      case "pi":
        planPi(plan, tools)
        break
      case "openclaw":
        planOpenclaw(ports, plan, tools)
        break
      case "claude-skill":
        planClaudeSkill(plan, tools)
        break
      case "mcp-json":
        // The HOSTED server, not a local `telem-mcp` process. Every other surface
        // moved to https://mcp.telem.ai/mcp; printing the stdio snippet here left the
        // one copy-paste surface as the only route that needed a Python install and
        // a local binary to work at all. The key is NOT interpolated — this snippet
        // is printed to a terminal and pasted into a file the installer does not own,
        // and the invariant is that the key is never printed.
        plan.notes.push(
          surfaceNote(
            id,
            `paste this into the client's MCP config, with your own key in place of ` +
              `tlm_… (it is in ~/.telem/credentials.json):\n\n` +
              `${JSON.stringify(
                {
                  mcpServers: {
                    telem: { url: CODEX_URL, headers: { Authorization: "Bearer tlm_…" } },
                  },
                },
                null,
                2,
              )}`,
          ),
        )
        setOutcome(plan, id, "manual", "hosted snippet printed below")
        break
    }
  }
}

/**
 * Every note is prefixed with its surface's CATALOG LABEL, verbatim — the same words
 * the picker showed when the user chose it. The prefixes used to be hand-written per
 * call site and drifted (`Claude Code:` for a surface labelled "Claude Code (plugin)",
 * no prefix at all on the mcp-json snippet), so a note could not be traced back to the
 * thing it was about.
 */
function surfaceNote(id: SurfaceId, body: string): string {
  return `${surfaceById(id)?.label ?? id}: ${body}`
}

/**
 * ONE template for "the host is not here, so here is what to run once it is".
 *
 * There were two dialects — "run these once `X` is on PATH" for Claude/pi/openclaw and
 * "`X` is not on PATH, so the telem plugin was NOT installed … or register it by hand"
 * for Codex — describing the identical state in different words and different orders.
 */
function notOnPathNote(id: SurfaceId, binary: string, commands: string[][], epilogue?: string): string {
  const list = commands.map((argv) => `    ${argv.join(" ")}`).join("\n")
  const body =
    `\`${binary}\` is not on PATH, so this was not installed. ` +
    `Run ${commands.length === 1 ? "this" : "these"} once it is:\n\n${list}` +
    (epilogue ? `\n\n${epilogue}` : "")
  return surfaceNote(id, body)
}

function opencodeConfigDir(ports: Ports, home: string): string {
  const xdg = (ports.env.XDG_CONFIG_HOME ?? "").trim()
  return xdg ? join(xdg, "opencode") : join(home, ".config", "opencode")
}

function planOpencode(ports: Ports, plan: Plan, home: string): void {
  const path = pickOpencodeConfigPath(opencodeConfigDir(ports, home), ports.exists, join)
  const source = ports.readText(path)
  const edit = planOpencodePlugin(source, OPENCODE_PLUGIN_PACKAGE, path)
  if (edit.status === "abort") {
    plan.notes.push(surfaceNote("opencode", edit.reason))
    setOutcome(plan, "opencode", "failed", edit.reason)
    return
  }
  if (edit.status === "unchanged") {
    setOutcome(plan, "opencode", "unchanged", edit.reason)
    return
  }
  addFile(plan, {
    path,
    contents: edit.contents,
    secret: false,
    created: edit.created,
    reason: edit.reason,
    undo: edit.created ? undoLine(path, true) : `remove "${OPENCODE_PLUGIN_PACKAGE}" from the plugin array in ${path}`,
  })
  setOutcome(plan, "opencode", "installed", edit.reason)
}

function resolveClaudePluginDir(ports: Ports): string | null {
  const fromEnv = (ports.env.TELEM_CLAUDE_PLUGIN_DIR ?? "").trim()
  if (fromEnv) return fromEnv
  const fromPorts = (ports.claudePluginDir ?? "").trim()
  return fromPorts || null
}

function planClaudeCode(
  ports: Ports,
  plan: Plan,
  tools: Record<string, ToolInfo>,
  home: string,
  apiKey: string | undefined,
): void {
  const claude = tools.claude?.path
  const pluginDir = resolveClaudePluginDir(ports)
  const marketplaceAdd = ["claude", "plugin", "marketplace", "add", pluginDir ?? "<claude-plugin-telem dir>"]
  const install = ["claude", "plugin", "install", CLAUDE_PLUGIN_REF]

  // A plugin with no key cannot authenticate, and that is just as true on the two
  // guided paths below — which is where the warning used to be unreachable, because it
  // sat after both of their returns. The user was told to run the install commands by
  // hand and never told the key was missing from the config those commands read.
  if (!apiKey) {
    plan.warnings.push(
      "the telem Claude plugin has no key yet; add one with `npx @telemai/create --login` (it prompts) and re-run",
    )
  }

  if (!claude) {
    plan.notes.push(notOnPathNote("claude-code", "claude", [marketplaceAdd, install]))
    setOutcome(plan, "claude-code", "manual", "claude is not on PATH; commands printed below")
    return
  }
  if (!pluginDir || !ports.exists(pluginDir)) {
    // The plugin installs from a local checkout of the sibling plugin (the
    // public marketplace listing is a follow-up, spec Q3). Without that dir we
    // cannot register the marketplace, so guide rather than plan a broken command.
    plan.notes.push(
      surfaceNote(
        "claude-code",
        "the bundled telem plugin source was not found. " +
          `Point TELEM_CLAUDE_PLUGIN_DIR at it, then run:\n\n    ${marketplaceAdd.join(" ")}\n    ${install.join(" ")}`,
      ),
    )
    setOutcome(plan, "claude-code", "manual", "claude-plugin-telem source not found; commands printed below")
    return
  }

  // Capture TELEM_API_KEY into the plugin's userConfig — a 0600 secret file inside
  // the Claude config dir, never on argv. Staged like every other write, so
  // a cancelled run leaves it unwritten. Only staged when a key is configured; a
  // keyless run still installs the plugin (it just cannot authenticate yet).
  if (apiKey) {
    const configPath = claudePluginConfigPath(claudeConfigDir(ports.env, home))
    const edit = planClaudePluginConfig(ports.readText(configPath), apiKey, configPath)
    if (edit.status === "unparseable") {
      plan.notes.push(surfaceNote("claude-code", edit.reason))
      setOutcome(plan, "claude-code", "failed", edit.reason)
      return
    }
    if (edit.status === "write") {
      addFile(plan, {
        path: configPath,
        contents: edit.contents,
        secret: true,
        created: edit.created,
        reason: `store TELEM_API_KEY in the ${CLAUDE_PLUGIN_REF} plugin's userConfig`,
        undo: edit.created
          ? undoLine(configPath, true)
          : `remove the "${CLAUDE_PLUGIN_REF}" entry from ${configPath}`,
      })
    }
  }

  // Read-only probe: `claude plugin marketplace add`/`install` on an already
  // registered plugin errors, so an already-installed plugin takes the UPGRADE path
  // rather than the install path. The userConfig write above still runs (idempotent
  // bytes).
  //
  // Upgrading is not optional and skipping it was a real break: Claude Code COPIES a
  // directory-sourced plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/
  // <version>/`, so a machine that installed once keeps running the hooks it copied
  // then — forever — while the npm package underneath it moves on. Every existing
  // install silently stayed on the old hooks through a re-run of the one-liner.
  // `marketplace update` re-reads this package's directory, and `plugin update`
  // re-copies when the plugin's own version moved, which is why that version has to
  // be bumped whenever the hooks change (probe: `plugin update` on an unbumped
  // plugin answers "already at the latest version" and copies nothing).
  const listed = ports.exec([claude, "plugin", "list"])
  if ((listed.status === 0 ? listed.stdout : "").includes("telem")) {
    plan.commands.push({
      surface: "claude-code",
      argv: ["claude", "plugin", "marketplace", "update", CLAUDE_MARKETPLACE],
      reason: "re-read the telem marketplace from this package",
      optional: true,
    })
    plan.commands.push({
      surface: "claude-code",
      argv: ["claude", "plugin", "update", CLAUDE_PLUGIN_REF],
      reason: "copy this package's hooks over the previously installed ones",
      optional: true,
    })
    setOutcome(plan, "claude-code", "installed", "the telem plugin was already there; updated it in place")
    return
  }
  plan.commands.push({
    surface: "claude-code",
    argv: marketplaceAdd,
    reason: "register the local telem plugin marketplace",
    optional: false,
  })
  plan.commands.push({
    surface: "claude-code",
    argv: install,
    reason: "install the telem Claude Code plugin (hosted MCP + lineage hook)",
    optional: false,
  })
  setOutcome(plan, "claude-code", "installed", "claude plugin marketplace add + plugin install telem")
}

function resolveCodexPluginDir(ports: Ports): string | null {
  const fromEnv = (ports.env.TELEM_CODEX_PLUGIN_DIR ?? "").trim()
  if (fromEnv) return fromEnv
  const fromPorts = (ports.codexPluginDir ?? "").trim()
  return fromPorts || null
}

async function planCodex(
  ports: Ports,
  flags: Flags,
  ui: Ui | null,
  plan: Plan,
  home: string,
  tools: Record<string, ToolInfo>,
  apiKey: string | undefined,
): Promise<void> {
  const codexHome = codexHomeDir(ports.env, home)
  const configPath = join(codexHome, "config.toml")
  const source = ports.readText(configPath)
  // Lead with the OUTCOME (Codex searching through Telem), name the TOML edit as the
  // parenthetical, and default to Yes: an installer whose enter-presser finishes with
  // Codex still preferring its own built-in search has installed the product unused.
  // The question is skipped entirely when config.toml already reads
  // web_search = "disabled" — a consent prompt whose Yes changes nothing is noise.
  const alreadyDisabled = codexWebSearchDisabled(source)
  const disableWebSearch = alreadyDisabled
    ? true
    : ui
      ? await ui.confirm({
          message:
            'Send Codex\'s web searches through Telem? (sets web_search = "disabled" in ~/.codex/config.toml)',
          initialValue: true,
        })
      : flags.codexDisableWebSearch
  // Reasoning capture is ADDITIVE and ON by default (opt out with --no-codex-reasoning);
  // it never prompts, unlike the consent-gated web_search flip. Opting out skips the
  // whole plugin — hook AND skill — as well as model_reasoning_summary.
  const captureReasoning = flags.codexReasoning

  // Pointing an existing stdio (`command = …`) telem server at the hosted remote
  // REWRITES its table (searches move local → hosted), so it is consent-gated like
  // the web_search flip. It is only offered when there IS a stdio telem table to
  // migrate; a fresh add and an already-hosted table never ask.
  const form = classifyCodexTelemTable(source)
  // rather than leave a half-migrated install behind.
  const pluginPlan = captureReasoning
    ? await planCodexPlugin(ports, flags, ui, tools, codexHome)
    : { status: "skipped" as const }
  if (pluginPlan.status === "abort") {
    plan.notes.push(surfaceNote("codex", pluginPlan.reason))
    setOutcome(plan, "codex", "failed", pluginPlan.reason)
    return
  }
  const hookTrust: readonly CodexHookTrustEntry[] = pluginPlan.status === "ok" ? pluginPlan.hookTrust : []

  const edit = planCodexConfig(
    source,
    { disableWebSearch, captureReasoning, apiKey, hookTrust },
    configPath,
  )
  if (edit.status === "abort") {
    plan.notes.push(surfaceNote("codex", edit.reason))
    setOutcome(plan, "codex", "failed", edit.reason)
    return
  }

  // The config.toml changes and the plugin's changes are kept apart, because the
  // summary row names ~/.codex/config.toml ONCE and hangs its edits off that, instead
  // of repeating a 40-character path inside every clause.
  const configChanges: string[] = []
  const pluginChanges: string[] = []
  const changes: string[] = []
  if (edit.status === "write") {
    addFile(plan, {
      path: configPath,
      contents: edit.contents,
      // The hosted table carries the key in http_headers, so config.toml is now a
      // 0600 secret write whenever a key was written into it; keyless (no header) it
      // holds nothing sensitive and stays a normal config file.
      secret: edit.keylessHostedTable ? false : Boolean(apiKey),
      created: edit.created,
      reason: edit.changes.join("; "),
      undo: codexUndoLine(edit, configPath),
    })
    configChanges.push(...edit.changes)
    changes.push(...edit.changes)
    // A hosted table went in without the auth header: say so, naming the value to add.
    // Either no key was available, or one was but did not look like a valid tlm_ key
    // (which we refuse to interpolate into the inline header). The note carries no
    // secret — the key is never printed.
    if (edit.keylessHostedTable) {
      plan.notes.push(
        surfaceNote(
          "codex",
          edit.keyMalformed
            ? `[${CODEX_TABLE}] points at the hosted ${CODEX_URL}, but the available API key did not look like a valid tlm_ key ` +
                "(a real key is only letters, digits, `_` and `-`), so no auth header was written. " +
                `Add \`http_headers = { Authorization = "Bearer <your tlm_ key>" }\` to that table in ${configPath} by hand.`
            : `[${CODEX_TABLE}] points at the hosted ${CODEX_URL} but no API key was available to write. ` +
                `Add \`http_headers = { Authorization = "Bearer <your tlm_ key>" }\` to that table in ${configPath}.`,
        ),
      )
    }
  }

  if (pluginPlan.status === "ok") {
    for (const write of pluginPlan.writes) addFile(plan, write)
    plan.removals.push(...pluginPlan.removals)
    plan.commands.push(...pluginPlan.commands)
    plan.notes.push(...pluginPlan.notes)
    pluginChanges.push(...pluginPlan.changes)
    changes.push(...pluginPlan.changes)
    // A plugin hook Codex has not been told to trust is SILENTLY SKIPPED. Say so
    // whenever the pre-grant did not land — that silence is the whole hazard. The
    // test is "is the right hash in the file now", NOT "did this run write it": a
    // re-run, or a plugin bump that did not touch hooks.json, leaves the trust
    // byte-identical and must not send the user to the /plugin UI for nothing.
    if (!edit.hookTrustSatisfied) {
      plan.notes.push(
        surfaceNote(
          "codex",
          "the telem reasoning hook could not be pre-trusted, and Codex skips an untrusted plugin hook SILENTLY. " +
            "Open Codex, run `/plugin`, and trust the telem hook once to enable reasoning capture.",
        ),
      )
    }
  } else if (pluginPlan.status === "declined" || pluginPlan.status === "manual") {
    plan.notes.push(...pluginPlan.notes)
  }


  if (pluginPlan.status === "manual") {
    // config.toml may well have been staged — the MCP server half is independent — but
    // the plugin half needs the user's hands, and a surface that reported `installed`
    // would be claiming a reasoning route that does not exist. `manual` is the word the
    // Claude surface uses for exactly these two conditions.
    const done = codexDetail(configPath, configChanges, pluginChanges)
    setOutcome(plan, "codex", "manual", done ? `${done}; ${pluginPlan.detail}` : pluginPlan.detail)
    return
  }

  if (pluginPlan.status === "declined") {
    // Half done, and it has to say so: the MCP server half may well have landed, but
    // the plugin — the reasoning hook AND the telem skill — was deliberately not
    // installed. `installed` claims a capture route that does not exist; `unchanged`
    // hides that a choice was made.
    setOutcome(
      plan,
      "codex",
      "partial",
      `${codexDetail(configPath, configChanges, pluginChanges) || `${configPath} already has [${CODEX_TABLE}]`}; ` +
        "the telem plugin was NOT installed (you kept the older hand-written reasoning hook)",
    )
    return
  }

  if (!changes.length) {
    // Nothing to write. The detail names only what this run actually VERIFIED: the
    // plugin half is claimed only on the path that checked it, never on a run that
    // skipped it (--no-codex-reasoning) — which used to print "already has
    // [mcp_servers.telem] and the telem plugin" directly above a note saying the
    // plugin was not installed.
    setOutcome(
      plan,
      "codex",
      "unchanged",
      `${configPath} already has [${CODEX_TABLE}]${pluginPlan.status === "ok" ? " and the telem plugin" : ""}`,
    )
    return
  }
  setOutcome(plan, "codex", "installed", codexDetail(configPath, configChanges, pluginChanges))
}

/**
 * The Codex summary row: the config file named once, its edits hanging off it, then
 * everything that happened outside that file. The row used to be a single ~430-
 * character line carrying the same absolute path three times.
 */
function codexDetail(configPath: string, configChanges: string[], pluginChanges: string[]): string {
  const parts: string[] = []
  if (configChanges.length) parts.push(`${configPath}: ${configChanges.join(", ")}`)
  parts.push(...pluginChanges)
  return parts.join("; ")
}

/**
 * How to put `~/.codex/config.toml` back.
 *
 * The last branch is the one that matters. "remove the [mcp_servers.telem] table"
 * is correct advice ONLY for the run that added that table. As a fall-through it
 * told a user whose only change was `model_reasoning_summary = "detailed"` to
 * delete the Telem server they had configured themselves and this run explicitly
 * declined to touch — the single printed instruction in this installer that
 * destroys working user config. So the fall-through is derived from
 * `edit.changes`: it names what this run actually did, one undo step per change,
 * and says in as many words that the existing table was left alone.
 */
function codexUndoLine(
  edit: { created: boolean; addedTable: boolean; reconciled: boolean; changes: string[] },
  configPath: string,
): string {
  if (edit.created) return undoLine(configPath, true)
  if (edit.reconciled) {
    return `restore your previous http_headers line in [${CODEX_TABLE}] in ${configPath} (its Telem auth header was brought in line with your current key)`
  }
  if (edit.addedTable) return `remove the [${CODEX_TABLE}] table from ${configPath}`
  const steps: string[] = []
  for (const step of edit.changes.map(codexChangeUndo)) {
    if (step && !steps.includes(step)) steps.push(step)
  }
  const detail = steps.length ? steps.join("; ") : "undo the edits listed above"
  return `in ${configPath}: ${detail} — your existing [${CODEX_TABLE}] table was NOT modified by this run, so leave it alone`
}

/** One `changes` entry, turned back into the step that reverses it. */
function codexChangeUndo(change: string): string | null {
  const restored = /^set (\S+) = (\S+) \(was (.*)\)$/.exec(change)
  if (restored) {
    // "(was empty)" means the key had no value we could read back, so the honest
    // reverse is removing the line rather than restoring a value we never had.
    return restored[3] === "empty" || !restored[3]
      ? `remove the ${restored[1]} line`
      : `set ${restored[1]} back to ${restored[3]}`
  }
  const set = /^set (\S+) = (.+)$/.exec(change)
  if (set) return `remove the ${set[1]} = ${set[2]} line`
  if (/^(re-)?trust the telem Codex hook\b/.test(change)) {
    return `remove the [${CODEX_HOOK_STATE_PATH.join(".")}] entry for the telem hook`
  }
  return null
}

type CodexPluginPlan =
  | { status: "skipped" }
  | { status: "abort"; reason: string }
  | { status: "declined"; notes: string[] }
  /**
   * The plugin CANNOT be installed by this run (no `codex` on PATH, or no plugin
   * source to register). Nothing plugin-related is staged — no removals, no trust,
   * no commands — and the surface reports `manual`, the same word the Claude surface
   * uses for the same two conditions.
   */
  | { status: "manual"; detail: string; notes: string[] }
  | {
      status: "ok"
      hookTrust: CodexHookTrustEntry[]
      commands: PlannedCommand[]
      writes: Array<Omit<FileWrite, "mode"> & { mode?: number }>
      removals: FileRemoval[]
      notes: string[]
      changes: string[]
    }

/**
 * The Codex PLUGIN half, planned but never staged here (the caller stages it, so an
 * abort anywhere in the surface leaves nothing behind).
 *
 * It mirrors planClaudeCode — two env-free, key-free commands registering a local
 * marketplace and installing `telem@telem` — and adds two things Claude does not need:
 *
 *   * the migration off the OLD hand-written hook route, which MUST happen or the same
 *     PreToolUse hook fires twice per search; and
 *   * the pre-granted hook trust, because a Codex plugin hook is inert and silent
 *     until trusted and there is no CLI to grant it.
 *
 * The two are one transaction. The removal is only ever justified by the install that
 * replaces it, so a run that CANNOT install the plugin must not remove anything — see
 * the first branch below.
 */
async function planCodexPlugin(
  ports: Ports,
  flags: Flags,
  ui: Ui | null,
  tools: Record<string, ToolInfo>,
  codexHome: string,
): Promise<CodexPluginPlan> {
  const codex = tools.codex?.path
  const pluginDir = resolveCodexPluginDir(ports)
  const marketplaceAdd = ["codex", "plugin", "marketplace", "add", pluginDir ?? "<codex-plugin-telem dir>"]
  const install = ["codex", "plugin", "add", CODEX_PLUGIN_REF]
  const byHand = `\n\n    ${marketplaceAdd.join(" ")}\n    ${install.join(" ")}`

  const hooksJsonPath = join(codexHome, CODEX_HOOKS_JSON)
  const hooksDir = join(codexHome, CODEX_HOOKS_DIRNAME)
  const legacyFiles = [join(hooksDir, CODEX_LAUNCHER_FILENAME), join(hooksDir, CODEX_HOOK_FILENAME)]

  // ── can this run install the plugin at all? ─────────────────────────────────────
  // Asked FIRST, before the legacy route is even inspected, because everything below
  // is downstream of the answer. The old hand-written hook is what captures reasoning
  // TODAY; removing it is justified only by the plugin that replaces it, and the
  // consent prompt only makes sense as "swap this for that". With no `codex` to run
  // the install, or no plugin source to install FROM, there is no "that" — so this is
  // an IMPLICIT DECLINE: no prompt, no removals, the hooks.json route left byte-for-
  // byte intact, no trust pre-granted for a plugin that is not there, and the surface
  // reported `manual` rather than `installed`. The alternative is what this branch
  // used to do: delete the working route, install nothing, report success, and leave
  // reasoning capture silently dead.
  if (!codex || !pluginDir || !ports.exists(pluginDir)) {
    const rerunInstead =
      "(or just re-run `npm create @telemai` once it is there — that run also pre-grants the hook's trust, " +
      "which the two commands above do not.)"
    const blocked = !codex
      ? {
          detail: "codex is not on PATH; the telem plugin commands are printed below",
          note: notOnPathNote("codex", "codex", [marketplaceAdd, install], rerunInstead),
        }
      : {
          detail: "codex-plugin-telem source not found; the telem plugin commands are printed below",
          note: surfaceNote(
            "codex",
            "the bundled telem plugin source was not found, so this was not installed. " +
              `Point TELEM_CODEX_PLUGIN_DIR at it, then run:${byHand}\n\n${rerunInstead}`,
          ),
        }
    const notes = [blocked.note]
    // Say so explicitly when the old route is still installed: it was NOT touched, it
    // is still what captures reasoning, and the user needs to know both halves.
    const legacyPresent =
      legacyFiles.some((path) => ports.exists(path)) ||
      planCodexLegacyHooksRemoval(ports.readText(hooksJsonPath), legacyFiles, hooksJsonPath).status !== "absent"
    if (legacyPresent) {
      notes.push(
        surfaceNote(
          "codex",
          `your older hand-written reasoning hook in ${hooksJsonPath} was left exactly as it is — it is still ` +
            "what captures reasoning, and this run will not remove it until the plugin that replaces it is installed.",
        ),
      )
    }
    return { status: "manual", detail: blocked.detail, notes }
  }

  // ── the old route, if it is still there ─────────────────────────────────────────
  const legacyEdit = planCodexLegacyHooksRemoval(ports.readText(hooksJsonPath), legacyFiles, hooksJsonPath)
  if (legacyEdit.status === "unparseable") return { status: "abort", reason: legacyEdit.reason }
  const presentLegacyFiles = legacyFiles.filter((path) => ports.exists(path))
  const hasLegacy = legacyEdit.status !== "absent" || presentLegacyFiles.length > 0

  if (hasLegacy) {
    const consented = ui
      ? await ui.confirm({
          // No is not "keep both" — it is "install no plugin at all", hook AND skill,
          // because the two hooks would fire on every search. Saying that after the
          // answer (which is where the note used to say it) is saying it too late.
          message:
            "An older Telem reasoning hook is installed directly in your Codex home. Replace it with the telem plugin? " +
            "(No skips the whole plugin — its reasoning hook AND its telem skill — because both hooks would fire on every search)",
          initialValue: true,
        })
      : flags.codexMigrateHooks
    if (!consented) {
      return {
        status: "declined",
        notes: [
          surfaceNote(
            "codex",
            `kept the older reasoning hook in ${hooksJsonPath}, so the telem plugin was NOT installed — ` +
              "the two would both fire on every search. Re-run with --codex-migrate-hooks to switch to the plugin.",
          ),
        ],
      }
    }
  }

  const removals: FileRemoval[] = []
  const writes: Array<Omit<FileWrite, "mode"> & { mode?: number }> = []
  const changes: string[] = []
  const notes: string[] = []
  const undoLegacy =
    "re-install the older hand-written Codex hook with an earlier @telemai/create, or keep the plugin (it carries the same hook)"
  if (legacyEdit.status === "rewrite") {
    writes.push({
      path: hooksJsonPath,
      contents: legacyEdit.contents,
      secret: false,
      created: false,
      reason: "remove the superseded telem PreToolUse entry (the plugin carries this hook now)",
      undo: undoLegacy,
    })
    changes.push(`remove the superseded telem PreToolUse entry from ${hooksJsonPath}`)
  } else if (legacyEdit.status === "remove-file") {
    removals.push({
      path: hooksJsonPath,
      reason: "the superseded telem PreToolUse entry was this file's only content",
      undo: undoLegacy,
    })
    changes.push(`remove ${hooksJsonPath} (the superseded telem PreToolUse entry was all it held)`)
  }
  for (const path of presentLegacyFiles) {
    removals.push({ path, reason: "the superseded hand-written telem reasoning hook", undo: undoLegacy })
    changes.push(`remove ${path}`)
  }

  // ── trust, derived from the plugin package's own hooks.json ─────────────────────
  // The hash is machine-independent — nothing about this machine or CODEX_HOME enters
  // it — so it is derived from the package alone. It is only ever pre-granted on the
  // path that also installs the plugin: trust for a plugin that is not there is an
  // orphan table AND a `hookTrustSatisfied` that claims a hook will run when none exists.
  const hooksSource = ports.readText(join(pluginDir, ...CODEX_PLUGIN_HOOKS_REL.split("/")))
  const hookTrust = codexHookTrustEntries(hooksSource, { platform: ports.platform }) ?? []

  // Read-only probe. Unlike Claude Code, re-installing IS Codex's documented update
  // path (both commands are idempotent and exit 0), so the version is compared rather
  // than mere presence — otherwise a plugin bump would never reach an existing install.
  const listed = ports.exec([codex, "plugin", "list"])
  const installedVersion = installedCodexPluginVersion(listed.status === 0 ? listed.stdout : "")
  const packagedVersion = codexPluginVersion(ports.readText(join(pluginDir, ".codex-plugin", "plugin.json")))
  const upToDate = installedVersion !== null && packagedVersion !== null && installedVersion === packagedVersion
  if (upToDate) {
    return { status: "ok", hookTrust, commands: [], writes, removals, notes, changes }
  }
  const commands: PlannedCommand[] = [
    {
      surface: "codex",
      argv: marketplaceAdd,
      reason: "register the local telem Codex plugin marketplace",
      optional: false,
    },
    {
      surface: "codex",
      argv: install,
      reason: "install the telem Codex plugin (reasoning hook + telem skill)",
      optional: false,
    },
  ]
  changes.push(`install the ${CODEX_PLUGIN_REF} Codex plugin`)
  return { status: "ok", hookTrust, commands, writes, removals, notes, changes }
}

function planPi(plan: Plan, tools: Record<string, ToolInfo>): void {
  // `pi install npm:<pkg>` is pi's own package command (its README rejects the
  // bare name as a local path); a global npm install would not register anything.
  const argv = ["pi", "install", `npm:${PI_PACKAGE}`]
  if (!tools.pi?.path) {
    plan.notes.push(notOnPathNote("pi", "pi", [argv]))
    setOutcome(plan, "pi", "manual", "pi is not on PATH; command printed below")
    return
  }
  plan.commands.push({
    surface: "pi",
    argv,
    reason: `install ${PI_PACKAGE} as a pi package`,
    optional: false,
  })
  setOutcome(plan, "pi", "installed", argv.join(" "))
}

function planOpenclaw(ports: Ports, plan: Plan, tools: Record<string, ToolInfo>): void {
  // Install the PUBLISHED plugin the way an end user does: OpenClaw's own package
  // installer copies the compiled dist into ~/.openclaw and resolves its deps.
  // telem-openclaw-setup (npm ci + `--link`) is a SOURCE-CHECKOUT dev tool (its
  // SETUP.md says so): the published tarball has no lockfile for `npm ci`, and
  // `--link` would point at the throwaway npx dir — so the wizard installs like pi
  // does (`pi install npm:…`), never by delegating to that dev helper.
  const installArgv = ["plugins", "install", `npm:${OPENCLAW_PACKAGE}`, "--force"]
  const openclaw = tools.openclaw?.path
  if (!openclaw) {
    plan.notes.push(
      notOnPathNote("openclaw", "openclaw", [
        ["openclaw", ...installArgv],
        ["openclaw", "config", "set", "tools.alsoAllow", `'["telem_search","telem_fetch"]'`, "--strict-json"],
      ]),
    )
    setOutcome(plan, "openclaw", "manual", "openclaw is not on PATH; commands printed below")
    return
  }
  // Host version floor (absorbed from MIN_OPENCLAW_VERSION): an openclaw below
  // the floor cannot load the plugin, so refuse rather than "install" into a host
  // where the tools would silently never appear. Detection probes the version in
  // interactive mode; in flags mode we probe here — non-fatal, short timeout — the
  // same way always ran `openclaw --version`. An unreadable version is NOT a block.
  const versionText = tools.openclaw?.version ?? probeVersion(ports, openclaw)
  const floor = openclawBelowFloor(versionText)
  if (floor.below) {
    const message = translateInstallError("openclaw-version", floor.found ?? "")!
    plan.notes.push(surfaceNote("openclaw", message))
    setOutcome(plan, "openclaw", "failed", message)
    return
  }
  plan.commands.push({
    surface: "openclaw",
    argv: [openclaw, ...installArgv],
    reason: `install ${OPENCLAW_PACKAGE} as an OpenClaw plugin`,
    optional: false,
  })
  // OpenClaw's tool policy is separate from install and `config set` REPLACES the
  // array, so merge the two telem tools into the existing allowlist rather than
  // clobbering the user's other entries.
  const allow = mergeOpenclawAllow(ports, openclaw, ["telem_search", "telem_fetch"])
  plan.commands.push({
    surface: "openclaw",
    argv: [openclaw, "config", "set", "tools.alsoAllow", JSON.stringify(allow), "--strict-json"],
    reason: "allow telem_search and telem_fetch in the tool policy",
    optional: false,
  })
  setOutcome(plan, "openclaw", "installed", "openclaw plugins install + tools.alsoAllow")
}

/**
 * The plugin's tools have to be allowed by OpenClaw's tool policy, and `config set`
 * replaces the whole array — so read the current `tools.alsoAllow`, add the telem
 * tools it does not already list, and hand back the union. Unreadable or absent
 * config starts from empty; this never throws.
 */
function mergeOpenclawAllow(ports: Ports, openclaw: string, add: string[]): string[] {
  const merged: string[] = []
  try {
    const result = ports.exec([openclaw, "config", "get", "tools.alsoAllow"])
    const parsed = JSON.parse((result.stdout ?? "").trim() || "[]")
    if (Array.isArray(parsed)) {
      for (const entry of parsed) if (typeof entry === "string" && !merged.includes(entry)) merged.push(entry)
    }
  } catch {
    // No allowlist yet (fresh host) or unreadable output — start from empty.
  }
  for (const tool of add) if (!merged.includes(tool)) merged.push(tool)
  return merged
}

/** First line of a host's `--version`, or undefined if it will not answer. Never throws. */
function probeVersion(ports: Ports, path: string): string | undefined {
  try {
    const result = ports.exec([path, "--version"])
    const text = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0]?.trim()
    return text || undefined
  } catch {
    return undefined
  }
}

/**
 * Which `translateInstallError` context, if any, a failed command's raw output should
 * be read through. The Python surface's installs (uv/pip) get the python-floor
 * translation; the surfaces that fetch a @telemai package through npm/npx/pi
 * (pi, openclaw) get the E404 translation. Everything else keeps the
 * generic "<cmd> exited N" detail, so an unrelated failure is never mislabeled.
 */
function errorContextFor(command: PlannedCommand): InstallErrorContext | null {
  if (command.surface === "python") return "python"
  const argv = command.argv
  if (
    argv.some((part) => part.includes("@telemai/")) ||
    argv[0] === "npm" ||
    argv[0] === "npx" ||
    argv[0] === "pi"
  ) {
    return "npm"
  }
  return null
}

function planClaudeSkill(plan: Plan, tools: Record<string, ToolInfo>): void {
  const installer = tools["telem-install-skill"]?.path
  if (!installer) {
    // Built from what is actually on THIS machine, the way the Python bootstrap above
    // does it. The line used to be a hard-coded `pip install`, printed unchanged on a
    // uv-only box where that command does not exist.
    const manager = pythonInstaller(tools)
    const install = manager ? manager.join(" ") : "uv tool install"
    plan.notes.push(
      surfaceNote(
        "claude-skill",
        `install the SDK first, then run the installer:\n\n    ${install} "${PYTHON_PACKAGE}"\n    telem-install-skill`,
      ),
    )
    setOutcome(plan, "claude-skill", "manual", "telem-install-skill is not on PATH; commands printed below")
    return
  }
  plan.commands.push({
    surface: "claude-skill",
    argv: [installer],
    reason: "copy the telem-search skill into ~/.claude/skills",
    optional: false,
  })
  setOutcome(plan, "claude-skill", "installed", "telem-install-skill")
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

/**
 * The two ways an interactive run can end holding a key it did not save. Both used
 * to be silent: no warning, no note, no summary line — the run simply carried on and
 * closed with "Telem is set up." moments after the server said the key was invalid.
 */
const NO_KEY_SAVED = {
  rejected:
    "no API key was saved (the key you entered was rejected) — Telem search will not work until you add one. " +
    "Run `npx @telemai/create --login`.",
  // The same outcome reached without the user typing anything: the key ALREADY on this
  // machine is the one the server refused. "the key you entered" named a key that was
  // never entered, which reads as a typo the user could go back and fix.
  rejectedExisting:
    "no API key was saved (the key on this machine was rejected by the server) — " +
    "Telem search will not work until you add one. Run `npx @telemai/create --login`.",
  declined:
    "no API key was saved — Telem search will not work until you add one. " +
    "Run `npx @telemai/create --login`.",
} as const

/**
 * Every file THIS run will write the API key into, given what the user selected.
 *
 * There are three in the whole installer, all 0600, and which of them a run touches
 * is decided entirely by the surfaces picked — so the pre-paste note is built from
 * `selected` rather than asserting a fixed count. The old note promised the key went
 * "only to ~/.telem/credentials.json" at the exact moment the user decides whether to
 * trust the tool with a secret, while a Codex or Claude Code selection put it in two
 * more places.
 */
export function keyTargetFiles(
  selected: readonly SurfaceId[],
  ports: Ports,
  home: string,
  credsPath: string,
  tools: Record<string, ToolInfo>,
): { path: string; why: string }[] {
  const files = [{ path: credsPath, why: "the credential home every surface falls back to" }]
  // Codex is unconditional: its config.toml edit does not depend on anything being
  // detected — the table is written whether or not `codex` is on PATH.
  if (selected.includes("codex")) {
    files.push({
      path: join(codexHomeDir(ports.env, home), "config.toml"),
      why: `the Authorization header of [${CODEX_TABLE}] — the hosted Telem MCP authenticates every request`,
    })
  }
  // Claude's is NOT. `planClaudeCode` stages settings.json only after both of its
  // guards pass, so on a machine without `claude` — or without the plugin source to
  // install from — this note promised a file the run then never wrote, at the exact
  // moment the user is deciding whether to trust the installer with a secret. The
  // detection it depends on is a start-of-run snapshot, available right here.
  if (selected.includes("claude-code") && claudePluginConfigApplies(ports, tools)) {
    files.push({
      path: claudePluginConfigPath(claudeConfigDir(ports.env, home)),
      why: `pluginConfigs["${CLAUDE_PLUGIN_REF}"].options.${CLAUDE_USER_CONFIG_KEY}, which the Claude Code plugin reads`,
    })
  }
  return files
}

/**
 * Can this run put the key in the Claude plugin's userConfig at all?
 *
 * The two guards `planClaudeCode` returns `manual` on, read in one place so the
 * pre-paste note and the planner cannot drift: no `claude` binary, or no
 * the sibling plugin source to register, means nothing is installed and nothing
 * is staged — settings.json included.
 */
function claudePluginConfigApplies(ports: Ports, tools: Record<string, ToolInfo>): boolean {
  if (!tools.claude?.path) return false
  const pluginDir = resolveClaudePluginDir(ports)
  return Boolean(pluginDir && ports.exists(pluginDir))
}

type CredentialOutcome = {
  apiKey?: string
  status: string
  abort?: boolean
  /** Set on every aborting outcome, so `--json` can emit a document instead of nothing. */
  error?: RunError
}

/** Only reachable if an abort path forgets its error; never seen in practice. */
const UNKNOWN_CREDENTIAL_ERROR: RunError = {
  code: "credentials",
  message: "the API key could not be resolved",
  remedy: "run `npx @telemai/create --login` to enter a key",
}

/**
 * `verifyKey` with a spinner around it. It is one network round trip with a 15s
 * timeout, taken the instant the user presses Enter on a password prompt — the one
 * place in the run where silence reads as "it ate my key".
 */
async function verifyWithSpinner(
  ports: Ports,
  ui: Ui | null,
  baseUrl: string,
  apiKey: string,
): Promise<Awaited<ReturnType<typeof verifyKey>>> {
  const spin = ui?.spinner()
  spin?.start(`Checking your key against ${baseUrl}…`)
  const verified = await verifyKey({ baseUrl, apiKey, fetchImpl: ports.fetchImpl })
  spin?.stop(verified.status === "ok" ? "Key accepted" : "Key not confirmed")
  return verified
}

/**
 * Verify the key ALREADY in credentials.json, for the interactive "use it?" path.
 *
 * Returns the outcome when the run should proceed on that key, or `null` when the
 * caller should fall through to the paste prompt. Nothing is staged either way: the
 * key is already on disk, so "keep it" is a no-op write, and `kept` is exactly the
 * status the flags path uses for the same situation.
 */
async function checkExistingKey(
  ports: Ports,
  ui: Ui,
  context: { baseUrl: string; existing: { apiKey?: string }; say: (line: string) => void; plan: Plan },
): Promise<CredentialOutcome | null> {
  const apiKey = context.existing.apiKey as string
  const verified = await verifyWithSpinner(ports, ui, context.baseUrl, apiKey)
  if (verified.status === "ok") {
    context.say(`key verified against ${context.baseUrl}`)
    return { status: "kept" }
  }
  if (verified.status === "unauthorized") {
    // The stored key is dead (revoked, or the deployment changed under it). Offer
    // the paste prompt rather than proceeding on a key the server just refused.
    ui.error(verified.detail)
    const retry = await ui.confirm({ message: "Try a different key?", initialValue: true })
    if (retry) return null
    // Same rule as the paste prompt: a run that ends without a usable key SAYS so.
    // Declining the retry leaves the key on disk, but the deployment just refused it,
    // so "there is already a key configured" would be exactly the wrong reading.
    context.plan.warnings.push(NO_KEY_SAVED.rejectedExisting)
    return { status: "rejected" }
  }
  // Unreachable / transient / unexpected says nothing about the key, and there is no
  // write to consent to — the key is already where it lives. Keep it, and say why the
  // check did not happen.
  ui.warn(verified.detail)
  context.plan.warnings.push(`the key already in ~/.telem/credentials.json could not be checked: ${verified.detail}`)
  return { status: "kept" }
}

async function resolveCredential(
  ports: Ports,
  flags: Flags,
  ui: Ui | null,
  context: {
    baseUrl: string
    existing: { apiKey?: string; baseUrl?: string }
    say: (line: string) => void
    plan: Plan
    /** Every file this run will put the key in — see `keyTargetFiles`. */
    keyFiles: { path: string; why: string }[]
    /**
     * Set ONLY on the call made by "Try a different key? → Yes".
     *
     * That answer used to restart this function from the top, which re-asked "Found an
     * existing Telem key — use it?" — offering back a key the user had just declined or
     * the server had just refused — and re-printed the whole where-your-key-goes block
     * the user had read seconds earlier. A retry means one thing: paste another key.
     */
    retry?: boolean
    /**
     * The key already on disk was REFUSED by the server earlier in this run. An empty
     * paste must then not resolve "kept" — keeping a key the deployment just 401'd is
     * the same defect as threading a rejected key into surface configs.
     */
    existingRefused?: boolean
  },
): Promise<CredentialOutcome> {
  let apiKey: string | undefined
  if (flags.keyEnv) {
    apiKey = (ports.env[flags.keyEnv] ?? "").trim() || undefined
    if (!apiKey) {
      ports.stderr(
        `error: --key-env ${flags.keyEnv} is unset or empty. Export it first ` +
          `(export ${flags.keyEnv}=tlm_…), or drop --key-env and the installer will ask.`,
      )
      return {
        status: "missing",
        abort: true,
        error: {
          code: "key-env-unset",
          message: `--key-env ${flags.keyEnv} is unset or empty in the environment`,
          remedy: `export ${flags.keyEnv}=tlm_… first, or drop --key-env and the installer will ask for the key`,
        },
      }
    }
  } else if (ui) {
    // The key already on disk comes FIRST. Re-runs are the common case — every extra
    // tool is one — and making someone re-paste a key this machine already holds is
    // the wizard asking a question it can answer itself. Yes verifies what is on disk
    // and keeps it (nothing is re-written); No falls through to the paste prompt,
    // which is also where a rejected existing key lands.
    //
    // `--login` is exempt: its whole job is to add or replace a key, so offering to
    // keep the one already on disk answers a question the user just overruled.
    if (context.existing.apiKey && !flags.login && !context.retry) {
      const useExisting = await ui.confirm({
        message: `Found an existing Telem key (${maskKey(context.existing.apiKey)}) — use it?`,
        initialValue: true,
      })
      if (useExisting) {
        const kept = await checkExistingKey(ports, ui, context)
        if (kept) return kept
        // checkExistingKey falls through ONLY when the server refused the on-disk key
        // and the user chose to paste another — remember that for the empty-paste rule.
        context = { ...context, existingRefused: true }
      }
    }
    // The note names every file the key lands in, because "written only to
    // credentials.json" was false the moment Codex and the Claude plugin needed it
    // inline — `keyTargetFiles` is the one list, and it depends on the surfaces picked.
    //
    // On a RETRY it is one line: the block above is still on screen, and repeating it
    // buries the one thing that changed (the last key was refused) under a screen the
    // user has already read.
    //
    // Every path is abbreviated the way every other human line in this installer is
    // (`say` does it, the summary does it): three raw 40-character $HOME prefixes stack
    // up in the one note the user is meant to read carefully before pasting a secret.
    const home = ports.env.HOME ?? ports.env.USERPROFILE ?? ""
    const targets = context.keyFiles
    if (context.retry) {
      ui.note(
        `Paste another key from ${CONSOLE_URL} — same rules, and the same ` +
          `${targets.length === 1 ? "file" : `${targets.length} files`} listed above.`,
        "API key",
      )
    } else {
      ui.note(
        abbreviateHome(
          `Sign in at ${CONSOLE_URL}, open your project, and create a key under "API keys".\n` +
            "Paste it below — it is masked, never printed, and never put on a command line.\n" +
            `This run writes it to ${targets.length === 1 ? "one file" : `${targets.length} files`}, ` +
            `all 0600:\n` +
            targets.map((target) => `  ${target.path}\n    ${target.why}`).join("\n") +
            "\nLeave it empty if you do not have one yet; everything else still gets configured." +
            "\nUsing a different Telem endpoint? re-run with --base-url <url>.",
          home,
        ),
        "API key",
      )
    }
    const pasted = (await ui.password({ message: "Telem API key (empty to skip)" })).trim()
    apiKey = pasted || undefined
  } else if (context.existing.apiKey) {
    return { status: "kept", apiKey: undefined }
  }

  if (!apiKey) {
    if (context.existingRefused) {
      // The only key on disk was just 401'd. "Kept" would put a known-dead credential
      // back in play; end keyless and say so, exactly like a declined retry.
      context.say("the key on this machine was rejected — nothing kept")
      context.plan.warnings.push(NO_KEY_SAVED.rejectedExisting)
      return { status: "rejected" }
    }
    const message = context.existing.apiKey
      ? "keeping the key already in ~/.telem/credentials.json"
      : // `--login` on its own PROMPTS. The old advice was `--login --key-env
        // TELEM_API_KEY`, which requires the variable to already be exported — and a
        // user with no key by definition has not exported one, so the installer's own
        // remedy exited 1 for exactly the user it was aimed at. --key-env stays the
        // documented CI form; it is not the thing to tell a human to run.
        "no key configured yet — add one any time with: npx @telemai/create --login"
    context.say(message)
    // Not "unauthenticated" — that reads as degraded-but-working. Against the hosted
    // router an unauthenticated search is a 401: nothing works at all.
    if (!context.existing.apiKey) {
      context.plan.warnings.push(
        "no API key configured — Telem search will be rejected until you add one. " +
          "Add one any time with: npx @telemai/create --login",
      )
    }
    return { status: context.existing.apiKey ? "kept" : "absent" }
  }

  const verified = await verifyWithSpinner(ports, ui, context.baseUrl, apiKey)
  if (verified.status === "ok") {
    context.say(`key verified against ${context.baseUrl}`)
    return { status: "verified", apiKey }
  }
  if (verified.status === "unauthorized") {
    if (ui) {
      ui.error(verified.detail)
      const retry = await ui.confirm({ message: "Try a different key?", initialValue: true })
      // Straight back to the paste prompt — see `context.retry`.
      if (retry) return resolveCredential(ports, { ...flags, keyEnv: undefined }, ui, { ...context, retry: true })
      // Say it out loud. The run continues (the surfaces are still worth
      // configuring), but it continues WITHOUT a key, and the last thing the user
      // saw was the server saying the key is invalid.
      context.plan.warnings.push(NO_KEY_SAVED.rejected)
      return { status: "rejected" }
    }
    ports.stderr(`error: ${verified.detail}`)
    return {
      status: "rejected",
      abort: true,
      error: {
        code: "key-rejected",
        message: verified.detail,
        remedy: `create a fresh key under "API keys" at ${CONSOLE_URL} and re-run`,
      },
    }
  }

  // Unreachable, a transient server error (429/5xx), or an unexpected status: a
  // corporate proxy, a busy or restarting deployment, a self-hosted box that is
  // down, a typo'd --base-url. NONE of these say the key is bad — only 401/403
  // does — so a VALID key is never hard-blocked by a server hiccup: the key may
  // well be fine, this is a decision, not a failure, and it is never made silently.
  if (ui) {
    ui.warn(verified.detail)
    const anyway = await ui.confirm({
      message: "Write the key anyway, without verifying it?",
      initialValue: true,
    })
    if (!anyway) {
      context.plan.warnings.push(NO_KEY_SAVED.declined)
      return { status: "unverified-declined" }
    }
    context.plan.warnings.push(`the key was written unverified: ${verified.detail}`)
    return { status: "unverified", apiKey }
  }
  if (flags.writeUnverified) {
    context.plan.warnings.push(`the key was written unverified: ${verified.detail}`)
    return { status: "unverified", apiKey }
  }
  ports.stderr(`error: ${verified.detail}`)
  ports.stderr("pass --write-unverified to store the key without a successful check")
  return {
    status: "unverified-refused",
    abort: true,
    error: {
      code: "key-unverified",
      message: verified.detail,
      remedy: "pass --write-unverified to store the key without a successful check",
    },
  }
}

// ---------------------------------------------------------------------------
// commit + summary
// ---------------------------------------------------------------------------

/** The closing line of an interactive --dry-run. It is the only verdict a dry run has. */
const DRY_RUN_OUTRO = "Dry run — nothing was written."

async function finish(
  ports: Ports,
  flags: Flags,
  plan: Plan,
  context: {
    say: (line: string) => void
    ui: Ui | null
    baseUrl: string
    credential: CredentialOutcome
    /** The key actually written into surfaces (`credential.apiKey ?? existing`). */
    effectiveApiKey?: string
    /** The key that was in credentials.json when the run started. */
    existingApiKey?: string
    credsPath: string
    interactive: boolean
    verifyAgain: boolean
    progress: CommitProgress
  },
): Promise<number> {
  // Scan the key that is actually WRITTEN, not just a freshly entered one. On a re-run
  // that KEEPS the existing key, `credential.apiKey` is undefined while the effective
  // key (`credential.apiKey ?? existingCredentials.apiKey`) is what gets threaded into
  // surfaces and written inline into Codex's config.toml — so it MUST be in the scan
  // set, or the guard is a no-op exactly when a real key is on disk. Deduped and with
  // falsy dropped; the key itself is never logged.
  //
  // The key ALREADY on disk is in the set too, always. On a rotation the effective key
  // is the NEW one, while the old one — still live until it is revoked, and still the
  // user's secret — is what a host or an installer that has not caught up would echo.
  // Leaving it out made the guard blind to a real key in exactly the run that changes it.
  const secrets = Array.from(
    new Set(
      [context.credential.apiKey, context.effectiveApiKey, context.existingApiKey].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  )
  assertNoSecretInCommands(plan, secrets)

  const summary: Summary = {
    version: ports.version,
    // Overwritten from the verdict just before the document is printed. A --dry-run
    // never reaches that point and is always ok: it staged a plan and wrote nothing.
    ok: true,
    mode: context.interactive ? "interactive" : "flags",
    dryRun: flags.dryRun,
    baseUrl: context.baseUrl,
    credentials: {
      status: context.credential.status,
      path: context.credential.apiKey ? context.credsPath : undefined,
      masked: context.credential.apiKey ? maskKey(context.credential.apiKey) : undefined,
    },
    files: plan.files.map((file) => ({
      path: file.path,
      created: file.created,
      reason: file.reason,
      undo: file.undo,
    })),
    removals: plan.removals.map((removal) => ({
      path: removal.path,
      reason: removal.reason,
      undo: removal.undo,
    })),
    commands: plan.commands.map((command) => ({ argv: command.argv, reason: command.reason })),
    surfaces: plan.outcomes,
    notes: plan.notes,
    warnings: plan.warnings,
  }

  // `context.say` already routes to the clack ui when there is one; `framed` is the
  // same decision, exposed so the blocks that want a titled note rather than a log
  // line can ask for one. Under --json stdout is reserved for the document, so the
  // plain (stderr) channel still wins there.
  const home = ports.env.HOME ?? ports.env.USERPROFILE ?? ""
  const framed = context.ui && !flags.json ? context.ui : null

  if (flags.dryRun) {
    const steps = [
      ...plan.files.map((file) => `write   ${file.path}  (${file.reason})`),
      ...plan.removals.map((removal) => `remove  ${removal.path}  (${removal.reason})`),
      ...plan.commands.map((command) => `run     ${command.argv.join(" ")}`),
    ]
    if (!steps.length) steps.push("(nothing to do)")
    if (framed) framed.note(steps.map((step) => abbreviateHome(step, home)).join("\n"), "--dry-run: nothing was written")
    else {
      context.say("")
      context.say("--dry-run: nothing was written. The plan is:")
      for (const step of steps) context.say(`  ${step}`)
    }
    emit(ports, flags, summary, context.say, plan, secrets, framed)
    // Interactively a --dry-run used to return from here, so the clack frame was never
    // closed: the run stopped mid-gutter with no outro, looking like it had crashed.
    // Every other exit through `finish` ends on one verdict line; a dry run gets the
    // one verdict it can honestly give.
    if (context.ui) context.ui.outro(DRY_RUN_OUTRO)
    return EXIT_OK
  }

  // From here on the disk is being changed, so the failure epilogue must stop
  // claiming nothing was written (see CommitProgress).
  context.progress.started = true
  const installing = context.ui?.spinner()
  const commit = commitPlan(plan, {
    exec: ports.exec,
    log: (text) => context.say(text),
    onWrote: (path) => context.progress.written.push(path),
    // Interactive only: a `claude plugin install` is a network install that can take
    // ten seconds behind a bare `$ claude plugin install …` line.
    progress: installing
      ? { start: (text) => installing.start(text), stop: (text) => installing.stop(text) }
      : undefined,
  })

  let commandFailed = false
  for (const result of commit.results) {
    const outcomeId = result.command.surface
    // Not attempted, because an earlier command for this surface failed. The failure
    // that blocked it is already reported; re-reporting it here would say the same
    // thing twice about one broken install.
    if (result.skipped) continue
    if (result.status === 0) continue
    commandFailed = commandFailed || !result.command.optional
    // Translate the misleading raw failures (npm E404-as-permission, pip/uv
    // no-matching-distribution-as-Python-floor) into actionable messages; anything
    // unknown keeps the generic "<cmd> exited N: <first line>" detail.
    const raw = result.stderr.trim() || result.stdout.trim()
    const context = errorContextFor(result.command)
    const translated = context ? translateInstallError(context, raw) : null
    const detail =
      translated ??
      `${result.command.argv[0]} exited ${result.status ?? "abnormally"}${
        raw ? `: ${raw.split("\n")[0]}` : ""
      }`
    // One failure, one report. The surface row already carries the id and the detail,
    // so pushing the same text into `warnings` printed it a second time in the same
    // summary. `python` is the exception: it is a pseudo-surface with no row of its
    // own, so the warning channel is the only place its failure can appear.
    if (outcomeId === "python") plan.warnings.push(detail)
    else setOutcome(plan, outcomeId, "failed", detail)
  }
  summary.commands = plan.commands.map((command, index) => ({
    argv: command.argv,
    reason: command.reason,
    status: commit.results[index]?.status ?? null,
    ...(commit.results[index]?.skipped ? { skipped: true } : {}),
  }))
  summary.surfaces = plan.outcomes
  summary.warnings = plan.warnings

  if (context.verifyAgain && context.credential.apiKey) {
    const recheck = await verifyKey({
      baseUrl: context.baseUrl,
      apiKey: context.credential.apiKey,
      fetchImpl: ports.fetchImpl,
    })
    summary.credentials.status = recheck.status === "ok" ? "verified" : `${recheck.status}`
  }

  const verdict = readVerdict({
    plan,
    credential: context.credential,
    commandFailed,
    login: flags.login,
    credsPath: context.credsPath,
  })

  summary.ok = verdict.exitCode === EXIT_OK
  emit(ports, flags, summary, context.say, plan, secrets, framed)
  if (context.ui) context.ui.outro(verdict.outro)
  return verdict.exitCode
}

/** Credential outcomes that leave a usable key configured once the run is over. */
const KEY_CONFIGURED = new Set(["verified", "unverified", "kept"])

/**
 * The closing line and the exit code that goes with it.
 *
 * Both used to be derived from the COMMAND results alone, so a surface that failed
 * without ever running a command — an unparseable opencode config, a config.toml this
 * editor refuses to rewrite, an openclaw below the version floor — printed "Telem is
 * set up." and exited 0. `npm create @telemai -- --yes --client opencode && echo ok`
 * printed ok on a failed install. A run that ended in manual rows or with no key said
 * the same thing two lines under its own warnings.
 *
 * So the verdict reads BOTH sources, and it has three shapes rather than two: done,
 * partly done (something still needs the user), and failed.
 */
function readVerdict(options: {
  plan: Plan
  credential: CredentialOutcome
  commandFailed: boolean
  login: boolean
  credsPath: string
}): { exitCode: number; outro: string } {
  const { plan, credential, commandFailed, login, credsPath } = options
  const failed = commandFailed || plan.outcomes.some((outcome) => outcome.status === "failed")

  if (login) {
    // --login has exactly one job, so the outro IS the credential outcome — and a key
    // the deployment rejected is a failed run, not a silent exit 0 under "Telem is set up."
    return {
      exitCode: failed || credential.status === "rejected" ? EXIT_ERROR : EXIT_OK,
      outro: loginOutro(credential, credsPath),
    }
  }
  if (failed) return { exitCode: EXIT_ERROR, outro: "Finished with errors — see the summary above." }

  const pending =
    plan.outcomes.filter((outcome) => outcome.status === "manual" || outcome.status === "partial").length +
    (KEY_CONFIGURED.has(credential.status) ? 0 : 1)
  if (pending) {
    return {
      exitCode: EXIT_OK,
      outro: `Telem is partly set up — ${pending} thing${pending === 1 ? "" : "s"} still ${
        pending === 1 ? "needs" : "need"
      } you (see above).`,
    }
  }
  return {
    exitCode: EXIT_OK,
    outro: plan.outcomes.some((outcome) => outcome.status === "installed")
      ? "Telem is set up — restart the apps above and try a search."
      : "Telem is set up.",
  }
}

/** What `--login` actually achieved, in one line. It is the whole run. */
function loginOutro(credential: CredentialOutcome, credsPath: string): string {
  switch (credential.status) {
    case "verified":
      return `Key verified and written to ${credsPath}.`
    case "unverified":
      return `Key written to ${credsPath}, but it could not be checked — nothing has proven it works yet.`
    case "kept":
      return `No new key was entered; the one already in ${credsPath} was kept.`
    case "rejected":
      return "No key was saved — the one you entered was rejected. Run `npx @telemai/create --login` to try another."
    case "unverified-declined":
      return "No key was saved — you chose not to write it without a successful check."
    default:
      return "No key was saved — nothing was entered. Run `npx @telemai/create --login` when you have one."
  }
}

/**
 * How a surface outcome is spelled in the summary.
 *
 * A `--dry-run` printed `installed  codex  …` two lines under "nothing was written",
 * contradicting its own preamble — the file headings already say "Would write:", the
 * status column simply never learned the tense. The column width is computed from the
 * rendered labels rather than fixed, so the longer dry-run words still line up.
 */
function statusLabel(status: SurfaceStatus, dryRun: boolean): string {
  if (!dryRun) return status
  switch (status) {
    case "installed":
      return "would install"
    case "partial":
      return "would install partly"
    case "unchanged":
      return "no change"
    case "failed":
      return "would fail"
    case "manual":
      return "would need you"
  }
}

function emit(
  ports: Ports,
  flags: Flags,
  summary: Summary,
  say: (line: string) => void,
  plan: Plan,
  secrets: readonly string[],
  ui: Ui | null,
): void {
  // Last line of defense before anything reaches the terminal: the whole emitted
  // document — the --json summary and, for the human path, its notes/warnings —
  // must not contain the key. Throwing here aborts the print rather than leaking it.
  const doc = JSON.stringify(summary)
  assertNoSecretInText([doc, ...plan.notes, ...plan.warnings], secrets)
  if (flags.json) {
    ports.stdout(JSON.stringify(summary, null, 2))
    return
  }

  const short = (text: string) => abbreviateHome(text, ports.env.HOME ?? ports.env.USERPROFILE ?? "")
  const labels = summary.surfaces.map((outcome) => statusLabel(outcome.status, flags.dryRun))
  const width = labels.length ? Math.max(...labels.map((label) => label.length)) : 0
  const rows = summary.surfaces.map((outcome, index) => ({
    status: outcome.status,
    text: short(`${labels[index].padEnd(width)}  ${outcome.id}  ${outcome.detail}`),
  }))

  const blocks: { title: string; body: string[] }[] = []
  if (summary.files.length) {
    blocks.push({
      title: flags.dryRun ? "Would write" : "Wrote",
      body: summary.files.map((file) => short(file.path)),
    })
  }
  if (summary.removals.length) {
    blocks.push({
      title: flags.dryRun ? "Would remove" : "Removed",
      body: summary.removals.map((removal) => short(removal.path)),
    })
  }
  if (summary.files.length || summary.removals.length) {
    blocks.push({
      title: "Undo",
      body: [
        ...summary.files.map((file) => short(file.undo)),
        // Deduped: every removal in one migration shares the same undo line, and
        // printing "re-install the older hook" three times helps nobody.
        ...new Set(summary.removals.map((removal) => short(removal.undo))),
      ],
    })
  }

  if (ui) {
    // Inside a clack frame a plain stdout line carries no `│` gutter, so writing the
    // summary straight to stdout broke the frame in every capture and left a stray
    // gutter hanging above the outro. Everything goes through the ui instead — and the
    // rows use ui.error/ui.success, the two Ui methods that existed and were never
    // called, so a failed row is not visually identical to an installed one.
    for (const row of rows) {
      if (row.status === "failed") ui.error(row.text)
      else if (row.status === "installed") ui.success(row.text)
      else ui.info(row.text)
    }
    for (const block of blocks) ui.note(block.body.join("\n"), block.title)
    for (const note of plan.notes) ui.note(short(note))
    for (const warning of summary.warnings) ui.warn(short(warning))
    // Rows → notes → NEXT STEPS → outro. The clack path returns here rather than
    // falling through to the plain printer, so the Next steps block has to be
    // rendered on both sides or the one run that most needs it — the interactive
    // one — ends on a list of `rm` commands under "Undo:".
    const steps = nextStepLines(flags, summary)
    if (steps.length) ui.note(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"), "Next steps")
    return
  }

  say("")
  if (rows.length) {
    say("Surfaces:")
    for (const row of rows) say(`  ${row.text}`)
  }
  for (const block of blocks) {
    say("")
    say(`${block.title}:`)
    for (const line of block.body) say(`  ${line}`)
  }
  for (const note of plan.notes) {
    say("")
    say(note)
  }
  for (const warning of summary.warnings) {
    say("")
    say(`warning: ${warning}`)
  }
  const steps = nextStepLines(flags, summary)
  if (steps.length) {
    say("")
    say("Next steps:")
    steps.forEach((step, index) => say(`  ${index + 1}. ${step}`))
  }
}

/**
 * The last thing a successful run prints, because "what do I do now" was the one
 * question the summary never answered — it ended on a list of `rm` commands under
 * "Undo:". The restart line is generated from what this run actually installed:
 * opencode and Codex both read their config at startup, so a user who does not
 * restart sees no Telem at all and concludes it did not work.
 */
function nextStepLines(flags: Flags, summary: Summary): string[] {
  // A dry run installed nothing, so "restart X" would be an instruction about a
  // change that is not on disk.
  if (flags.dryRun) return []
  const restart = summary.surfaces
    .filter((outcome) => outcome.status === "installed")
    .map((outcome) => appLabel(outcome.id))
  const ready = summary.surfaces.some(
    (outcome) => outcome.status === "installed" || outcome.status === "unchanged",
  )
  if (!ready) return []
  const steps: string[] = []
  if (restart.length) {
    steps.push(
      `Restart ${restart.join(", ")} so ${restart.length > 1 ? "they" : "it"} load${
        restart.length > 1 ? "" : "s"
      } the new config.`,
    )
  }
  steps.push("Ask it to search for something — Telem handles the search.")
  steps.push(`Watch the searches land at ${CONSOLE_URL}`)
  return steps
}

/** A surface's label as an app you restart — without the catalog's "(plugin)" tail. */
function appLabel(id: SurfaceId): string {
  return appName(surfaceById(id)?.label ?? id)
}

/**
 * A catalog label as the APP's name: "Codex (plugin)" is the right label next to a
 * checkbox that says what installing it does, and the wrong thing to read back in
 * "Found: …" or "Restart …", which are about the program itself.
 */
function appName(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "").trim() || label
}

// ---------------------------------------------------------------------------

/**
 * The one wording for "you skipped this".
 *
 * The redesign removed every free-text option question, which is where a skipped
 * answer used to render as silence — but one screen can still be answered with
 * nothing: the provider multiselect, deselected down to empty. It gets the same
 * words, plus what that emptiness actually means, so the screen never looks like it
 * swallowed the answer.
 */
const UNSET_LABEL = "leave unset"

/**
 * The search defaults, behind ONE gate.
 *
 * The table still defines six keys and every surface still reads all six — but the
 * wizard asks about three (`WIZARD_KEYS`), and only when the user says yes. Six
 * screens that every captured first run answered "leave unset" was six screens of
 * nothing; the refinements (`fields`, `providersExclude`, `providerOverrides`) stay
 * fully supported in `~/.telem/telem.json` where the people who want them live.
 *
 * Every answer still travels through the SHIPPED coercers via `answerToValue`, so a
 * value this screen accepts is a value every reader resolves.
 */
async function askOptions(ui: Ui, existing: Record<string, unknown>): Promise<Record<string, unknown>> {
  const customize = await ui.confirm({
    message: "Customize search defaults? (No = Telem's recommended defaults)",
    initialValue: false,
  })
  if (!customize) return {}

  const questions = Object.fromEntries(
    buildInterview(existing)
      .filter((entry) => WIZARD_KEYS.includes(entry.key))
      .map((entry) => [entry.key, entry]),
  )
  const answers: Record<string, unknown> = {}
  ui.note(
    "Optional tuning for every Telem search — how much detail comes back, which providers run.\n" +
      "Press Enter on each to keep Telem's defaults; you can change them later in ~/.telem/telem.json.",
    "Search defaults",
  )

  // ---- tier ---------------------------------------------------------------
  const tierQuestion = questions.tier as Question
  const currentTier = initialText(tierQuestion)
  const tier = await ui.select({
    message: "How much detail should each search result include? (tier)",
    options: (SUGGESTIONS.tier ?? []).map((value) => ({ value, label: TIER_LABELS[value] ?? value })),
    initialValue: (SUGGESTIONS.tier ?? []).includes(currentTier) ? currentTier : DEFAULT_TIER,
  })
  const tierAnswer = answerToValue(tierQuestion, tier)
  answers.tier = tierAnswer.ok ? tierAnswer.value : undefined

  // ---- providers ----------------------------------------------------------
  // One screen, not two. "Which to include" and "which to exclude" were the same
  // decision asked twice, and the pair could contradict each other; the wizard now
  // asks the decision — the deployment's set, or a set of your own — and
  // `providersExclude` stays a file-only refinement.
  const providersQuestion = questions.providersInclude as Question
  const currentProviders = Array.isArray(providersQuestion.initial)
    ? (providersQuestion.initial as string[])
    : []
  const providerMode = await ui.select({
    message: "Which search providers should searches use?",
    options: [
      { value: "default", label: "Deployment default — recommended" },
      { value: "choose", label: "Choose specific providers…" },
    ],
    initialValue: currentProviders.length ? "choose" : "default",
  })
  if (providerMode === "choose") {
    ui.note("More providers = higher cost per search.", "Providers")
    const picked = await ui.multiselect({
      message: "Which providers should run?",
      options: SEARCH_PROVIDERS.map((provider) => ({ value: provider, label: provider })),
      initialValues: currentProviders.length ? currentProviders : [...DEFAULT_PROVIDER_PICKS],
      required: false,
    })
    const result = answerToValue(providersQuestion, picked.join(","))
    answers.providersInclude = result.ok ? result.value : undefined
    // Deselected down to nothing IS an answer — the same answer as "Deployment
    // default" — and it used to be the only screen in the interview that took an
    // answer and echoed nothing back.
    if (!picked.length) ui.info(`${UNSET_LABEL} — the deployment's own provider set will run`)
  } else {
    // The deployment's own set: that is the ABSENCE of providersInclude, so an
    // include list left over from an earlier run is removed rather than kept.
    answers.providersInclude = undefined
  }

  // ---- fullContent --------------------------------------------------------
  // A confirm, not a tri-state select: "leave unset" and "no" resolve identically on
  // every reader (off unless set), so offering both asked the user to distinguish
  // two words for the same behavior.
  const fullContent = await ui.confirm({
    message: "Fetch full page content for every result? (slower, extra cost)",
    initialValue: questions.fullContent?.initial === true,
  })
  answers.fullContent = fullContent ? true : undefined

  return answers
}

function safeJson(source: string | null): unknown {
  if (source === null) return null
  try {
    return JSON.parse(source.replace(/^﻿/, ""))
  } catch {
    return null
  }
}
