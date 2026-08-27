# codex-plugin-telem

A **Codex CLI** plugin carrying the two model-facing pieces of the Telem Codex
integration:

1. **A PreToolUse hook** (`hooks/telem-reasoning.mjs`) that attaches this call's query
   lineage, so a session's searches stay connected rather than reading as unrelated
   queries.
2. **The `telem` skill** (`skills/telem/SKILL.md`) restating, for the model, that
   Telem is the preferred web-search tool and how one Telem session maps to one user
   goal. Codex namespaces it as `telem:telem`.

## Install

The guided installer is the quickest path — it configures the plugin and captures
your API key from [app.telem.ai](https://app.telem.ai) in one pass:

```bash
npm create @telemai
```

Pick **Codex** when it asks, or skip the interview entirely:

```bash
npm create @telemai -- --client codex
```

### By hand

```sh
codex plugin marketplace add TelemAI/codex-plugin
codex plugin add telem@telem
```

## Hook trust

Every plugin hook starts `untrusted` and is **silently skipped** until it is trusted —
a silent no-op is the default failure mode. Trust is per hook entry, recorded in
`$CODEX_HOME/config.toml` as

```toml
[hooks.state."telem@telem:hooks/hooks.json:pre_tool_use:0:0"]
enabled = true
trusted_hash = "sha256:…"
```

The hash is over a normalized identity — event name, matcher, and the handler with its
**raw, unexpanded** command — so it depends only on this package's `hooks/hooks.json`
and is identical on every machine. `create-telemai` computes it and pre-grants trust
during install (see `create-telemai/src/codex-plugin.ts`); trusting through Codex's
`/plugin` UI is the manual equivalent. Editing `hooks/hooks.json` changes the hash and
revokes trust, which is the point.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
