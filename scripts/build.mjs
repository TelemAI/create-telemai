// Bundle the wizard to ONE file with zero runtime dependencies — the same shape
// `opencode-plugin-telem` publishes, for the same reason: `npm create @telemai`
// resolves and executes this package on a stranger's machine, and every runtime
// dependency is another thing that can fail to install, or change under us,
// between the user typing the command and the wizard running.
//
// @clack/prompts is a devDependency and gets bundled IN. It is imported
// dynamically (see src/ui.ts), which esbuild inlines here — so a non-interactive
// run still never evaluates it.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = join(root, "dist", "index.js")

// Emptied first, never merged into: `files` publishes this directory whole, so
// anything a previous build left here rides into the tarball. That is not theoretical
// — the module list this script used to write into dist/ shipped that way.
rmSync(join(root, "dist"), { recursive: true, force: true })
mkdirSync(join(root, "dist"), { recursive: true })

const result = await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // node 20 is the floor install.sh checks for and package.json declares.
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: "none",
  metafile: true,
})

chmodSync(outfile, 0o755)

// The zero-runtime-dependency claim, checked rather than asserted: every import
// left in the bundle must be a node builtin. A stray bare specifier here means the
// published package would need a `dependencies` entry it does not have, and would
// fail at `npm create` time on a user's machine rather than in CI.
//
// Two forms are scanned: static `import/export … from "x"` AND dynamic `import("x")`
// with a string-literal specifier (esbuild leaves an unbundled dynamic import as a
// literal `import("x")`; a bundled one is inlined and disappears). What this does
// NOT catch is a COMPUTED dynamic import — `import(someVariable)` — whose specifier
// is not a literal; that is a deliberate limit, not an oversight.
const bundled = readFileSync(outfile, "utf8")
const staticSpecifiers = [...bundled.matchAll(/(?:^|[\s;])(?:import|export)[^\n]*?from\s*["']([^"']+)["']/g)].map(
  (match) => match[1],
)
const dynamicSpecifiers = [...bundled.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
const externals = [...staticSpecifiers, ...dynamicSpecifiers].filter(
  (specifier) => !specifier.startsWith("node:"),
)
if (externals.length) {
  throw new Error(`bundle still imports non-builtin modules: ${[...new Set(externals)].join(", ")}`)
}

// Beside the package, never inside `dist/`: `files` publishes that directory whole,
// so a listing of every internal module path — including the sibling `config-core`
// sources — rode into the tarball at 0.1.13 and earlier. Nothing reads this; it is a
// local diagnostic, and it stays local.
const inputs = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs)
writeFileSync(
  join(root, ".build-inputs"),
  `${inputs.sort().join("\n")}\n`,
  "utf8",
)

process.stdout.write(`built ${outfile} (${(bundled.length / 1024).toFixed(1)} kB, ${inputs.length} modules)\n`)
