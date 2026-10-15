// Cutting project skills' descriptions out of Claude's skill listing, in the
// project's local settings file.
// Pure: no `$`, so tests drive it directly.

// The skillOverrides value that sends only a skill's name in Claude's listing,
// without its description. The skill stays loadable by name with the Skill tool.
export const HIDDEN = 'name-only'

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const overridesOf = (settings: unknown): Record<string, unknown> => (record(settings) && record(settings.skillOverrides) ? settings.skillOverrides : {})

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
