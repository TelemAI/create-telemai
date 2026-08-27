# @telemai/create

The guided Telem installer. One command detects which agent hosts you have,
verifies your API key, writes the unified `.telem` config every Telem surface
reads, and installs Telem into each host you pick.

```bash
npm create @telemai
```

**Node 20 or newer, and node — not bun.** `npm create @telemai` resolves to this
package (npm's rule: `npm init @usr` → `npm exec @usr/create`), and the published
bundle carries a `#!/usr/bin/env node` shebang. The prompt library this uses is
broken under Bun ([oven-sh/bun#4835](https://github.com/oven-sh/bun/issues/4835):
arrow keys stop working in a select that follows a text prompt and the terminal is
left unresponsive), so `bun x @telemai/create` is not supported even though
OpenCode itself is a Bun binary.

## What it does

1. **Detects** which of `opencode`, `claude`, `codex`, `pi`, `openclaw`, and the
   Python toolchain (`python3`/`pip`/`uv`, `telem-mcp`) are on your PATH.
2. **Asks which tools** to install into, grouped. Every tool in the catalog is
   listed, always: the ones this machine has are pre-checked and sorted first, and
   the rest keep their place with a dimmed `(not detected on this machine)`. Space
   toggles one, the group header toggles a group, and deselecting everything is a
   valid answer (you get your key and `~/.telem/telem.json` and nothing else).
3. **Takes your API key**, masked, and verifies it with one authenticated Search
   request, carrying a body the router rejects before any provider runs, so
   verification spends no search budget. It is sent to
   `POST {baseUrl}/v1/search`. Auth is resolved ahead of body validation, so
   `422`/`400`/`2xx` mean the key is good and `401`/`403` mean it is bad —
   anything else, a 404 included, is reported as `unexpected` rather than as a
   verdict on the key. (`/v1/me/*` is **not** used —
   those routes are OIDC/human-session only and reject every real `tlm_` key.)
   A key already on disk is offered first: Yes re-verifies and keeps it, No falls
   through to the paste prompt. No key yet, or the deployment unreachable? Both
   are branches, not dead ends.
4. **Offers the search defaults**, behind one `Customize search defaults?` gate
   (default No). On Yes it asks three questions — the result `tier`, the providers
   to run, and whether to fetch full page content — through the shared option
   table's own coercers, so the wizard can never write a value the readers do not
   resolve.
5. **Installs each surface** (see the table below).
6. **Summarizes** what was written, what ran, and how to undo every file it
   touched, then closes with the numbered **Next steps** (which apps to restart)
   and a verdict that reads what actually happened: done, partly done (something
   still needs you), or failed — and the exit code goes with it.

### Where things are written

| File | What | Mode |
|---|---|---|
| `~/.telem/credentials.json` | `{"apiKey", "baseUrl"}` — the ONE credential home | `0600`, in a `0700` directory |
| `~/.telem/telem.json` | your Telem options, read by every surface | `0644` |
| `<project>/.telem/telem.json` | the same, shared with the repo (offered only inside a project) | `0644` |
| `~/.config/opencode/opencode.json(c)` | `@telemai/opencode-plugin` added to the `plugin` array | unchanged |
| `~/.codex/config.toml` | `[mcp_servers.telem]` pointing at the hosted MCP, with your key in its `http_headers` Authorization line; `model_reasoning_summary = "detailed"` so Codex emits the summaries the hook captures; a `[hooks.state."…"]` entry pre-trusting the plugin's hook; plus `web_search` only if you consent | `0600` when it carries the key, otherwise unchanged |
| `~/.claude/settings.json` | `pluginConfigs["telem@telem"].options.TELEM_API_KEY` — the key the Claude Code plugin's inline MCP server reads | `0600` |

**The API key never appears on a command line and is never printed.** The
installer refuses to run a command, print an instruction, or emit a summary
containing it.

It is written to exactly **three** files, all `0600` — which of them a given run
touches depends on the surfaces you install:

- `~/.telem/credentials.json` — always: the credential home every surface falls
  back to;
- `~/.codex/config.toml` — *only* if you install Codex, as the `Authorization:
  Bearer …` header of `[mcp_servers.telem]`. The hosted Telem MCP is a remote
  server that authenticates each request, so it has no credentials.json to read;
  the key has to travel in the table. Re-runs reconcile that header with your
  current key, so rotating the key (or adding one after a keyless install) fixes
  Codex on the next run.
- `~/.claude/settings.json` — *only* if you install the Claude Code plugin, as
  `pluginConfigs["telem@telem"].options.TELEM_API_KEY`. The plugin declares a
  required `userConfig.TELEM_API_KEY` that its inline `mcpServers.telem` reads;
  a non-interactive install cannot answer that prompt, so the installer stages the
  value there instead of putting it on a command line.

The wizard names these files, by their real paths for your run, in the note it
prints just before it asks for the key.

### Per-surface steps

| `--client` | What happens |
|---|---|
| `opencode` | adds `@telemai/opencode-plugin` to the `plugin` array of `opencode.json`/`opencode.jsonc` |
| `claude-code` | `claude plugin marketplace add` + `claude plugin install telem@telem` (hosted MCP + lineage hooks; key staged into plugin config) |
| `codex` | points `[mcp_servers.telem]` in `~/.codex/config.toml` at the hosted MCP (url + auth header), then `codex plugin marketplace add TelemAI/codex-plugin` + `codex plugin add telem@telem` for the reasoning hook and the telem skill. Codex skips an untrusted plugin hook *silently* and has no CLI to trust one, so the installer also pre-grants that hook's trust in `config.toml`. An existing stdio table is left exactly as it is — the local server it starts is deprecated, and nothing rewrites a table this installer did not write; an *older hand-written* reasoning hook under `~/.codex/hooks/` is replaced only with your consent (`--codex-migrate-hooks`) — without it the plugin is not installed, because both hooks would fire on every search — and if this run *cannot* install the plugin (no `codex` on PATH, no plugin source), the old hook is left exactly as it is and the surface is reported `manual` rather than installed. `web_search = "disabled"` only with your consent. Needs no local `telem-mcp`. |
| `pi` | `pi install npm:@telemai/pi-telem` |
| `openclaw` | `openclaw plugins install npm:@telemai/openclaw-plugin --force` + `openclaw config set tools.alsoAllow` (merged with whatever it already allows, because `config set` replaces the array). The wizard owns the version gate: openclaw below `2026.7.1` cannot load the plugin and is refused rather than "installed" into. It does **not** delegate to `telem-openclaw-setup` — that is a source-checkout dev tool (`npm ci` + `--link`), and the published tarball has no lockfile for `npm ci`. |
| `claude-skill` | `telem-install-skill` |
| `mcp-json` | prints a ready-to-paste `mcpServers` snippet for the **hosted** server (`https://mcp.telem.ai/mcp` + an `Authorization: Bearer` header). Nothing local is spawned, so it needs no Python; paste your own key from `~/.telem/credentials.json` — the installer never prints it |

The Claude Skill (`claude-skill`) runs a `telem-sdk` console script, so it needs
the Python SDK — and it is the only surface that does. If it is missing, the
installer offers to install it with the first package manager it finds, in this
order: `uv tool install`, `pip3 install`, `pip install`, `python3 -m pip install`.
If you decline — or if no Python package manager exists at all, in which case it
offers to install `uv` itself (user-level, no sudo, and only with `--install-uv`
non-interactively) and the skill finishes on a re-run — it prints the command as a
manual step. `codex`, `claude-code` and `mcp-json` are **not** among them: all
three talk to the hosted MCP over https, so a run without the skill never offers
the Python install.

### Options the wizard does not ask about

`~/.telem/telem.json` supports six keys and every surface reads all six. The wizard
asks about three — `tier`, `providersInclude`, `fullContent` — because the other
three refine an answer it already has, and asking a first-run user to type a JSON
blob of raw per-provider parameters bought six screens of "leave unset":

| Key | What it does | How to set it |
|---|---|---|
| `fields` | an explicit result-field list, instead of a `tier` | edit `~/.telem/telem.json` (or `TELEM_FIELDS`) |
| `providersExclude` | drop providers from the set that would otherwise run | edit `~/.telem/telem.json` (or `TELEM_PROVIDERS_EXCLUDE`) |
| `providerOverrides` | raw per-provider request parameters | edit `~/.telem/telem.json` |

The installer never removes a key it did not ask about, so anything you set by hand
survives every re-run.

### The deployment URL

The wizard does not ask. It uses `https://router.telem.ai`, or whatever
`~/.telem/credentials.json` already records. **Given a different Telem endpoint? Pass `--base-url`** —
it is both configured and verified against.

## Flags

The flags are the non-interactive API. On a non-TTY — a pipe, `CI=true`, or
`--yes` — the wizard **never prompts**; it takes everything from flags and exits
1 with the missing ones listed if it cannot.

```
--yes, -y                     never prompt: run from flags only (still needs
                              --client or --login), and consent to the Python SDK
                              install
--client <name>               surface to install; repeatable or comma-separated
--login                       credentials only: verify a key, write it, exit
--base-url <url>              Telem deployment to configure and verify against
--key-env <VAR>               read the API key from this env var instead of prompting
--project                     also write <cwd>/.telem/telem.json
--codex-disable-web-search    also set web_search = "disabled" in Codex's config
--no-codex-reasoning          skip the Codex telem plugin and model_reasoning_summary
--codex-migrate-hooks         replace an older hand-written Codex reasoning hook
                              with the telem Codex plugin
--install-uv                  consent to the whole Python bootstrap: install
                              telem-sdk with whatever package manager is found
                              and, if none is, install uv itself (user-level, no
                              sudo). Non-interactive consent — at a terminal the
                              wizard asks. --yes consents to the first half only
--write-unverified            write a key whose verification could not be completed
                              (unreachable, 429/5xx, unexpected status); never a 401/403
--json                        machine-readable summary on stdout; implies a
                              non-interactive run (flags only, never prompts)
--dry-run                     print the staged plan; write nothing
--help, -h / --version, -V
```

Exit codes: `0` done, `1` error, `130` cancelled. A surface that failed is an
exit 1 even when no command failed (an unparseable config, an openclaw below the
version floor); a surface that still needs your hands is an exit 0 whose closing
line says "partly set up" rather than claiming success.

With `--json`, stdout carries exactly one JSON document on **every** path. A run
that produced a plan emits the summary; a run that ended before it had one — bad
flags, a missing `--client`, an unparseable config, a rejected key, a cancel —
emits `{"version", "ok": false, "error": {"code", "message", "remedy"}}`. Branch on
`ok`, and match on `error.code` rather than on `message`.

```bash
# CI / scripted (--yes is what makes it flags-only; CI=true does the same)
npm create @telemai -- --yes --client opencode --client codex --key-env TELEM_API_KEY --json

# rotate a key and nothing else
npx @telemai/create --login --key-env TELEM_API_KEY

# see the plan without touching anything
# (--yes is what makes it flags-only; an interactive --dry-run still runs the whole
#  interview, including the live key check, and ignores --client — it says so)
npx @telemai/create --yes --client opencode --key-env TELEM_API_KEY --dry-run
```

## Guarantees

- **A cancelled run writes nothing.** Every write is staged in memory and
  committed at the very end; Ctrl+C at the last question leaves the machine
  exactly as it was. `--dry-run` is the same plan without the commit.
- **Re-runs are idempotent.** Existing `telem.json`, `credentials.json`,
  `opencode.json`, and `config.toml` are read first and offered as defaults. Keys
  the installer does not manage are never touched, comments in JSONC survive, and
  a file it cannot parse **aborts with the path named** rather than being
  overwritten.
- **A failure names what it wrote.** The commit is one call at the end, but it is
  not atomic across files: if it dies part way, the epilogue lists the files that
  did land instead of claiming nothing was written.
- **Files are written create-with-mode then renamed.** `writeFileSync(…, {mode})`
  applies the mode only when it creates the file, and write-then-`chmod` leaves a
  window where a credential is world-readable; neither is used here.
- **Deprecated per-host config is reported, not migrated.** The old
  `~/.config/opencode/telem.json`, `~/.config/pi/telem.json`,
  `<project>/.opencode/telem.json` and `<project>/.pi/telem.json` files
  **outrank** the user-level `~/.telem/telem.json` the installer writes, so an
  answer one of them also sets would never take effect. The installer names the
  file and the keys it still decides. It does not move or delete them: they belong
  to the surface that shipped them.

## Alpha bootstrap (`install.sh`)

Alpha testers install through a one-liner that hands off to this wizard:

```
curl https://docs.telem.ai/install.sh | sh
    -> exec npm create @telemai
```

The script is deliberately dumb (the `rustup-init.sh` pattern): it checks node,
then `exec`s the wizard. It does no prompting of its own, writes no files, and
carries no credentials — the `@telemai` packages are public, so fetching them
needs no auth.

`docs-site/public/install.sh` (canonical) and `docs-site/public/alpha_install.sh`
(the alpha-era name, kept for links already in the wild) are hosted copies and must
stay byte-identical to the file here — edit this one, copy it over both.
`docs-site/its own suite fails the docs-site suite on any drift;
the copies did drift once, silently, before that test existed.

### Supported environments

`install.sh` is POSIX sh and must be **run by a POSIX shell**. Verified matrix:

| OS | Shell(s) | `sed` |
|---|---|---|
| macOS | `/bin/sh` (bash in POSIX mode), `dash`, `zsh` | BSD |
| Linux (Debian/Ubuntu/…) | `dash` (the distro `sh`), `bash` | GNU |
| Alpine / minimal CI images | busybox `ash` | busybox |
| Windows via **WSL**, **Git Bash**, or **MSYS2** | that environment's `sh` | GNU / busybox |

The three `sed` flavors differ in exactly the ways that bit us — none adds a
newline to a final line that lacks one, and all anchor `$` *after* a trailing
`\r` — so the script is written to be correct on all three.

**Native Windows `cmd.exe` and PowerShell are NOT supported.** They cannot execute
a POSIX shell script at all, so `install.sh` does not half-work there — it is not
theirs to run. A Windows alpha tester has two clean paths:

1. Run `install.sh` inside **WSL** or **Git Bash** (a real POSIX shell), **or**
2. Skip the bootstrap and run `npm create @telemai` directly — it is the same
   wizard, and with the packages public there is nothing to configure first.

### What the bootstrap absorbed

The wizard is the single installer; the behaviors below live here as tested
behavior rather than as shell:

- **Human error translation.** `src/errors.ts` (`translateInstallError`) and the
  POSIX twin `telem_translate_error` in `install.sh` turn misleading raw failures
  into actionable ones: an npm **E404** on a `@telemai` package is a name or
  version typo, or a `registry=` pointed at a mirror that does not proxy npmjs
  (it fires at every place a `@telemai` package is installed — the bootstrap's npm
  handoff and the wizard's per-surface installs); a
  pip/uv **"No matching distribution"** for `telem-sdk` is the Python 3.10 floor; and
  under **WSL**, an npm that resolves to a Windows install is a PATH-interop dead end.
- **Host version floor.** `src/detect.ts` (`versionAtLeast` + `MIN_OPENCLAW_VERSION`
  = `2026.7.1`) refuses to install into an openclaw too old to load the plugin. Only
  openclaw has a documented floor; the other hosts detect and proceed.
- **User-level PATH.** A just-installed node bin dir is prepended to the run's PATH
  in `install.sh`; a deferred user-level `uv` finishes its SDK surfaces on a re-run,
  which the summary states plainly. Rewriting your shell rc is **not** adopted —
  this installer's config lives in `~/.telem`, not in your shell startup files.

## Development

```bash
npm test          # node --test, no install needed (the bundle tests skip until built)
npm install       # only needed to build or typecheck
npm run build     # esbuild -> dist/index.js, one file, zero runtime deps
npm run smoke     # node dist/index.js --help
npm run typecheck # tsc --noEmit
```

The pure logic (flag parsing, the config edits, the interview, the plan) lives in
small modules with no IO; `run.ts` takes every capability it needs as a port, so
the whole flow is drivable from a test without a terminal, a network or a
filesystem. `src/ui.ts` is the only file that touches `@clack/prompts`, and it
imports it dynamically — a non-interactive run never loads it.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
