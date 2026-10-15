# jev-router

A Claude Code mod that asks TypeSafe Jev on each new prompt two things:

- Which local skills fit the prompt. It follows the two-request flow in the [Skill Suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion).
- Whether each Claude model tier, at each reasoning effort, can do the work. Jev sees the request, short excerpts of the recent conversation, the conversation size and what each tier is known to hold. The router costs every pair (cache rebuild and output included) and applies the cheapest one Jev judges able to each main request through `turn.step`.

It also keeps a list of tools Claude wrote for earlier work (see [Saved tools](#saved-tools)) and asks Jev which one, if any, fits the new prompt.

During the task it also gives Claude a general-purpose decision tool, with system instructions to automatically submit eligible assistant-owned judgments to Jev. The questions and options come from the current task, with no fixed list of action categories. This feature is independent of prompt-time skill and model routing.

Release installation: `/plugin install jev-router --marketplace DarkisuSu/Jev-Claude-Router#main`. Unreleased changes are tested from the local `development` checkout.

## Skill routing

1. **Index.** The router reads its skill list from `$.command.list()`, keeping only user and plugin entries. It adds SKILL.md text from the project's `.claude/skills` folders, `~/.claude/skills` (synced skills included) and installed plugins. Run `/jev-index` to see the list.
2. **rank_wide.** One Choice question ranks every skill. Three Noul gates ask whether the prompt needs a skill at all. If the gate's mean is below `gate_threshold` (0.3), the result is no match.
3. **rerank.** The top `shortlist_size` skills (3, the cookbook's value) are judged again, each with its own `fits::<name>` Noul.
4. **Select.** The fits threshold (`fits_threshold`, 0.3) is the confidence cut-off: every shortlisted skill that reaches it is recommended, best first, with no count limit. Both 0.3 defaults come from the cookbook; TypeSafe publishes no general default and advises tuning on your own data.

**No match, error, timeout or no key:** the prompt goes on with nothing added, so Claude's own skill behaviour stands.

**Switching it off.** `Skill selection` on the settings page (or `/jev-model skills on|off`) is separate from model routing. Off, the skill index is not built, no skill is ranked, gated or suggested, and the prompt-time request to Jev carries the model questions alone (the round's reason is `skill-routing-off`). With model routing off as well, there is no prompt-time Jev call; the decision tool can still make its own calls. `Router enabled` stops all three features.

**Load modes:**

- `hint`: adds a `<skill_relevance>` block. Claude loads the skill natively with the Skill tool if it agrees.
- `inject`: adds the SKILL.md text in a block marked `activation="injected-not-native"`. This is not a native activation.

**Load tracking:** a `tool.call` hook on the Skill tool records real native loads, with `skill.prompt` as a second source. Each turn's log entry marks every routed skill `native-loaded`, `injected` or `not-loaded`.

## Selection mode: prehint or consult

`selection_mode` (settings page) decides how a skill or a saved tool reaches Claude. The model and effort are always chosen while the prompt is sent, because they must be set before the turn starts.

- **`consult`** (default): the prompt carries no skill or tool pick, and Jev is not asked about them while it is sent. Claude is told, in a system section, that the model and effort, and the choice of a skill or saved tool, are delegated to Jev. It is given no list of saved tools, only the `consult` tool and the rule that every user message starts with a call to it with a one-sentence task. The skill list Claude Code adds to the request (the `skill_listing` attachment) is left out while skill selection is on, so Claude is not shown the skills; Jev names them and Claude loads one by name with the Skill tool. Whether the Skill tool accepts a name Claude was never listed is not confirmed in a real session. The router asks Jev (the skill ranking and gates, then the saved-tool Choice, over that task and the recent conversation) and answers with the picks and their probabilities. Nothing is loaded or run by the call; Claude chooses among what Jev returns, then loads a picked skill or reads a picked tool's file; it is told to use only what Jev returned. The exchange shows in the conversation as a tool call. It depends on Claude following that instruction: nothing forces the call, and `inject` load mode applies only to `prehint`.
- **`prehint`**: Jev picks while the prompt is sent, and the picks ride beside it as `<skill_relevance>` and `<tool_relevance>` (described below). The status line names what was chosen, for example `jev: model sonnet/high · skill speckit-plan · tool csv_to_json` (always all three: a skill or tool not chosen reads `none`, a switched-off one `off`, consult mode `consult`; the same line is added to the conversation as a notice the model does not read, unless `chat_notice` is off).

## Saved tools

Claude often writes a script for a piece of work (a converter, a check, a report). When the same kind of work comes again, it can start from that script instead of rewriting it.

**Saving.** With `tool_save` on, Claude gets a `save_tool` tool and a system instruction: when it notices repeated work, or writes a script a similar task will want again, it saves it with a name, a one-line description of the kind of task it solves, how to run it, and the file's absolute path. Before saving, the router checks the file exists and asks Jev one Noul, judged from the description alone (no code or file content is sent): will this tool serve a different future task of the same kind? Below `tool_save_threshold` (0.5) the save is declined; if Jev cannot be reached, the save goes ahead; with the threshold at 0, Jev is not asked. Saving a name again updates it. A description or usage holding a credential-like value or a code block is refused, not rewritten.

**What is kept.** A pointer: name, description, usage, path, scope, who saved it, and use counts. Never the file's content. The lists live in Claude Code's plugin store, not in the project or in Git: one per project (keyed by a hash of the project folder) and one global. Past `tool_max` (50) per scope, the least recently used tool an assistant saved goes.

**Whose tool it is.** Every entry records its origin. What an assistant saved with `save_tool` is a cache of its own work: it is marked "saved by an assistant" in the hint, can be cleared in bulk, and its script file is deleted with it. What you register with `/jev-tool add <name> <absolute path> [project|global] <what it does>` is yours: marked "registered by the user", not judged by Jev, not counted against `tool_max`, left alone by every bulk clear and eviction, and its file is never deleted by the plugin. An assistant's save never replaces a tool of yours with the same name, and is declined if the list is full of your own tools. Only `/jev-tool clear <name>` removes one of yours, and that removes the entry, not the file.

**Choosing.** With `tool_routing` on and at least one saved tool, request 1 also asks one Choice, `tool_which`, among the project's tools, the global ones (a project tool hides a global one of the same name) and `none`. Each tool Jev puts at least `tool_threshold` (0.5) probability on, up to `tool_hints` (3), is suggested beside the prompt, if its file still exists:

```
<tool_relevance source="jev-router (TypeSafe Jev)">
A tool saved from earlier work may fit this request. An assistant wrote it: read the file before running it, run it only if it fits, and ignore this hint otherwise. Normal permission checks apply.
- csv_to_json (project): Converts CSV exports to JSON
  run: python tools/csv_to_json.py in.csv out.json
  file: C:/work/tools/csv_to_json.py
</tool_relevance>
```

Nothing runs by itself: Claude decides, and its own permission checks apply. A shell command that names a suggested tool's file counts as a use. The round log records how many tools were offered, which were picked (name, scope, probability) and how many were skipped because the file was gone; never descriptions or paths.

**Managing.** `/jev-tool` lists both layers (your own marked `[yours]`) and flags missing files; `/jev-tool show <name>`, `/jev-tool add …`, `/jev-tool clear <name|all|missing> [project|global]`, `/jev-tool on|off` (selection) and `/jev-tool save on|off`. `clear all` and `clear missing` take only what assistants saved. Clearing an assistant's tool also deletes its script file when no saved-tool list still refers to it (so a file you also registered survives); add `--keep-files` to keep the files (see [Logs](#logs) for `/jev-data`).

## Automatic decisions during a task

With `Decision · Automatic decisions` on (default), a TypeSafe key configured and the router enabled, the plugin registers `mcp__jev-router__decide` as an upfront tool and adds a stable system-prompt section whenever that tool is offered. No separate Skill activation is needed. The instructions remain available during tool loops and are composed again after compaction. A subagent gets them only if its prompt offers the tool.

Claude determines whether a decision is within its delegated authority, gathers the relevant evidence and formulates narrow typed questions. It sends `decision_owner`, an `authority` description, a `state` object (goals, constraints, facts and unknowns), and `questions` keyed by simple ids. Each question asks one thing:

| Type | Input | Result |
|---|---|---|
| `choice` | 2–255 task-specific option ids and descriptions | Selected option, probabilities and confidence |
| `noul` | One yes/no proposition, optionally with true/false descriptions | Probability that it is true |
| `score` | 2–10 concrete ordered levels for one dimension | Probability-weighted score, probabilities, confidence and level legend |

These are the [TypeSafe primitives](https://docs.typesafe.ai/primitives). The tool accepts 1–16 independent questions per call, with a shared state, and a maximum input length of 20000 characters. It rejects oversized input rather than silently cutting off evidence. It uses the existing secure API key, `jev_model` and `timeout_ms`; each invocation makes one separate request to `api.typesafe.ai`. It executes no actions.

**User decisions stay with the user.** The instructions exclude user-reserved judgments, preferences, unresolved requirements, consent and authorization, and tell Claude to honor explicit choices directly. A call marked `decision_owner: user` returns `requires_user` before any network request. Ownership is declared by Claude; the plugin cannot independently prove that a question belongs to the assistant. Jev's answers grant no permission and do not override user instructions or execution permissions.

**Results and failures.** The plugin validates answer types, supplied option membership, probability ranges/distributions and score consistency. It returns `decided` or `uncertain`, retaining the typed answers. The configurable `decision_confidence_threshold` defaults to 0.6: Choice/Score use confidence, while Noul uses the probability of its likelier yes/no outcome (an exact 0.5 remains uncertain). This is a starting point, not a measured optimum or guarantee of correctness. Invalid input returns `invalid_request`; disabled routing, a missing key, an HTTP error, timeout or malformed answer returns `unavailable`, with no invented decision. Claude is instructed to gather evidence or reason further for uncertainty, and use its own judgment within its delegated scope when Jev is unavailable. It asks the user when their input or decision is required, and never loops on an unchanged question.

**Information sent.** Claude explicitly supplies relevant evidence; the plugin does not read files or attach the transcript on behalf of this tool. Common credential fields and credential patterns, including the configured key, are redacted on a best-effort basis throughout state, authority and question descriptions. `jev_context_enabled` controls the existing prompt-time excerpts, not this explicitly supplied decision state. Decision logs hold only outcome, question/uncertainty counts, threshold and duration; they contain no state, authority, questions, option ids or answers.

**Controls and limits.** Turn this feature off in the settings page or with `/jev-model set decision_routing false`; restore it with `true` and reload the plugin if its tool is not yet listed. Set the threshold with `/jev-model set decision_confidence_threshold <value>` (0.5–1). Skill selection and model routing retain their own controls; model `dry-run` applies only to model rewriting, so decision calls still contact Jev. Automatic consultation depends on Claude following the system instructions: mods cannot observe every internal reasoning decision, so the feature does not guarantee every eligible decision is submitted. The tests verify the interface and hooks with mocked Jev replies, not real-model adherence or judgment quality.

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
2. **Cheapest.** The router costs each pair (see [Pair cost](#pair-cost)) and finds the cheapest feasible one. A pair with a known cost sorts before one with an unknown cost; unknown costs sort by the model's list price, then the lower tier, then the lower effort.
3. **Within tolerance, the likeliest.** Feasible pairs costing within `cost_tolerance` (3%) of the cheapest may replace it, in cost order, by being at least 0.05 likelier in Jev's feasibility than the pair before. A cost difference that small is an estimate, and a clearly likelier pair is worth it; the 0.05 margin keeps hundredths in Jev's answers, or an effort whose cost is not measured yet (it looks as cheap as the rest), from pulling the pick up to a dearer level. With `cost_tolerance` 0 the cheapest always runs; with no known cost there is nothing to compare, and step 2's order stands. The log says `cheapest-feasible` or `most-feasible-within-tolerance`.
4. **None feasible.** The pair Jev judges most able runs (the cheaper of equals), logged as `model:none-feasible-most-capable`.
5. **No answer.** When Jev fails or times out, `fallback_model` is used (default `session`, the model you chose with `/model`).

So the threshold defines "able enough", and cost (then feasibility, within the tolerance) decides among the able. A switch can win (a cheaper tier that Jev judges able) or staying can win (a big warm cache that a switch would rebuild); the numbers decide, not a rule. A `/model` choice is never pinned: every turn is judged, and the `/model` choice is the session model the `session` fallback uses.

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

Each tier at each effort is costed over `H` main requests (see below), in API-equivalent USD at list prices. Let `N` be the last-known context, `R` the estimated reusable tokens, `H` the horizon and `O` the expected output tokens per request at that effort:

```
context, staying  = (R × read + (N − R) × write) / 1e6   warm cache; a cached read of N when its state is unknown
context, rebuild  = N × write / 1e6                      a switch of model, or a cold or expired cache
pair cost         = first request's context + (H − 1) × N × read / 1e6 + H × O × output price / 1e6
```

- **Staying** means the same model as the last request, whatever the effort. An effort change is **not** costed as a cache rebuild: in the logs, two effort changes in a row (high to medium to high) left `cache_read` growing with nothing rewritten, while a model switch wrote the whole context again (a switch from Opus to Sonnet wrote 388,522 tokens). This is evidence from one session, not a documented guarantee; if effort changes are found to rebuild the cache, it will show as writes after a change.
- **Write price** follows the cache lifetime: 1.25× input for 5 minutes, 2× for an hour.
- **Output** (thinking included) is the median of the output tokens of recent main requests (the latest 40 per effort, numbers only, kept across sessions in `$.store` under `outputs`). The median is used because a few very long answers would drag a mean. An effort uses its own median once it has 10 samples; until then every effort shares the median over all efforts, so effort does not change the cost (no ratio between efforts is assumed), and with fewer than 3 samples in all, output is left out of every pair alike. In the logs most requests are short tool-call steps, so the output cost is small beside the context cost.
- **Horizon `H`**: `cost_horizon`, or with 0 (default) the median number of main requests per turn over the last turns (kept across sessions under `turnlen`; 5 until three turns have been seen). The decision binds to the whole turn, so the turn's requests are what a switch pays back over.
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

The step log also keeps the older switching estimate for a model change (`cache_advice`: premium and break-even against the last observed request) for reference; it does not affect the pick.

## Facts Jev judges with

### Recent context

With `jev_context_enabled` on (default), Jev gets up to `jev_context_chars` (12000) characters from the last `jev_context_messages` (16) user and assistant messages. The same excerpts serve every question in the request: skills, saved tools and the model and effort feasibility. Tool calls and results, subagent text, slash commands, router notes, code blocks and skill bodies are left out. The TypeSafe key, `Bearer` tokens, private keys and `password=`/`api_key=`-style values are redacted before sending. Excerpts go to `api.typesafe.ai` with the prompt; they are never logged.

**How the budget is spent.** The budget is used in full: a short message keeps all of its text and the long ones share the rest, shortest first. A message that has to be cut keeps its start and its end (an answer's conclusion is usually in its last lines), marked with ` … `. The prompt and the excerpts share one state budget of 24000 characters (`STATE_CHAR_BUDGET`): Jev 1.13 takes 32k tokens for the state plus its longest question, a character can be a whole token (CJK, code), and the longest question (the skills) takes a share. The prompt is held to `max_prompt_chars` (4000) and the excerpts to what it leaves, 3000 characters being kept back for the routing facts. Only one model is offered (`jev-1.13.0`; `jev-latest` and `jev-preview` point to it), at $0.042 per million input tokens, so a full request costs a fraction of a cent. More conversation also means more of it leaves your machine for `api.typesafe.ai`: lower `jev_context_chars` to share less, or turn `jev_context_enabled` off.

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

**Probing comes first.** A message that needs a probe does not go on until the probe ends. The order is: probe, then Jev chooses the model, then the conversation, then a skill or tool where one applies. When a family is unknown at the first message, the router starts its probe subagent and waits (the status line says `jev: probing sonnet before choosing a model`) until the family's id and effort support are learned, at most `probe_wait_ms` (20000 ms; 0 does not wait and probes at the turn as before). Then Jev is asked and the model chosen. If a routed request fails, it goes back to the probe: the family is probed again and waited for, then the same pair is asked again with the id just learned, up to two probes; after that the fallback model carries on. A failed request is asked again only where the resend check has passed and nothing was streamed yet; otherwise the family is probed and the fallback is used straight away. Probing relies on the probe subagent's steps reaching the router while the message waits; if they never do (an engine that holds the message until the hook returns), the wait runs out once and the message goes on.

**Effort levels.** The five levels Claude Code names (`low`, `medium`, `high`, `xhigh`, `max`) are fixed in `model.ts`, and Jev judges every routable tier at every one. Claude Code silently lowers a level a model does not take, and a mod cannot learn which a model takes: a probe on Claude Code 2.1.296 showed that a subagent's step carries the level asked whatever the model, and that no classic event reports the level applied for a subagent `$.agent.spawn` started. So a pair Jev judges at `xhigh` or `max` may actually run one level lower, and it is costed at the level asked. Because the cheapest able pair runs, a higher level is chosen only when no cheaper pair is judged able, or when it is clearly likelier (by 0.05 or more) among pairs of nearly the same cost.

## Settings

The settings page holds the settings people change:

| Setting | Default |
|---|---|
| TypeSafe API key | (none; secure storage) |
| Router enabled | on |
| Write log | off |
| Reset all settings to defaults | off |
| Skill selection | on |
| Selection mode (`selection_mode`) | consult |
| Tool selection (`tool_routing`) | on |
| Let Claude save tools (`tool_save`) | on |
| Tool selection threshold (`tool_threshold`) | 0.5 |
| Tool save threshold (`tool_save_threshold`) | 0.5 |
| Automatic decisions (`decision_routing`) | on |
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
| `cost_horizon` | 0 (learned from recent turns) | 0 to 100 requests |
| `cost_tolerance` | 0.03 | 0 to 0.5 (share of the cheapest feasible cost) |
| `auto_probe` | true | true / false |
| `probe_wait_ms` | 20000 | 0 to 120000 ms the first message waits for a probe |
| `tool_max` | 50 | 1 to 200 saved tools per scope |
| `tool_hints` | 3 | 1 to 5 tools suggested per request |
| `decision_confidence_threshold` | 0.6 | 0.5 to 1 |
| `jev_context_chars` | 12000 | 0 to 20000 |
| `jev_context_messages` | 16 | 1 to 40 |
| `jev_model` | jev-latest | 1 to 64 characters |
| `timeout_ms` | 9000 | 1000 to 9000 |
| `max_prompt_chars` | 4000 | 200 to 20000 |
| `shortlist_size` | 3 | 1 to 12 |

Each setting has one home and is read from it alone. `/jev-model unset <name>` restores one default; `/jev-model defaults` (or the reset switch) restores both homes and keeps the API key. All defaults are starting points, not measured optimums.

## Commands

| Command | What it does |
|---|---|
| `/jev-model` | Status: mode, threshold, routable models, probe results, cost basis, last step |
| `/jev-model skills` / `skills on` / `skills off` | Shows or saves `skill_routing`, the skill selection switch |
| `/jev-model on` / `dry-run` / `off` | Saves `model_routing`. `off` restores Claude Code's own behaviour, because the router never changes `/model` or settings |
| `/jev-model cache` | Shows the cache and cost settings |
| `/jev-model fallback <session\|haiku\|sonnet\|opus>` | Saves the fallback model used when Jev gives no answer |
| `/jev-model settings` | Lists every setting with its value, default and home |
| `/jev-model set <name> <value>` / `unset <name>` | Changes or restores one setting in its own home |
| `/jev-model defaults` | Restores every setting except the API key |
| `/jev-model probe` | Learns each family's full id and effort support through tiny subagents |
| `/jev-model reset` | Clears learned ids and this session's failed models |
| `/jev-model models` | Shows the models this Claude Code lists and which are routable |
| `/jev-log` | Shows the last 20 log lines; `/jev-log clear [today|all]` empties today's or every dated log file |
| `/jev-data` | Shows local Jev data; clear logs, learned routing data, saved-tool indexes, or all of those |
| `/jev-index` | Shows the skill index |
| `/jev-tool` | Saved tools: list, show, add (your own), clear (assistant-saved ones, script files too unless `--keep-files`), on/off, save on/off |

## Logs

Logging is **off by default**. Turn on `Write log` in the plugin settings to record it. While it is off, nothing is written and `/jev-log` says so; routing works the same.

Logs go to `~/.claude/plugins/data/jev-router-jev-local/logs/YYYY-MM-DD.jsonl` (UTC dates). Each line has one of these types:

- `round`: Jev's skill answers, `jev_feasible` per tier and effort, `candidates` (every pair with its feasibility and cost parts, cheapest first), `cost_basis` (context size, cache status, cache lifetime source, horizon and where it came from, tolerance, output sample count and median per effort), the `decision` (pair, `how`, cost, threshold), recent-context metadata (source, message count, length; never the text), and each Jev call's status, latency and token counts.
- `step`: the model and effort a request came with, Jev's recommended pair, the final recommendation, what was sent, the model the API reported answering, reasons and fallback. `observed_usage` holds actual counters or null; `cache_advice` holds the estimated cache state and, when calculable, the older switching estimate for a model change.
- `load`, `turn`, `probe`, `session`, `reset`.
- `decision`: typed-decision outcome, question count, uncertain count, threshold and duration only.

The log never holds the API key, request headers, prompt text, excerpt text or skill text.

`/jev-log clear` empties the current UTC day's log; `/jev-log clear all` empties all dated Jev log files. `/jev-data` shows the local data categories and supports:

- `/jev-data clear logs [today|all]` (defaults to all dated logs).
- `/jev-data clear learned` removes learned model capabilities, output samples and turn lengths, and resets this session's temporary routing facts.
- `/jev-data clear tools [project|global|all] [--keep-files]` removes the saved-tool index entries assistants saved (defaults to all projects and global) and deletes their unshared script files. Tools you registered with `/jev-tool add` are kept, files included. Use `--keep-files` to preserve the scripts too.
- `/jev-data clear all [--keep-files]` clears logs, learned data, assistant-saved tool indexes and their unshared script files together; your own registered tools stay. Use `--keep-files` to preserve the scripts.

`/jev-tool clear <name|all|missing> [project|global] [--keep-files]` offers the same cleanup for selected tools (`all` and `missing` skip yours; a name removes one of yours as an entry only). File deletion checks every project and global index for references after clearing, and only unlinks regular files; shared files, directories, symlinks and missing files are preserved or reported. The older `--delete-files` flag is still accepted for compatibility. On Claude Code's CLI, deletion uses `$.process.run`; environments without process execution can still clear the indexes.

These clear commands preserve plugin settings and the API key. Log files are emptied and left as zero-byte dated files; if logging is enabled, new lines are written again on later events.

The line under each answer names who answered: the actual answering model, the requested effort, and the pick (`cheapest feasible opus/high ~$0.865/5 requests`) or the fallback. The panel's model display can stay on the session model even when a request was routed; the line under the answer is the record.

## Subscription

The router never touches Claude's credentials. Jev requests go to `api.typesafe.ai` without them. Each turn records whether `$.session.usage()` reported rate-limit windows, which Claude Code reports only on a subscription; on one, costs assume the hour-long cache (see [Cache lifetime](#cache-lifetime)).

## Branches and releases

- **`main`** holds releases only. It is always the latest release, and installs are pinned to it (`--marketplace DarkisuSu/Jev-Claude-Router#main`).
- **`development`** holds every change. Work and test there; a release is a merge of `development` into `main`.
- The version is the `version` in `plugin.json`. It is raised on `development` as part of a release, and `main` then carries it. Each release is tagged `v<version>` (for example `v0.3.1`) on the `main` commit that carries it. A tag marks a release only; installs follow `main`, not a tag.
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
5. Wait past the cache lifetime and confirm the next turn sees `expired` and staying is costed as a rebuild for a model switch only; a running tool loop keeps its plan. Confirm `/clear`, `/resume`, compaction and a separate chat start without earlier cache facts.
6. Change a description with `/jev-model set`, reload, and confirm `/jev-model settings` and the next request use it. Restore with `unset` or `defaults`.
