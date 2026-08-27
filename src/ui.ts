// The clack layer, kept deliberately thin.
//
// Two things make this file worth existing rather than calling clack inline:
//
//  1. `@clack/prompts` is imported DYNAMICALLY, from here only. A non-interactive
//     run never calls `loadClackUi`, so clack is never even loaded — which is the
//     strongest possible form of "no clack call ever fires on a non-TTY". (clack
//     documents nothing about TTYs and simply blocks forever; openclaw8 and
//     pi are both that bug, filed against two of our own hosts.) It also
//     keeps `node --test` zero-install: the tests import the pure modules and the
//     CLI's flag path without ever resolving a devDependency.
//  2. `isCancel` is handled in ONE place. clack's cancel model is opt-in per
//     prompt — miss it once and the cancel symbol flows onward as if it were an
//     answer, which for an installer means a half-written config. Here every
//     prompt goes through `guard`, so cancelling ANY prompt throws
//     `CancelledError`, which unwinds before the plan is ever committed.

export class CancelledError extends Error {}

export function isCancelledError(error: unknown): boolean {
  return error instanceof CancelledError
}

export type SelectOption = { value: string; label: string; hint?: string }
export type OptionGroups = Record<string, SelectOption[]>

export type Ui = {
  intro: (text: string) => void
  outro: (text: string) => void
  note: (text: string, title?: string) => void
  info: (text: string) => void
  warn: (text: string) => void
  error: (text: string) => void
  success: (text: string) => void
  text: (options: {
    message: string
    placeholder?: string
    initialValue?: string
    validate?: (value: string) => string | undefined
  }) => Promise<string>
  password: (options: { message: string }) => Promise<string>
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<boolean>
  select: (options: {
    message: string
    options: SelectOption[]
    initialValue?: string
  }) => Promise<string>
  multiselect: (options: {
    message: string
    options: SelectOption[]
    initialValues?: string[]
    required?: boolean
  }) => Promise<string[]>
  groupMultiselect: (options: {
    message: string
    options: OptionGroups
    initialValues?: string[]
    required?: boolean
  }) => Promise<string[]>
  /**
   * The three moments the wizard blocks on something slow — probing PATH, checking
   * the key against the deployment, running an install — used to be silence. A
   * spinner is the only prompt-free way to say "this is working, not hung".
   */
  spinner: () => Spinner
}

export type Spinner = {
  start: (message?: string) => void
  stop: (message?: string) => void
}

type ClackModule = {
  intro: (text: string) => void
  outro: (text: string) => void
  note: (text: string, title?: string) => void
  log: { info: (t: string) => void; warn: (t: string) => void; error: (t: string) => void; success: (t: string) => void }
  isCancel: (value: unknown) => boolean
  text: (options: unknown) => Promise<unknown>
  password: (options: unknown) => Promise<unknown>
  confirm: (options: unknown) => Promise<unknown>
  select: (options: unknown) => Promise<unknown>
  multiselect: (options: unknown) => Promise<unknown>
  groupMultiselect: (options: unknown) => Promise<unknown>
  spinner: () => { start: (message?: string) => void; stop: (message?: string) => void }
}

export async function loadClackUi(): Promise<Ui> {
  const clack = (await import("@clack/prompts")) as unknown as ClackModule

  async function guard<T>(promise: Promise<unknown>): Promise<T> {
    const value = await promise
    if (clack.isCancel(value)) throw new CancelledError("cancelled")
    return value as T
  }

  return {
    intro: (text) => clack.intro(text),
    outro: (text) => clack.outro(text),
    note: (text, title) => clack.note(text, title),
    info: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    error: (text) => clack.log.error(text),
    success: (text) => clack.log.success(text),
    text: (options) => guard<string>(clack.text(options)),
    password: (options) => guard<string>(clack.password(options)),
    confirm: (options) => guard<boolean>(clack.confirm(options)),
    select: (options) => guard<string>(clack.select(options)),
    multiselect: (options) => guard<string[]>(clack.multiselect(options)),
    groupMultiselect: (options) => guard<string[]>(clack.groupMultiselect(options)),
    spinner: () => clack.spinner(),
  }
}
