#!/bin/sh
# Telem bootstrap — fetches the installer and hands off to it.
#
# ---------------------------------------------------------------------------
# WHAT THIS IS
#
#   curl -fsSL https://docs.telem.ai/install.sh | sh
#   (https://docs.telem.ai/alpha_install.sh serves the same bytes — the alpha-era
#   name, kept so links already in the wild keep working)
#       -> exec npm create @telemai      # the installer, which does the real work
#
# It carries no credentials. The @telemai packages are public, so npm needs no
# auth to fetch them and this script writes nothing to ~/.npmrc. (It used to: while
# the packages were private, an alpha read token rode in a hosted copy of this file
# and was written into the user's npm config. Both are gone — the token bought
# nothing once the packages went public, and a credential left in someone's global
# npm config is a cost they keep paying.)
#
# Everything interactive lives in the installer, not here — the rustup-init.sh
# shape: a bootstrap that acquires a runtime and gets out of the way.
#
# ---------------------------------------------------------------------------
# SUPPORTED ENVIRONMENTS
#
# This is a POSIX sh script and it must be RUN by a POSIX shell. Verified matrix:
#
#   OS               shell(s)                          sed
#   macOS            /bin/sh (bash-posix), dash, zsh   BSD sed
#   Linux            dash (Debian/Ubuntu `sh`), bash   GNU sed
#   Alpine / CI      busybox ash                       busybox sed
#   Windows (WSL,    the distro's / MSYS2's sh         GNU / busybox sed
#     Git Bash, MSYS2)
#
# NODE — offered, never forced, never sudo. When node is missing or too old this
# script ASKS (on /dev/tty, the `curl | sh` idiom) whether to install it, and on yes
# installs a USER-LEVEL version manager into $HOME (fnm, nvm as a fallback) and the
# pinned node major, then continues into the installer in the same run. It never
# touches the system node and never runs a package manager with sudo. Declining (or
# having no terminal to ask on, e.g. CI) prints how to install node and re-run — it
# is a guided exit, not a silent one. This is the ONLY interactive step the
# bootstrap carries; uv/python are handled the same way by the installer once node
# exists.
#
# NOT SUPPORTED — native Windows `cmd.exe` and PowerShell. They cannot execute POSIX
# shell syntax at all, so this script does not "half-run" there; it simply is not
# theirs to run. A Windows user has two clean paths:
#   * run this script inside WSL or Git Bash (a real POSIX shell), OR
#   * skip the bootstrap and run `npm create @telemai` directly — the same
#     installer this script hands to.
# ---------------------------------------------------------------------------

set -eu

TELEM_MIN_NODE=20

telem_die() {
  printf '%s\n' "$*" >&2
  exit 1
}

telem_note() {
  printf '%s\n' "$*" >&2
}

# Translate a raw failure into an actionable message — the POSIX twin of the wizard's
# translateInstallError (absorbed from the wizard's translate_error). The two failures the
# The one npm failure worth translating: a bare E404 says nothing a user can act
# on, so name the two causes that actually produce it.
telem_translate_error() {
  telem_te_context="$1"
  telem_te_raw="${2:-}"
  case "$telem_te_context" in
    npm)
      case "$telem_te_raw" in
        *E404* | *"404 Not Found"*)
          printf '%s\n' "npm could not find the package. The @telemai packages are public on registry.npmjs.org, so this is normally either a typo in the package name or version, or an npm registry= setting pointing at a mirror that does not proxy npmjs."
          ;;
        *)
          printf 'npm failed: %s\n' "$telem_te_raw"
          ;;
      esac
      ;;
    wsl-npm)
      printf '%s\n' "npm resolves to a Windows install (${telem_te_raw}). Under WSL, PATH interop puts Windows npm first, and plugins would install into a Windows profile the Linux-side agent cannot load. Install Node inside your WSL distro, or remove the Windows entries from PATH."
      ;;
    *)
      printf '%s\n' "$telem_te_raw"
      ;;
  esac
}

# --- node: detect, and (new) offer a user-level install when missing/old --------
#
# Node is handled the SAME way the wizard handles uv/python: detect →
# explain → ASK "install it for you?" → yes: a USER-LEVEL manager in $HOME (fnm, nvm
# as a fallback), never sudo, never the system node, then continue into the wizard in
# the SAME run; no (or no terminal to ask on): print how to install it and re-run.

