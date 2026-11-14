// The public check for the installer.
//
// Two things can break here and only one of them is a build error. The CLI has to run —
// `--help` exercises the flag parser and the no-TTY path without touching a filesystem
// or a network. And the two marketplace plugins have to be PRESENT: this package
// installs them from `plugins/` inside itself, and in the monorepo that directory is
// produced at pack time from sibling checkouts which do not exist here. If the export
// ever stops vendoring them, every plugin install a user attempts fails with a path
// they do not have — silently, and only on their machine.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

const help = execFileSync(process.execPath, ["dist/index.js", "--help"], { encoding: "utf8" })
assert.match(help, /telemai|telem/i, "--help printed nothing recognisable")

for (const manifest of [
  "plugins/claude-plugin-telem/.claude-plugin/plugin.json",
  "plugins/codex-plugin-telem/.codex-plugin/plugin.json",
]) {
  assert.ok(existsSync(manifest), `${manifest} is missing — the packaged plugin copy did not travel`)
}

// @telemai/create-hack, when it has been staged (scripts/hack-package.mjs): the same
// checks, and its defaults are the hackathon stack's.
if (existsSync("hack-package")) {
  const hackHelp = execFileSync(process.execPath, ["hack-package/dist/index.js", "--help"], { encoding: "utf8" })
  assert.match(hackHelp, /sets up https:\/\/hack\.telem\.ai\/api/, "the hack build does not default to the hack stack")
  for (const manifest of [
    "hack-package/plugins/claude-plugin-telem/.claude-plugin/plugin.json",
    "hack-package/plugins/codex-plugin-telem/.codex-plugin/plugin.json",
  ]) {
    assert.ok(existsSync(manifest), `${manifest} is missing from @telemai/create-hack`)
  }
  console.log("ok: @telemai/create-hack runs with the hack defaults, and carries both plugins")
}

console.log("ok: @telemai/create runs, and both marketplace plugins are packaged")
