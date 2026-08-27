# claude-plugin-telem

Telem web search and page fetch for [Claude Code](https://claude.com/claude-code) —
one query fans out across multiple search providers and comes back as one normalized,
provider-attributed result set.

## Install

The guided installer is the quickest path — it configures the plugin and captures
your API key from [app.telem.ai](https://app.telem.ai) in one pass:

```bash
npm create @telemai
```

Pick **Claude Code** when it asks, or skip the interview entirely:

```bash
npm create @telemai -- --client claude-code
```

### By hand

The plugin ships its own single-plugin `.claude-plugin/marketplace.json`, so it installs
non-interactively straight from the repository:

```bash
claude plugin marketplace add TelemAI/claude-plugin
claude plugin install telem@telem
```

The `create-telemai` installer does this for you and captures your `TELEM_API_KEY` into
the plugin's `userConfig` (never on argv). `TELEM_API_KEY` is stored **inside the Claude
config directory** (a non-`sensitive` `userConfig`, same plaintext exposure as the
`~/.telem/credentials.json` the SDK already relies on) rather than the OS keychain — so
an isolated `CLAUDE_CONFIG_DIR` stays fully self-contained and running the plugin never
pollutes your real keychain.

Verify it connected:

```bash
claude mcp list   # telem should appear, connected via the plugin
```

## Config resolution

The hosted server has no cwd and no access to your filesystem — so **the hook carries
your config to it**: on every
`telem_search`/`telem_fetch` call, `readConfigOptions` resolves project
`<cwd>/.telem/telem.json` > `~/.telem/telem.json` > `TELEM_*` env through the vendored
config-core reader (`hooks/telem-config.mjs` — one of the five copies of the
composition rules; change one, change all five), composes the V2 `search` block, and
ships it as the lineage envelope's `options`. The server validates it against a closed
whitelist and forwards it as the request's `search` block.

Two v1 limits: `provider_overrides` does not ride this channel (stripped with a stderr
warning), and the composed block caps at 4 KB. Config failures are fail-open — they
cost the options, never the lineage, never the call.

## Tool preference

A Claude Code plugin's `settings.json` cannot ship `permissions.deny`, so this plugin
does **not** disable Claude's builtin `WebSearch`. Tool preference is carried two ways
instead: the tool descriptions themselves and the bundled `skills/telem/SKILL.md`.
Disabling the builtin `WebSearch` (a `permissions.deny` write) is a separate,
consent-gated step owned by `create-telemai`, not this plugin.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