# Ask a yes/no question. yes -> 0, no -> 1. The answer is read from /dev/tty because
# under `curl | sh` stdin is the pipe, not the keyboard. It NEVER hangs: with no
# controlling terminal (CI, a pipe with no tty) it answers "no". Tests bypass the
# terminal entirely with TELEM_ASSUME_YES / TELEM_ASSUME_NO so the ask arm runs with
# no tty and no network.
#
# The /dev/tty open is probed inside a SUBSHELL first — `( exec </dev/tty )` — for the
# exact dash reason spelled out at the handoff below: a redirection failure on a
# simple command is fatal in a non-interactive POSIX shell and would kill the whole
# script, so the device must be confirmed openable before we read from it.
telem_ask() {
  if [ -n "${TELEM_ASSUME_YES:-}" ]; then return 0; fi
  if [ -n "${TELEM_ASSUME_NO:-}" ]; then return 1; fi
  ( exec </dev/tty ) 2>/dev/null || return 1
  printf '%s [Y/n] ' "$1" >&2
  telem_reply=''
  read telem_reply </dev/tty || return 1
  case "$telem_reply" in
    '' | [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# Return 0 when a node >= TELEM_MIN_NODE is on PATH; otherwise set telem_node_problem
# to a one-line explanation and return non-zero. It has no side effects, so it is safe
# to call again after an install attempt to re-check.
telem_node_ok() {
  telem_node_problem=''
  if ! command -v node >/dev/null 2>&1; then
    telem_node_problem="node is required (>= ${TELEM_MIN_NODE}) and was not found on PATH."
    return 1
  fi
  telem_node_version=$(node -v 2>/dev/null || echo "")
  telem_node_major=$(printf '%s' "$telem_node_version" | sed -e 's/^v//' -e 's/[^0-9].*$//')
  case "$telem_node_major" in
    '' | *[!0-9]*)
      telem_node_problem="could not read a version from \`node -v\` (got '${telem_node_version}')."
      return 1
      ;;
  esac
  if [ "$telem_node_major" -lt "$TELEM_MIN_NODE" ]; then
    telem_node_problem="node ${TELEM_MIN_NODE} or newer is required; found ${telem_node_version}."
    return 1
  fi
  return 0
}

# Bootstrap a user-level node manager and make `node` resolvable in THIS process.
# Every step is best-effort: the post-install telem_node_ok is the real gate, so a
# missing fnm or a failed `fnm install` degrades to the guidance path rather than
# aborting mid-script under `set -e`. TELEM_NODE_INSTALL_CMD overrides the network
# bootstrap so the multi-sh + docker matrix can exercise this arm with a stub that
# drops a fake node on PATH — no network. Unset (the real default), it runs fnm.
telem_install_node() {
  telem_note "installing node ${TELEM_MIN_NODE} at user level (no sudo)…"
  if [ -n "${TELEM_NODE_INSTALL_CMD:-}" ]; then
    eval "$TELEM_NODE_INSTALL_CMD" || telem_note "the node install command exited non-zero."
  else
    if ! (curl -fsSL https://fnm.vercel.app/install | bash) 1>&2; then
      telem_note "fnm bootstrap failed; trying nvm…"
      (curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash) 1>&2 || :
    fi
  fi
  telem_activate_node
}

# Put a freshly-installed manager's node on PATH for the rest of THIS run, so the
# wizard starts without the user reopening their shell. Best-effort and silent when
# no manager is present — e.g. the test stub, which already dropped node on PATH, so
# neither branch fires and telem_node_ok simply finds it.
telem_activate_node() {
  telem_fnm_dir="${XDG_DATA_HOME:-${HOME:-}/.local/share}/fnm"
  if [ -x "${telem_fnm_dir}/fnm" ]; then
    PATH="${telem_fnm_dir}:${PATH}"
    export PATH
    FNM_DIR="${telem_fnm_dir}"
    export FNM_DIR
    fnm install "${TELEM_MIN_NODE}" 1>&2 || :
    eval "$(fnm env 2>/dev/null)" || :
    fnm use "${TELEM_MIN_NODE}" 1>&2 || :
  fi
  telem_nvm_dir="${NVM_DIR:-${HOME:-}/.nvm}"
  if [ -s "${telem_nvm_dir}/nvm.sh" ]; then
    NVM_DIR="${telem_nvm_dir}"
    export NVM_DIR
    . "${telem_nvm_dir}/nvm.sh" >/dev/null 2>&1 || :
    nvm install "${TELEM_MIN_NODE}" >/dev/null 2>&1 || :
    nvm use "${TELEM_MIN_NODE}" >/dev/null 2>&1 || :
  fi
  return 0
}

telem_require_node() {
  if ! telem_node_ok; then
    telem_note "$telem_node_problem"
    if telem_ask "Install node ${TELEM_MIN_NODE} for you? (user-level, no sudo)"; then
      telem_install_node
      if ! telem_node_ok; then
        telem_die "node ${TELEM_MIN_NODE} or newer is still not available after the install attempt.
Install it yourself from https://nodejs.org/ or with a user-level manager:
  curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${TELEM_MIN_NODE}
then re-run this script."
      fi
      telem_note "node ${telem_node_version} is ready; continuing."
    else
      telem_die "node ${TELEM_MIN_NODE} or newer is required.
Install it from https://nodejs.org/ or with a user-level manager like fnm:
  curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${TELEM_MIN_NODE}
then re-run this script."
    fi
  fi
  if ! command -v npm >/dev/null 2>&1; then
    telem_die "npm is required and was not found on PATH (it normally ships with node)."
  fi
}

# WSL PATH-interop guard (absorbed from the wizard's wsl-npm case). Under WSL, PATH interop
# can put the Windows npm.exe first, so `npm` resolves to a /mnt/<drive>/ mount (or a
# native Windows path). Plugins would then install into a Windows profile the
# Linux-side agent cannot load — a dead end that reads like a plain install. Name it
# and stop before writing anything or handing off. On a normal Linux/macOS npm the
# path matches none of these and this is a silent no-op.
telem_check_wsl_npm() {
  telem_npm_path=$(command -v npm 2>/dev/null || echo "")
  case "$telem_npm_path" in
    */mnt/[A-Za-z]/* | *\\*)
      telem_die "$(telem_translate_error wsl-npm "$telem_npm_path")"
      ;;
  esac
}

# Non-interactive handoff. Reached only when there is NO controlling terminal at all
# (CI, a bare pipe): the interactive paths `exec` so clack inherits the real terminal,
# and an exec'd process's output cannot be inspected. Here there is no clack UI to
# preserve, so we CAPTURE npm's output — a 404 fetching the wizard package is a name
# or version that does not exist, or a registry that does not proxy npmjs, and the raw
# resolver dump says neither. We print npm's
# own output, append the translation when it 404s, and exit with npm's status. The
# `&& ok || status=$?` idiom keeps a non-zero npm from tripping `set -e` on the capture.
telem_handoff() {
  telem_ho_out=$(npm create @telemai@latest -- "$@" 2>&1) && telem_ho_status=0 || telem_ho_status=$?
  printf '%s\n' "$telem_ho_out"
  if [ "$telem_ho_status" -ne 0 ]; then
    case "$telem_ho_out" in
      *E404* | *"404 Not Found"*)
        telem_note ""
        telem_note "$(telem_translate_error npm "$telem_ho_out")"
        ;;
    esac
  fi
  return "$telem_ho_status"
}

telem_require_node
telem_check_wsl_npm

# Hand off to the wizard and do no prompting of our own — the rustup-init.sh
# pattern: the shell script is a bootstrap, all interactivity lives in the richer
# runtime. `npm create @telemai@latest` resolves to `@telemai/create@latest`
# (verified against the registry), and `--` passes our arguments through to it.
#
# curl | sh gives this script a PIPE as stdin, which the wizard would correctly
# read as "not a terminal" and drop into flags-only mode. When a controlling
# terminal exists we hand the wizard THAT instead, so the interactive path works
# through the one-liner; when it does not (CI), we fall through and the wizard's
# own no-TTY guard takes over.
#
# The test is an actual OPEN of /dev/tty, not `[ -r /dev/tty ]`: the device node
# exists and its permission bits look readable even in a process with no
# controlling terminal, where opening it fails with ENXIO. Testing the bits would
# make every CI run die on a failed redirect instead of falling through.
#
# The open is done in a SUBSHELL — `( exec </dev/tty )` — not a brace group. In a
# POSIX shell (dash, i.e. `sh` on most Linux/CI), a redirection failure in a
# NON-interactive shell is fatal: it exits the whole script, and neither
# `2>/dev/null` nor being inside an `if` condition contains it. A subshell scopes
# that fatal exit to the subshell, so a missing /dev/tty reads here as a plain
# non-zero (false) and we fall through instead of the whole bootstrap dying. bash
# is lenient about this, which is exactly why the brace-group form passed under
# `sh`=bash and died under `sh`=dash.
if [ ! -t 0 ] && ( exec </dev/tty ) 2>/dev/null; then
  exec npm create @telemai@latest -- "$@" </dev/tty
fi
# A real terminal on stdin (someone ran `sh install.sh` directly, not through a pipe):
# the wizard should be interactive, so exec and let clack inherit the terminal. Like
# the /dev/tty branch, an exec'd process's output is not inspectable — that is fine,
# the wizard translates its OWN per-surface npm errors.
if [ -t 0 ]; then
  exec npm create @telemai@latest -- "$@"
fi
# No terminal anywhere (CI, piped with no /dev/tty): safe to capture and translate an
# E404. telem_handoff exits with npm's status, so `set -e` propagates a real failure.
telem_handoff "$@"
