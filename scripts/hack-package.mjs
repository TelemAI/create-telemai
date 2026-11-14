// Stage `@telemai/create-event` in ./hack-package, ready for `npm pack` or `npm publish`.
//
// `npm create @telemai/event` runs `@telemai/create-event` (npm's rule: `npm init
// @usr/foo` -> `npm exec @usr/create-foo`). That package is THIS one, built with the
// `event` preset (src/preset.ts): the same sources, the same plugin copies, the Muse and
// Grok Build hooks, and a bundle whose `--base-url` and `--mcp-url` default to the
// hackathon stack. Nothing here is a second copy of the installer to keep in step.
//
// It needs `plugins/` to exist already, as `npm pack` of this package leaves it during
// prepack: the copies made by scripts/copy-plugins.mjs in the source repository, or the
// vendored ones in the published repository. A package without them would install no
// plugin on a user's machine, so their absence is an error, not a skip.
//
//   node scripts/hack-package.mjs     # then: npm publish ./hack-package

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const STAGE = join(root, "hack-package")

/** The hack package's manifest, from this package's own: same version, files and engines. */
export function hackManifest(main) {
  return {
    name: "@telemai/create-event",
    version: main.version,
    description:
      "Guided installer for Telem web search, set up for the Telem hackathon stack at hack.telem.ai: npm create @telemai/event.",
    type: main.type,
    license: main.license,
    publishConfig: { access: "public" },
    // ONE bin, named after the package's last segment, which is the bin npm exec runs.
    bin: { "create-event": "dist/index.js" },
    main: main.main,
    exports: main.exports,
    files: main.files,
    engines: main.engines,
  }
}

async function stage() {
  const main = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  if (!existsSync(join(root, "plugins"))) {
    throw new Error("plugins/ is missing: run `node scripts/copy-plugins.mjs` first")
  }
  rmSync(STAGE, { recursive: true, force: true })

  const build = spawnSync(
    process.execPath,
    [join(root, "scripts", "build.mjs"), "--preset", "event", "--outdir", join(STAGE, "dist")],
    { stdio: "inherit" },
  )
  if (build.status !== 0) throw new Error("the hack build failed")

  for (const entry of main.files) {
    if (entry === "dist" || entry === "README.md") continue
    cpSync(join(root, entry), join(STAGE, entry), { recursive: true })
  }
  cpSync(join(root, "hack", "README.md"), join(STAGE, "README.md"))
  writeFileSync(join(STAGE, "package.json"), `${JSON.stringify(hackManifest(main), null, 2)}\n`)
  await assertShippable()
  process.stdout.write(`staged @telemai/create-event ${main.version} in ${STAGE}\n`)
}

/**
 * The residue check prepack runs on `@telemai/create`'s own files (copy-plugins.mjs),
 * on the files only this package has. It runs where the redactor exists, the source
 * checkout; the published repository is scanned as it is exported, and has no redactor.
 * The plugin copies, the Muse and Grok Build files are the ones prepack already checked.
 */
async function assertShippable() {
  const redactor = join(root, "scripts", "redact-internal.mjs")
  if (!existsSync(redactor)) return
  const { assertNoResidue } = await import(pathToFileURL(redactor).href)
  for (const shipped of ["README.md", "package.json", join("dist", "index.js")]) {
    // The bundle's module labels are the builder's paths, not text we wrote (copy-plugins.mjs).
    const text = readFileSync(join(STAGE, shipped), "utf8").replace(/"[^"\n]*node_modules\/[^"\n]*"/g, '""')
    assertNoResidue(text, `hack-package/${shipped}`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await stage()
