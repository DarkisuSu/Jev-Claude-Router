// Trimming Claude's skill listing in the project's local settings file: cut every
// listed description to DESC_CAP characters, and cut the project's own skills to
// a name. Jev's hint then carries the full description of the few skills it kept.
// Pure: no `$`, so tests drive it directly.

// The skillListingMaxDescChars value `/jev-skills opt` writes: Claude Code cuts
// each listed description (project, plugin, synced and built-in skills alike) to
// this many characters.
export const DESC_CAP = 100

// The skillOverrides value that sends only a skill's name in Claude's listing,
// without its description. The skill stays loadable by name with the Skill tool.
export const HIDDEN = 'name-only'

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const overridesOf = (settings: unknown): Record<string, unknown> => (record(settings) && record(settings.skillOverrides) ? settings.skillOverrides : {})

export const capOf = (settings: unknown): number | undefined =>
  record(settings) && typeof settings.skillListingMaxDescChars === 'number' ? settings.skillListingMaxDescChars : undefined

// The skills this router cut to a name (the one value it writes).
export const hiddenNames = (settings: unknown): string[] =>
  Object.entries(overridesOf(settings)).filter(([, v]) => v === HIDDEN).map(([k]) => k)

// The settings with `names` cut to a name or listed in full again. Only the skillOverrides key
// changes; a skill the person set to another value is left alone, and so is
// every other key.
export const applyHide = (settings: unknown, names: readonly string[], mode: 'hide' | 'show'): { settings: Record<string, unknown>; changed: string[]; skipped: string[] } => {
  const base: Record<string, unknown> = record(settings) ? { ...settings } : {}
  const overrides = { ...overridesOf(settings) }
  const changed: string[] = []
  const skipped: string[] = []
  for (const name of names) {
    const current = overrides[name]
    if (mode === 'hide') {
      if (current === HIDDEN) continue
      // Another value is the person's own choice: not replaced.
      if (current !== undefined) { skipped.push(name); continue }
      overrides[name] = HIDDEN
      changed.push(name)
    } else if (current === HIDDEN) {
      delete overrides[name]
      changed.push(name)
    } else if (current !== undefined) {
      skipped.push(name)
    }
  }
  if (Object.keys(overrides).length > 0) base.skillOverrides = overrides
  else delete base.skillOverrides
  return { settings: base, changed, skipped }
}

// `/jev-skills opt` (on) and `opt off`. On: the descriptions are capped, unless a
// cap is already set (in these settings or in the user's, `inherited`), and the
// named skills are cut to a name. Off: takes back only what on writes, the cap
// when it is DESC_CAP and the skills set to name-only. Nothing else changes.
export const applyOpt = (settings: unknown, names: readonly string[], on: boolean, inherited?: number): { settings: Record<string, unknown>; cap: boolean; changed: string[]; skipped: string[] } => {
  const hid = applyHide(settings, names, on ? 'hide' : 'show')
  const next = hid.settings
  let cap = false
  if (on && capOf(next) === undefined && inherited === undefined) {
    next.skillListingMaxDescChars = DESC_CAP
    cap = true
  } else if (!on && capOf(next) === DESC_CAP) {
    delete next.skillListingMaxDescChars
    cap = true
  }
  return { settings: next, cap, changed: hid.changed, skipped: hid.skipped }
}
