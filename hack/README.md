# @telemai/create-hack

The Telem installer, set up for the Telem hackathon stack at `https://hack.telem.ai`.

```bash
npm create @telemai/hack
```

It is the same installer as [`@telemai/create`](https://www.npmjs.com/package/@telemai/create),
built from the same source, with different defaults:

| Setting | Default here | Default in `@telemai/create` |
| --- | --- | --- |
| `--base-url` (the API) | `https://hack.telem.ai/api` | `https://router.telem.ai` |
| `--mcp-url` (the MCP server) | `https://hack.telem.ai/mcp` | `https://mcp.telem.ai/mcp` |
| Console, for a new key | `https://hack.telem.ai` | `https://app.telem.ai` |

A flag that you pass still wins. The installer saves the addresses in
`~/.telem/credentials.json`: a later run keeps them, and the Python and JavaScript
SDKs read the API address from there.

Node 20 or later, and node, not bun. On Windows PowerShell, use
`npx @telemai/create-hack`. Run it with `--help` for every flag.

The hackathon docs are at <https://hack.telem.ai/doc>.
