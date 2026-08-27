// File writes. Two rules, both of them r1 review findings against this spec:
//
//  1. CREATE WITH THE MODE, never chmod afterwards. `writeFileSync(path, data,
//     {mode})` applies `mode` only when it CREATES the file — over an existing
//     0644 credentials.json it silently leaves the key world-readable — and
//     write-then-chmod leaves a window at `0666 & ~umask` in which the key is
//     already on disk and readable. Both are fixed by opening a fresh temp file
//     with O_CREAT|O_EXCL and the final mode, writing into it, and renaming.
//
//  2. RENAME within the same directory, so the swap is atomic on the target
//     filesystem and a crash leaves either the old file or the new one — never a
//     half-written config another tool is about to read.
//
// Node built-ins only; this module is bundled with zero runtime dependencies.

import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

/** Mode for anything holding a credential: owner read/write, nobody else. */
export const SECRET_MODE = 0o600
/** Mode for the `.telem` directory itself — it holds the credentials file. */
export const SECRET_DIR_MODE = 0o700
/** Mode for ordinary config we create. */
export const CONFIG_MODE = 0o644

export type WriteOptions = {
  /** Mode for the file when we create it. */
  mode: number
  /** Mode for directories created on the way. */
  dirMode?: number
}

/**
 * Write `contents` to `path` atomically, creating the file with `options.mode`.
 *
 * When the target already exists its CURRENT mode is kept (a user who tightened
 * their opencode.json to 0600 keeps it), except that a secret target is never
 * loosened: the effective mode is the intersection of what is there and what we
 * asked for whenever we asked for 0600.
 */
export function writeFileAtomicSync(path: string, contents: string, options: WriteOptions): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: options.dirMode ?? 0o755 })

  let mode = options.mode
  try {
    const existing = statSync(path)
    const existingMode = existing.mode & 0o777
    // For a secret we take the tighter of the two; for ordinary config we simply
    // preserve what the user has, because it is their file and we are one editor
    // among several.
    mode = options.mode === SECRET_MODE ? existingMode & SECRET_MODE : existingMode
  } catch {
    // No existing file: our mode stands.
  }

  const temp = join(dir, `.${basename(path)}.telem-${process.pid}-${Date.now().toString(36)}`)
  // O_EXCL is what makes the mode meaningful: it guarantees we created this file,
  // so `mode` was applied and nobody had it open at a looser mode first.
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
  try {
    writeSync(fd, contents)
    // The mode the kernel gave us is `mode & ~umask`; for a secret that can only
    // be TIGHTER than 0600, never looser, so a strict umask is honored and a
    // permissive one cannot widen the file.
    //
    // POSIX only. Windows has no POSIX mode bits: the `mode` arg to openSync there
    // only toggles the read-only attribute, and libuv synthesizes stat.mode as
    // 0o666 for any writable file — so `0o666 & 0o077` is a guaranteed false
    // positive that would abort EVERY secret write. On Windows the secret guarantee
    // is delegated instead to the default per-user ACL on %USERPROFILE%: a file
    // created under the user's own profile directory is not readable by other
    // standard users, which is where credentials.json lives. Node's builtins expose
    // no portable ACL API (tightening further would mean spawning icacls, a
    // subprocess this zero-dependency module deliberately avoids), so the self-check
    // is simply skipped there rather than run against numbers that cannot hold.
    if (options.mode === SECRET_MODE && process.platform !== "win32") {
      const actual = fstatSync(fd).mode & 0o777
      if (actual & 0o077) {
        throw new Error(
          `refusing to write ${path}: the temporary file came back mode ${actual.toString(8)}, ` +
            "which is readable beyond its owner",
        )
      }
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  try {
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Best effort: the rename already failed, and leaving a temp file behind is
      // strictly better than masking the real error with a cleanup one.
    }
    throw error
  }
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return index === -1 ? path : path.slice(index + 1)
}

/** Read a file as UTF-8, or `null` when it does not exist. Other errors throw. */
export function readTextSync(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

/**
 * Delete a file we previously installed. A file that is already gone is a SUCCESS,
 * not an error: the only caller is the migration that removes an older Telem
 * install, and a user who deleted it by hand first must not fail the run.
 */
export function removeFileSync(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === "ENOENT" || code === "ENOTDIR") return
    throw error
  }
}

export function existsSync(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
