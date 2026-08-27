// The staged plan: everything the run intends to do, held in memory until the run
// is over.
//
// This is the "a cancelled run writes NOTHING" mechanism. Every step
// APPENDS to a plan; nothing touches the filesystem or spawns a process until
// `commitPlan` runs, which happens only after the last question is answered. Ctrl+C
// at question four therefore leaves the machine exactly as it was — and `--dry-run`
// is not a separate code path, it is simply the plan without the commit.
//
// `commitPlan` also carries the secret guard. Printed commands never contain the
// key by construction (that is the whole point of every surface falling back to
// credentials.json), but "by construction" is a claim, and this makes it a check
// that fails loudly rather than a comment that ages.

import { CONFIG_MODE, SECRET_DIR_MODE, SECRET_MODE, existsSync, removeFileSync, writeFileAtomicSync } from "./fsops.ts"
import type { SurfaceId } from "./surfaces.ts"

export type FileWrite = {
  path: string
  contents: string
  mode: number
  /** Holds a credential: 0600, and its directory 0700. */
  secret: boolean
  /**
   * Mode for directories created on the way to this file. Defaults to 0700 for a
   * secret and 0755 otherwise; set it to tighten a NON-secret file's directory
   * (the Codex hooks/ dir is 0700 but its launcher stays executable, a pair the
   * secret flag alone cannot express).
   */
  dirMode?: number
  /** The file did not exist when the plan was built. */
  created: boolean
  reason: string
  /** One line telling the user how to put this file back. */
  undo: string
}

/**
 * A file this run DELETES.
 *
 * Deliberately its own kind rather than a `contents: null` write: the only thing that
 * produces one is a migration off an older Telem install (the hand-written Codex
 * reasoning hook, replaced by the plugin that now carries it), it is consent-gated
 * like every other destructive step, and it needs its own undo line — you cannot
 * "restore your previous file" from a plan that no longer holds its bytes, so the
 * undo says how to get the feature back instead.
 */
export type FileRemoval = {
  path: string
  reason: string
  /** One line telling the user how to get back what this deleted. */
  undo: string
}

export type PlannedCommand = {
  surface: SurfaceId | "python"
  argv: string[]
  reason: string
  /** A failure is reported in the summary but does not fail the whole run. */
  optional: boolean
}

/**
 * How a surface ended up.
 *
 * `partial` is the half-done row: some of what the surface needs landed and some
 * did not, and neither `installed` (a claim) nor `failed` (nothing worked) is true.
 * Together with `manual` it is what the closing verdict counts as "still needs you".
 */
export type SurfaceStatus = "installed" | "partial" | "failed" | "manual" | "unchanged"

export type SurfaceOutcome = {
  id: SurfaceId
  status: SurfaceStatus
  detail: string
}

export type Plan = {
  files: FileWrite[]
  /** Files this run deletes, committed AFTER every write (see commitPlan). */
  removals: FileRemoval[]
  commands: PlannedCommand[]
  /** Text blocks printed at the end: snippets to paste, manual instructions. */
  notes: string[]
  outcomes: SurfaceOutcome[]
  warnings: string[]
}

export function emptyPlan(): Plan {
  return { files: [], removals: [], commands: [], notes: [], outcomes: [], warnings: [] }
}

export function addFile(plan: Plan, file: Omit<FileWrite, "mode"> & { mode?: number }): void {
  plan.files.push({ ...file, mode: file.mode ?? (file.secret ? SECRET_MODE : CONFIG_MODE) })
}

export function setOutcome(plan: Plan, id: SurfaceId, status: SurfaceStatus, detail: string): void {
  const existing = plan.outcomes.find((outcome) => outcome.id === id)
  if (existing) {
    existing.status = status
    existing.detail = detail
    return
  }
  plan.outcomes.push({ id, status, detail })
}

/** Secrets long enough to be real — a stray short string cannot block a run. */
function realSecrets(secrets: readonly string[]): string[] {
  return secrets.map((secret) => secret.trim()).filter((secret) => secret.length >= 8)
}

/**
 * No planned command may carry a secret in its argv, and no human-facing string the
 * plan emits — a note, a warning, or (via `assertNoSecretInText`) the `--json`
 * summary — may print one either. argv is world-readable through `ps`, and printed
 * output lands in scrollback and CI logs, so both are hard stops, not warnings.
 *
 * The invariant these guards enforce is about CHANNELS, not files: the key never
 * reaches argv and is never printed. Which FILES may hold it is a separate, smaller
 * list — ~/.telem/credentials.json, the hosted Codex table's `http_headers` in
 * ~/.codex/config.toml, and the Claude plugin's `pluginConfigs` entry in
 * ~/.claude/settings.json (`keyTargetFiles` in run.ts is the one list) — all three
 * written at 0600. So the guard has to cover
 * every channel the run writes to the terminal, not just argv. A warning built from
 * a command's stderr, or a summary field, is exactly the kind of place a key could
 * leak by accident.
 */
