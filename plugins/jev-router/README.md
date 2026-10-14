# jev-router

A Claude Code mod that asks TypeSafe Jev on each new prompt two things:

- Which local skills fit the prompt. It follows the two-request flow in the [Skill Suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion).
- Whether each Claude model tier, at each reasoning effort, can do the work. Jev sees the request, short excerpts of the recent conversation, the conversation size and what each tier is known to hold. The router costs every pair (cache rebuild and output included) and applies the cheapest one Jev judges able to each main request through `turn.step`.

Release installation: `/plugin install jev-router --marketplace DarkisuSu/Jev-Claude-Router#main`. Unreleased changes are tested from the local `development` checkout.

## Skill routing

1. **Index.** The router reads its skill list from `$.command.list()`, keeping only user and plugin entries. It adds SKILL.md text from the project's `.claude/skills` folders, `~/.claude/skills` (synced skills included) and installed plugins. Run `/jev-index` to see the list.
2. **rank_wide.** One Choice question ranks every skill. Three Noul gates ask whether the prompt needs a skill at all. If the gate's mean is below `gate_threshold` (0.3), the result is no match.
3. **rerank.** The top `shortlist_size` skills (3, the cookbook's value) are judged again, each with its own `fits::<name>` Noul.
4. **Select.** The fits threshold (`fits_threshold`, 0.3) is the confidence cut-off: every shortlisted skill that reaches it is recommended, best first, with no count limit. Both 0.3 defaults come from the cookbook; TypeSafe publishes no general default and advises tuning on your own data.

**No match, error, timeout or no key:** the prompt goes on with nothing added, so Claude's own skill behaviour stands.

**Load modes:**

- `hint`: adds a `<skill_relevance>` block. Claude loads the skill natively with the Skill tool if it agrees.
- `inject`: adds the SKILL.md text in a block marked `activation="injected-not-native"`. This is not a native activation.

**Load tracking:** a `tool.call` hook on the Skill tool records real native loads, with `skill.prompt` as a second source. Each turn's log entry marks every routed skill `native-loaded`, `injected` or `not-loaded`.

## Model routing

### What Jev is asked

Jev judges one thing per question: whether a tier at an effort can do the work. The router does the cost arithmetic and picks. The questions ride the same rank_wide request as the skill ranking, so model routing adds no Jev call.

| Question | Type | Judges |
|---|---|---|
| `feasible::<tier>::<effort>` | Noul, one per routable tier and effort (up to 15) | Whether that tier at that effort can reliably complete the request, apart from cost |

A tier is asked about only when it can be routed to: Claude Code lists it, it has not failed in this session, and it is the current model or its full id has been learned with known effort support.

The state carries:

- `request`: the prompt (first `max_prompt_chars` characters).
- `recent_context`: short excerpts of recent user and assistant messages, for follow-ups such as "continue" (see [Recent context](#recent-context)).
- `routing_context`: the current model, the conversation size and what each tier is known to hold (see [Context size](#context-size)), and the last attempt's failure counts. It holds no costs: cost is not Jev's to judge.

Tier and effort descriptions are part of each question. They have defaults and can be changed with `/jev-model set`. The effort descriptions describe a reasoning budget (low: little deliberate reasoning; high: compares approaches and checks its work; max: the most thorough the model offers), not a kind of task.

### How the pick is made

1. **Feasible pairs.** Every tier and effort pair Jev judges at least `feasibility_threshold` (0.6) likely to complete the work.
2. **Cheapest.** The router costs each pair (see [Pair cost](#pair-cost)) and runs the cheapest feasible one. A pair with a known cost sorts before one with an unknown cost; unknown costs sort by the model's list price, then the lower tier, then the lower effort.
3. **None feasible.** The pair Jev judges most able runs (the cheaper of equals), logged as `model:none-feasible-most-capable`.
4. **No answer.** When Jev fails or times out, `fallback_model` is used (default `session`, the model you chose with `/model`).

So the threshold defines "able enough", and cost decides among the able. A switch can win (a cheaper tier that Jev judges able) or staying can win (a big warm cache that a switch would rebuild); the numbers decide, not a rule. A `/model` choice is never pinned: every turn is judged, and the `/model` choice is the session model the `session` fallback uses.

### When a step is rewritten

Only when all of these hold. Otherwise the step goes as the engine resolved it, and the reason is logged.

- `model_routing` is `on`. In `dry-run` (the default) nothing is rewritten, and the log shows what would have been sent.
- The target family's full id has been learned on this Claude Code version, it has been seen answering, and its effort support is known.
- The target has not failed earlier in this session.
- The step is the main conversation's. Subagent steps keep their own model.

**Effort.** The router sends one of the five fixed levels (`low`, `medium`, `high`, `xhigh`, `max`). It sends effort only on a step that already carries one, meaning the model takes effort. After a model switch, it sends effort only to a target seen taking effort, and none to a target that takes none. The API response does not report effort, so the log shows the effort *requested*.

**Within a turn.** The decision is bound to the turn at `turn.start`, and the first main step resolves the final model and effort. Every later step of that turn, tool loops included, reuses it, so a turn never switches back and forth. A prompt typed during a running turn joins that turn and keeps its decision.

**Failure.** If a routed request fails, the target is marked failed for the session and the rest of the turn is pinned to the session model. If the probe confirmed that a failed step can be sent again, and nothing had streamed yet, the step is resent on the session's own model.

## Costs

### Pair cost

Each tier at each effort is costed over `cost_horizon` (5) main requests, in API-equivalent USD at list prices. Let `N` be the last-known context, `R` the estimated reusable tokens, `H` the horizon and `O` the expected output tokens per request at that effort:

```
context, staying  = (R × read + (N − R) × write) / 1e6   warm cache; a cached read of N when its state is unknown
context, rebuild  = N × write / 1e6                      a switch, an effort change, or a cold or expired cache
pair cost         = first request's context + (H − 1) × N × read / 1e6 + H × O × output price / 1e6
```

- **Staying** means the same model at the same effort as the last request. Changing effort rebuilds the cache as a switch does (the Prompt caching docs list an effort change as invalidating the cached prefix). With the current effort unknown (no response seen yet), or a model that takes no effort, effort is not counted as a change.
- **Write price** follows the cache lifetime: 1.25× input for 5 minutes, 2× for an hour.
- **Output** (thinking included) is what main requests at that effort were seen producing: a moving average per effort, kept across sessions in `$.store` under `outputs` (numbers only). An effort not seen yet is scaled from the nearest one seen by `effort_output_<level>` (1 / 2 / 4 / 8 / 16, assumptions). Before any output is seen, output is left out of every pair alike.
- **Current model**: the model that answered last; before any response was seen (a new session or a plugin reload), the session model mapped to its learned id.

Unknowns stay unknown: a pair whose model has no price, or a conversation whose size is unknown, has no cost and sorts after the costed ones.

### Cache lifetime

`cache_ttl=auto` (default) takes the lifetime from TTL-specific cache-write counters when a response shows them. Claude Code 2.1.296 does not, so `auto` assumes **1 hour on a subscription** (Claude Code caches for an hour there, dropping to 5 minutes once usage runs into overage) and 5 minutes otherwise. A subscription is recognised by the rate-limit windows `$.session.usage()` reports. `5m` and `1h` are explicit assumptions. None of these changes any request.

### Observations and uncertainty

Every main response records only `usage.model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. Missing counters remain unknown. `input_tokens` is uncached input; total observed context is `input + read + write`, never `input` alone. Hit ratio is `read / total`.

`$.session.usage()` adds its last-response `context.tokens`. This is a last-known context, not an exact count for the upcoming prompt. Each request's start time is captured immediately before sending; the lifetime includes time spent streaming the answer.

Cache status (`cold`, `warm`, `hot`, `expired`, `unknown`) and reusable tokens are **estimates**, distinct from observed counters. A cache is labelled hot when the context reaches `cache_min_tokens` (20000) and the hit ratio reaches `cache_min_hit_ratio` (0.8); hot and warm are costed alike. Estimated reusable input is capped at `min(last-known context, last read + last write)`. After switching away, the router assumes **zero target cache reuse**, including a switch back to an earlier model. A conversation already under way when the router first sees it, as after a plugin reload, is `unknown`, not `cold`: its cache may well be warm.

Conversation cache facts, actual-answer tracking and final plans stay in session memory. They are discarded on `/clear`, `/resume`, a changed session ID or a plugin reload. Compaction and a drop in last-known context invalidate cache evidence. Subagent usage can teach capabilities but never updates main cache facts.

### Prices

`cache.ts` contains a standard-API price snapshot checked on **2026-10-14** against [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), including Haiku 5.5's over-100k-token rates and the 0.05× cache-read rate of Opus 5.5 and Sonnet 5.5. Prices only describe observed full ids; routing targets still come only from Claude Code's available models and learned ids. Unknown versions or special variants get no price rather than an old family rate. Below a model's minimum cacheable length, input is costed at the uncached rate; the per-model minimums in `cache.ts` have **not** been checked against the current Prompt caching page. Update the snapshot when official rates change.

This is a relative **API-equivalent resource proxy**, not measured subscription quota, a Claude bill, or a promise of savings. The router never adds an Anthropic key, changes credentials, rewrites requests beyond `model` and `effort`, or calls paid Anthropic APIs.

The step log also keeps the older switching estimate (`cache_advice`: premium and break-even against the last observed request) for reference; it does not affect the pick.

## Facts Jev judges with

### Recent context

With `jev_context_enabled` on (default), Jev gets up to `jev_context_chars` (2000) characters from the last `jev_context_messages` (6) user and assistant messages. Tool calls and results, subagent text, slash commands, router notes, code blocks and skill bodies are left out. The TypeSafe key, `Bearer` tokens, private keys and `password=`/`api_key=`-style values are redacted before sending. Excerpts go to `api.typesafe.ai` with the prompt; they are never logged.

### Context size

`routing_context.context` tells Jev how large the conversation is and what each tier is known to hold, so its feasibility judgments can weigh whether a tier can take the conversation at all. The router enforces nothing from it.

- `conversation_tokens`: the last-known context from `$.session.usage()`.
- `per_tier.<tier>.largest_context_answered`: the biggest context (input + cache read + cache write) a response on that tier's learned id came back over, main or subagent. It only grows, and is kept with the learned ids per Claude Code version.
- `per_tier.<tier>.context_window_reported`: the window Claude Code reports for the session model; other tiers are `null`, since a mod cannot ask for another model's window.
- `per_tier.<tier>.failed_this_session`: whether a routed request to that tier failed in this session.

`null` means no evidence either way, not "unlimited". No window is written into the code.

### Previous attempt

`routing_context.previous_attempt` counts the last turn's routed-request failures, failed tool calls and denied tool calls. These are execution counts, not a judgment that an answer was wrong (`correctness: unknown`).

## How the router learns model ids

`turn.step` refuses a bare alias such as `opus`. A probe on Claude Code 2.1.296 showed this, so the router sends only full ids that the engine itself resolved. It never uses a list of its own. It learns them, per Claude Code version, into `$.store` under `caps`, from three sources:

- **Every response**, main or subagent. `usage.model` is the actual answering ID. Matching the sent ID confirms capabilities; if the engine answers on a different ID its requested effort is unknown and no effort support is invented. `e.model` alone is never used as the previous actual model.
- **A `/model` switch**, through `classic.PostModelSwitch` `to_model`.
- **`/jev-model probe`**, which starts tiny background subagents per routable family with `$.agent.spawn({ model: alias })`. Each subagent's first step teaches that family's id and effort support. If no resend check has been done on this version, the probe also arms one on your next message: that message is first sent to a model id no account has, then resent on the session model.

**Automatic probe.** With `auto_probe` on (default), the router probes without being asked: when a turn starts and a listed family's id or effort support is not known on this Claude Code (first use, or after an update), and when a routed request to a family fails (its id may have changed). Each family is probed at most once per load, with one tiny background subagent; a toast says so. The resend check is never armed automatically, since it sends a request meant to fail. A probe subagent's reply ("OK") would enter the conversation as another session's message and start a turn of its own, so it is dropped with one line, `jev-router: model probe finished`. Model routing `off` probes nothing.

**Effort levels.** The five levels Claude Code names (`low`, `medium`, `high`, `xhigh`, `max`) are fixed in `model.ts`, and Jev judges every routable tier at every one. Claude Code silently lowers a level a model does not take, and a mod cannot learn which a model takes: a probe on Claude Code 2.1.296 showed that a subagent's step carries the level asked whatever the model, and that no classic event reports the level applied for a subagent `$.agent.spawn` started. So a pair Jev judges at `xhigh` or `max` may actually run one level lower, and it is costed at the level asked. Because the cheapest able pair runs, a higher level is chosen only when no cheaper pair is judged able.

## Settings

The settings page holds the settings people change:

| Setting | Default |
|---|---|
| TypeSafe API key | (none; secure storage) |
| Router enabled | on |
| Write log | off |
| Reset all settings to defaults | off |
| Load mode | hint |
| Gate threshold | 0.3 |
| Fits threshold | 0.3 |
| Model routing | dry-run |
| Fallback model | session |
| Feasibility threshold | 0.6 |
| Share recent context with Jev (`jev_context_enabled`) | on |

The rest are kept off the page, saved in `$.store`, and changed with `/jev-model set <name> <value>`. They apply at once:

| Name | Default | Range |
|---|---|---|
| `model_haiku` / `model_sonnet` / `model_opus` | see `/jev-model settings` | up to 500 characters |
| `effort_low` / `effort_medium` / `effort_high` / `effort_xhigh` / `effort_max` | see `/jev-model settings` | up to 500 characters |
| `cache_min_tokens` | 20000 | 0 to 10000000 |
| `cache_min_hit_ratio` | 0.8 | 0 to 1 |
| `cache_ttl` | auto | auto / 5m / 1h |
| `cost_horizon` | 5 | 1 to 100 requests |
| `effort_output_low` … `effort_output_max` | 1 / 2 / 4 / 8 / 16 | 0.01 to 100 (relative output, until seen) |
| `auto_probe` | true | true / false |
| `jev_context_chars` | 2000 | 0 to 8000 |
| `jev_context_messages` | 6 | 1 to 12 |
| `jev_model` | jev-latest | 1 to 64 characters |
| `timeout_ms` | 8000 | 1000 to 9000 |
| `max_prompt_chars` | 2000 | 200 to 20000 |
| `shortlist_size` | 3 | 1 to 12 |

Each setting has one home and is read from it alone. `/jev-model unset <name>` restores one default; `/jev-model defaults` (or the reset switch) restores both homes and keeps the API key. All defaults are starting points, not measured optimums.

## Commands

| Command | What it does |
|---|---|
| `/jev-model` | Status: mode, threshold, routable models, probe results, cost basis, last step |
| `/jev-model on` / `dry-run` / `off` | Saves `model_routing`. `off` restores Claude Code's own behaviour, because the router never changes `/model` or settings |
| `/jev-model cache` | Shows the cache and cost settings |
| `/jev-model fallback <session\|haiku\|sonnet\|opus>` | Saves the fallback model used when Jev gives no answer |
| `/jev-model settings` | Lists every setting with its value, default and home |
| `/jev-model set <name> <value>` / `unset <name>` | Changes or restores one setting in its own home |
| `/jev-model defaults` | Restores every setting except the API key |
| `/jev-model probe` | Learns each family's full id and effort support through tiny subagents |
| `/jev-model reset` | Clears learned ids and this session's failed models |
| `/jev-model models` | Shows the models this Claude Code lists and which are routable |
| `/jev-log` | Shows the last 20 log lines: rounds, steps, loads, turns, probes |
| `/jev-index` | Shows the skill index |

## Logs

Logging is **off by default**. Turn on `Write log` in the plugin settings to record it. While it is off, nothing is written and `/jev-log` says so; routing works the same.

Logs go to `~/.claude/plugins/data/jev-router-jev-local/logs/YYYY-MM-DD.jsonl` (UTC dates). Each line has one of these types:

- `round`: Jev's skill answers, `jev_feasible` per tier and effort, `candidates` (every pair with its feasibility and cost parts, cheapest first), `cost_basis` (context size, cache status, cache lifetime source, horizon, output averages), the `decision` (pair, `how`, cost, threshold), recent-context metadata (source, message count, length; never the text), and each Jev call's status, latency and token counts.
- `step`: the model and effort a request came with, Jev's recommended pair, the final recommendation, what was sent, the model the API reported answering, reasons and fallback. `observed_usage` holds actual counters or null; `cache_advice` holds the estimated cache state and, when calculable, the older switching estimate.
- `load`, `turn`, `probe`, `session`, `reset`.

The log never holds the API key, request headers, prompt text, excerpt text or skill text.

The line under each answer names who answered: the actual answering model, the requested effort, and the pick (`cheapest feasible opus/high ~$0.865/5 requests`) or the fallback. The panel's model display can stay on the session model even when a request was routed; the line under the answer is the record.

## Subscription

The router never touches Claude's credentials. Jev requests go to `api.typesafe.ai` without them. Each turn records whether `$.session.usage()` reported rate-limit windows, which Claude Code reports only on a subscription; on one, costs assume the hour-long cache (see [Cache lifetime](#cache-lifetime)).

## Branches and releases

- **`main`** holds releases only. It is always the latest release, and installs are pinned to it (`--marketplace DarkisuSu/Jev-Claude-Router#main`).
- **`development`** holds every change. Work and test there; a release is a merge of `development` into `main`.
- The version is the `version` in `plugin.json`. It is raised on `development` as part of a release, and `main` then carries it. Versions are not marked with tags: a version is what `main` held after its merge. (The `v0.3.0` tag predates this rule and is left as it is; no new tags are made.)
- This section is kept identical on every branch. A change to these rules is made on `development` and merged into `main` in the same step.

## Develop

```
claude plugin validate plugins/jev-router
claude plugin test plugins/jev-router
```

Tests answer Jev with the test's own `http.fetch` hook and model requests with the test's own `turn.step` hook. They use a placeholder key and make no network or model calls. They verify routing behaviour, not Jev's accuracy or real task success.

### Interface limits

Validated and mock-tested with Claude Code 2.1.296 (the binary bundled in the official VS Code extension). Not available to a mod: the exact upcoming input count, the live cached-prefix identity, the remaining TTL, the extent of a partial invalidation, the effort actually applied, the target model's token count for the same text, subscription-quota cost, and a cache-safe per-message effort control. Unknown data is reported as unknown, never estimated as a measurement.

### Verify in the official VS Code extension

1. Stay on `development`, run `/reload-plugins`, then `/jev-model models` and `/jev-model settings`.
2. Keep `dry-run` and turn on `Write log`. On first use the next message probes each unknown family by itself (one tiny subagent each, a toast, and `jev-router: model probe finished` in place of each reply); `/jev-model probe` does the same on demand and also arms the resend check. Confirm the learned ids in `/jev-model`, then `/jev-model on`.
3. Build a long context and send follow-ups. In `/jev-log`, check the round's `cost_basis` (TTL `subscription-1h` on a subscription), `candidates` and `decision`, and the steps' `observed_usage` read/write counts.
4. Send a request a small model clearly cannot do well and check that its pairs fall below the threshold in `jev_feasible`, so a dearer able pair runs.
5. Wait past the cache lifetime and confirm the next turn sees `expired` and staying is costed as a rebuild; a running tool loop keeps its plan. Confirm `/clear`, `/resume`, compaction and a separate chat start without earlier cache facts.
6. Change a description with `/jev-model set`, reload, and confirm `/jev-model settings` and the next request use it. Restore with `unset` or `defaults`.
