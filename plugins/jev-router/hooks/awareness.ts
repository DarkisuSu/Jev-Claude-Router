// Bounded conversation evidence and resource facts, never a model-generated
// summary. No tools, credentials, headers or persisted transcript content.
import { cacheEvidence, type CacheConfig, type CacheState } from './cache'
import { FAMILIES, type Caps, type Family, type Step } from './model'

// What the request and the excerpts may total, in characters. Jev 1.13 takes
// 32k tokens for the state plus its longest question; a character can be a
// whole token (CJK, code), and the longest question (the skills, a long saved
// tool list) takes a share, so the state is kept to 24k characters and the
// rest of the 32k is left to it. A reserve covers the routing facts.
export const STATE_CHAR_BUDGET = 24000
export const STATE_RESERVE = 3000

export type AwarenessConfig = { enabled: boolean; maxChars: number; messages: number }
export type MessageLike = { role?: unknown; text?: unknown; toolUses?: unknown; toolResults?: unknown; agentId?: unknown; type?: unknown }
export type RecentContext = { text: string; messages: number; source: 'session-excerpts' | 'unavailable' | 'disabled'; truncated: boolean }
export type AttemptFacts = { modelRequestFailed: boolean; toolFailures: number; deniedTools: number; correctness: 'unknown' }
export const EMPTY_ATTEMPT: AttemptFacts = { modelRequestFailed: false, toolFailures: 0, deniedTools: 0, correctness: 'unknown' }

export const scrubText = (text: string, secrets: readonly string[] = []): string => {
  let result = text
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]')
  return result
    .replace(/<skill_(?:instructions|relevance)\b[^>]*>[\s\S]*?<\/skill_(?:instructions|relevance)>/gi, '[skill content omitted]')
    .replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+\/-]+)/gi, '[redacted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)\s*["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

// A long message keeps its start and its end: an answer's conclusion is
// usually in the last lines.
const clip = (line: string, max: number) => {
  if (line.length <= max) return line
  if (max <= 40) return line.slice(0, max)
  const head = Math.ceil(max * 0.6)
  return `${line.slice(0, head)} … ${line.slice(line.length - (max - head - 3))}`
}

export const recentContext = (messages: readonly MessageLike[] | undefined, request: string, config: AwarenessConfig, secrets: readonly string[] = []): RecentContext => {
  if (!config.enabled || config.maxChars === 0) return { text: '', messages: 0, source: 'disabled', truncated: false }
  if (!messages) return { text: '', messages: 0, source: 'unavailable', truncated: false }
  const rows = messages.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && !(m.role === 'user' && m.text.trimStart().startsWith('/')) && !m.text.trimStart().startsWith('jev-router:') && m.agentId === undefined && (m.type === undefined || m.type === 'message') && (!Array.isArray(m.toolUses) || m.toolUses.length === 0) && (!Array.isArray(m.toolResults) || m.toolResults.length === 0))
  // Some hosts append the current prompt before prompt.submit. Exclude only
  // its last matching user row, not older identical prompts in a task.
  const last = rows.at(-1)
  if (last?.role === 'user' && (last.text as string).trim() === request.trim()) rows.pop()
  const selected = rows.slice(-config.messages)
  const items = selected
    .map(row => ({ line: `${row.role}: ${scrubText(row.text as string, secrets).trim()}`, empty: scrubText(row.text as string, secrets).trim() === '' }))
    .filter(item => !item.empty)
  // Spend the whole budget: short messages keep all of theirs and the rest is
  // shared among the long ones, shortest first.
  let budget = Math.max(0, config.maxChars - Math.max(0, items.length - 1))
  const allotted: number[] = []
  let left = items.length
  for (const index of items.map((_, i) => i).sort((x, y) => items[x]!.line.length - items[y]!.line.length)) {
    const share = Math.floor(budget / left)
    allotted[index] = Math.min(items[index]!.line.length, Math.max(1, share))
    budget -= allotted[index]!
    left--
  }
  let truncated = rows.length > selected.length
  const lines = items.map((item, i) => {
    truncated ||= allotted[i]! < item.line.length
    return clip(item.line, allotted[i]!)
  })
  const text = lines.join('\n').slice(0, config.maxChars)
  return { text, messages: lines.length, source: 'session-excerpts', truncated }
}

// The facts Jev judges each tier and effort with. Costs are not here: the
// router costs every pair itself and takes the cheapest feasible one.
export const routingFacts = (state: CacheState, current: Step | undefined, caps: Caps | undefined, failed: ReadonlySet<Family>, attempt: AttemptFacts | undefined, now: number, cache: CacheConfig, windows: Partial<Record<Family, number>> = {}, currentSource: 'last-response' | 'session-model' = 'last-response') => {
  const evidence = cacheEvidence(state, now, cache)
  // What each tier is known to hold. Evidence only: a tier never seen on a
  // context this large may still hold it, and no window is assumed.
  const capacity: Record<string, unknown> = {}
  for (const family of FAMILIES) {
    const known = caps?.families[family]
    capacity[family] = {
      largest_context_answered: known?.maxContext ?? null,
      context_window_reported: windows[family] ?? null,
      failed_this_session: failed.has(family),
    }
  }
  return {
    current_configuration: current ? { model: current.model, source: currentSource, requested_effort: current.effort ?? null } : null,
    context: {
      conversation_tokens: evidence.contextTokens ?? null,
      source: evidence.contextSource,
      per_tier: capacity,
      note: 'A tier whose context window is smaller than the conversation cannot run it. largest_context_answered is the biggest context a response on that tier came back over; context_window_reported comes from Claude Code for the session model only. null means no evidence either way.',
    },
    previous_attempt: attempt ?? null,
    answer_correctness_verified: 'unknown',
  }
}

export type RoutingFacts = ReturnType<typeof routingFacts>