export function assertNoSecretInCommands(plan: Plan, secrets: readonly string[]): void {
  const real = realSecrets(secrets)
  if (!real.length) return
  for (const command of plan.commands) {
    for (const argument of command.argv) {
      if (real.some((secret) => argument.includes(secret))) {
        throw new Error(
          `refusing to run \`${command.argv[0]} …\`: it would put the API key on a command line`,
        )
      }
    }
  }
  for (const note of plan.notes) {
    if (real.some((secret) => note.includes(secret))) {
      throw new Error("refusing to print an instruction that contains the API key")
    }
  }
  for (const warning of plan.warnings) {
    if (real.some((secret) => warning.includes(secret))) {
      throw new Error("refusing to print a warning that contains the API key")
    }
  }
}

/**
 * The same never-print guard for arbitrary human-facing text: the emitted `--json`
 * document and every summary line the wizard prints go through here before they
 * reach stdout/stderr, so a secret that reached the summary by any path is caught
 * before it is shown rather than after.
 */
export function assertNoSecretInText(texts: readonly string[], secrets: readonly string[]): void {
  const real = realSecrets(secrets)
  if (!real.length) return
  for (const text of texts) {
    if (real.some((secret) => text.includes(secret))) {
      throw new Error("refusing to print output that contains the API key")
    }
  }
}

export type CommandResult = {
  command: PlannedCommand
  status: number | null
  stdout: string
  stderr: string
  /**
   * Never run: an earlier NON-OPTIONAL command for the same surface failed, and this
   * one depends on it. `status` is null here and means "not attempted", not "died".
   */
  skipped?: boolean
}

export type CommitDeps = {
  exec: (argv: string[]) => { status: number | null; stdout: string; stderr: string }
  write?: (file: FileWrite) => void
  remove?: (removal: FileRemoval) => void
  log: (line: string) => void
  /**
   * Called with each path the moment it lands. `written` is only returned on the
   * happy path, and a commit that throws half way (an EACCES on the third file)
   * still changed the disk — the caller needs the partial list to tell the user the
   * truth instead of "Nothing was written."
   */
  onWrote?: (path: string) => void
  /**
   * A progress channel for the commands, which are the only part of the commit that
   * can take ten seconds (`claude plugin install`, `uv tool install`). When it is
   * supplied it REPLACES the `$ argv` log line — a spinner and a plain log line on
   * the same stream fight over the same row — and when it is not, the log line
   * stands exactly as before (every non-interactive run).
   */
  progress?: { start: (text: string) => void; stop: (text: string) => void }
}

export type CommitResult = { written: string[]; results: CommandResult[] }

export function commitPlan(plan: Plan, deps: CommitDeps): CommitResult {
  const write =
    deps.write ??
    ((file: FileWrite) => {
      writeFileAtomicSync(file.path, file.contents, {
        mode: file.mode,
        dirMode: file.dirMode ?? (file.secret ? SECRET_DIR_MODE : 0o755),
      })
    })

  const written: string[] = []
  for (const file of plan.files) {
    write(file)
    written.push(file.path)
    deps.onWrote?.(file.path)
    deps.log(`wrote ${file.path}${file.secret ? " (mode 0600)" : ""}`)
  }

  // Removals come AFTER every write, so the file that de-registers something (the
  // rewritten hooks.json) always lands before the thing it de-registered is deleted.
  // The reverse order leaves a window where a config points at a file that is gone.
  const remove = deps.remove ?? ((removal: FileRemoval) => removeFileSync(removal.path))
  for (const removal of plan.removals) {
    remove(removal)
    // Reported through the same channel as a write: what the caller needs on a
    // half-way failure is "the disk already changed here", not the verb.
    deps.onWrote?.(removal.path)
    deps.log(`removed ${removal.path}`)
  }

  // A surface's commands are a SEQUENCE, not a set: `codex plugin add telem@telem`
  // after a failed `codex plugin marketplace add` is a guaranteed second identical
  // failure, reported as if it were new information. So once a non-optional command
  // for a surface fails, that surface's remaining commands are recorded as skipped
  // rather than run. Other surfaces are unaffected — they share nothing.
  const results: CommandResult[] = []
  const blocked = new Set<PlannedCommand["surface"]>()
  for (const command of plan.commands) {
    if (blocked.has(command.surface)) {
      results.push({ command, status: null, stdout: "", stderr: "", skipped: true })
      deps.log(`skipped ${command.argv.join(" ")} (an earlier ${command.surface} step failed)`)
      continue
    }
    // With a spinner, the command line itself is not printed: the spinner says what
    // is running in the user's words, and the raw argv would break its frame.
    if (deps.progress) deps.progress.start(`${command.reason}…`)
    else deps.log(`$ ${command.argv.join(" ")}`)
    const result = deps.exec(command.argv)
    deps.progress?.stop(
      result.status === 0
        ? `${command.reason} — done`
        : `${command.reason} — exited ${result.status ?? "abnormally"}`,
    )
    results.push({ command, ...result })
    if (result.status !== 0 && !command.optional) blocked.add(command.surface)
  }
  return { written, results }
}

/**
 * The undo line for a file we are about to write.
 *
 * The in-place branch used to say "restore your previous <path>" — an instruction the
 * user cannot follow, because no backup of that file exists anywhere. So it states
 * the delta and says plainly that there is nothing to restore from; `delta` is the
 * caller's one-line description of what changed inside the file.
 */
export function undoLine(path: string, created: boolean, delta?: string): string {
  if (created) return `rm ${path}`
  return `${path} was edited in place${delta ? ` (${delta})` : ""}; no backup was kept, so there is nothing to restore from`
}

export { existsSync }
