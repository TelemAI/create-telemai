// Human error translation: the raw failures these commands emit actively mislead —
// a 404 that is really a wrong name, a wrong version or a registry that does not
// proxy npmjs, and a "No matching distribution found" that is really a Python version
// floor. We name the real cause instead of dumping the resolver trace at the user.
//
// This is the wizard-side helper. install.sh carries its POSIX twin
// (`telem_translate_error`) for the two failures the bootstrap itself can hit (npm
// E404 fetching the wizard package, and WSL resolving npm to a Windows install).
// One helper per side, not scattered inline strings, so every message has one home.

import { MIN_OPENCLAW_VERSION } from "./detect.ts"

export type InstallErrorContext = "npm" | "python" | "openclaw-version"

/**
 * Map a raw tool failure to an actionable message, or `null` when nothing known
 * matches — in which case the caller keeps its generic "<cmd> exited N" detail, so an
 * unrelated failure is never mislabeled. `openclaw-version` is the exception: it is
 * only ever called once the floor check has already failed, so it always returns a
 * message (the caller passes the offending version as `raw`).
 */
export function translateInstallError(context: InstallErrorContext, raw: string): string | null {
  const text = raw ?? ""
  switch (context) {
    case "npm":
      // While the packages were private an E404 meant "no read grant", and this
      // translated it into a request-an-invite message. They are public now, so
      // that answer is a dead end: the real causes are a wrong name/version or a
      // registry mirror that does not proxy npmjs.
      if (/E404|404 Not Found/i.test(text)) {
        return (
          "npm could not find the package. The @telemai packages are public on " +
          "registry.npmjs.org, so this is normally either a typo in the package name or " +
          "version, or an npm `registry=` pointing at a mirror that does not proxy npmjs."
        )
      }
      return null
    case "python":
      // pip/uv close a Python-floor failure with "No matching distribution found",
      // which reads as "the package does not exist" rather than "your Python is too old".
      if (/No matching distribution found|Could not find a version that satisfies/i.test(text)) {
        return (
          'telem-sdk needs Python 3.10 or newer. pip/uv report this as "No matching distribution ' +
          'found", which reads as "the package does not exist" — it is a version floor, not a ' +
          "missing package. Install Python 3.10+ (e.g. `uv python install 3.10`) and re-run."
        )
      }
      return null
    case "openclaw-version":
      return (
        `openclaw ${MIN_OPENCLAW_VERSION} or newer is required to load the Telem plugin ` +
        `(found ${text || "an unreadable version"}). Update openclaw and re-run.`
      )
  }
}
