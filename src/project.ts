// "Is this cwd a project?" — the cheap heuristic behind offering a project-level
// `.telem/telem.json` (spec: "offers the project file only inside a project").
//
// Cheap on purpose: a wrong answer costs one skipped question, and the wizard ASKS
// before writing either way. What it must not do is offer to commit a config file
// into a directory that is not a repository, or into the user's home directory,
// where a project file would silently outrank their user config in every project
// they ever open below it.

export const PROJECT_MARKERS: readonly string[] = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  ".hg",
]

export type ProjectGuess = { root: string; marker: string } | null

export function findProjectRoot(
  cwd: string,
  exists: (path: string) => boolean,
  options: { home?: string; join: (...parts: string[]) => string; dirname: (path: string) => string },
): ProjectGuess {
  const home = options.home ? normalize(options.home) : undefined
  let current = normalize(cwd)
  for (let depth = 0; depth < 64; depth += 1) {
    // The home directory is never a project: a `.telem/telem.json` there would be
    // a second user-level file outranking the real one from every subdirectory.
    if (!home || current !== home) {
      for (const marker of PROJECT_MARKERS) {
        if (exists(options.join(current, marker))) return { root: current, marker }
      }
    }
    const parent = normalize(options.dirname(current))
    if (parent === current) return null
    if (home && current === home) return null
    current = parent
  }
  return null
}

function normalize(path: string): string {
  return path.length > 1 && (path.endsWith("/") || path.endsWith("\\")) ? path.slice(0, -1) : path
}
