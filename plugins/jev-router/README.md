# jev-router

A Claude Code mod that asks TypeSafe Jev on each new prompt two things:

- Which local skills fit the prompt. It follows the two-request flow in the [Skill Suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion).
- Which Claude model tier and reasoning effort the turn should use. The answer is applied to each main-loop request through `turn.step`.

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

**Jev's two extra questions** ride the same rank_wide request, so they cost no extra call:

- `model_tier` (Choice): `haiku`, `sonnet` or `opus`, chosen by what the work is like, not by how long the prompt is.
- `effort_level` (Score): low, medium or high.

**Which models can be routed to.** The list comes from this Claude Code build's own `/config` Model row (`$.config.list()`), so an update that adds or renames a model is picked up as it is. The router keeps only the plain Haiku, Sonnet and Opus entries. It never routes to `[1m]` variants, `opusplan`, fast mode or `default`. Run `/jev-model models` to see the list.

**When a step is rewritten.** It is rewritten only when all of these hold. Otherwise the step goes as the engine resolved it, and the reason is logged.

- `model_routing` is `on`. In `dry-run` (the default) nothing is rewritten, and the log shows what would have been sent.
- The question's confidence reaches `model_threshold` (0.5, the floor in TypeSafe's Confidence guide example), checked separately for the model tier and the effort level. Past it, the highest probability decides: the most likely tier and the most likely effort level. Below it, or when Jev fails, `fallback_model` is used (default `session`, the model you chose with `/model`).
- The target family's full id has been learned on this Claude Code version, it has been seen answering, and its effort support is known (see below).
- The target has not failed earlier in this session.
- The step is the main conversation's. Subagent steps keep their own model.

**Effort.** The router sends only `low`, `medium` or `high`. It sends effort only on a step that already carries one, meaning the model takes effort. After a model switch, it sends effort only to a target seen taking effort, and none to a target that takes none. The API response does not report effort, so the log shows the effort *requested*.

**Within a turn.** The decision is bound to the turn's id at `turn.start`. Every request in that turn, tool loops included, uses the same decision. A prompt typed during a running turn joins that turn and keeps its decision. Decisions are held in this session's memory only, never in `$.store`, which all sessions share.

**Failure.** If a routed request fails, the target is marked failed for the session. If the probe confirmed that a failed step can be sent again, the step is resent on the session's own model.

## How the router learns model ids

`turn.step` refuses a bare alias such as `opus`. A probe on Claude Code 2.1.296 showed this, so the router sends only full ids that the engine itself resolved. It never uses a list of its own. It learns them, per Claude Code version, into `$.store` under `caps`, from three sources:

- **Every step it sees**, main or subagent. `e.model` is the id the engine resolved. A response confirms the model answers, and whether the step carried `effort` shows whether that model takes effort.
- **A `/model` switch**, through `classic.PostModelSwitch` `to_model`.
- **`/jev-model probe`**, which starts one tiny background subagent per routable family with `$.agent.spawn({ model: alias })`. Each subagent's first step teaches that family's id and effort support. If no resend check has been done on this version, the probe also arms one on your next message: that message is first sent to a model id no account has, then resent on the session model.

## Settings

The settings page holds the settings people change. Seven rarely changed ones are kept off it and set with a command; they apply at once and are stored in `$.store`:

| Name | Default | Range |
|---|---|---|
| `jev_model` | jev-latest | 1 to 64 characters |
| `timeout_ms` | 8000 | 1000 to 9000 |
| `max_prompt_chars` | 2000 | 200 to 20000 |
| `shortlist_size` | 3 | 1 to 12 |
| `effort_low` / `effort_medium` / `effort_high` | see `/jev-model settings` | up to 500 characters each |

`/jev-model settings` lists them with their current and default values, `/jev-model set <name> <value>` changes one, and `/jev-model unset <name>` restores its default. `/jev-model defaults` restores these too.

## Commands

| Command | What it does |
|---|---|
| `/jev-model` | Status: mode, thresholds, routable models, probe results, last step, subscription signal |
| `/jev-model fallback <session|haiku|sonnet|opus>` | Saves the fallback model used when Jev is not confident or fails |
| `/jev-model on` / `dry-run` / `off` | Saves `model_routing` through `/config`. `off` restores Claude Code's own behaviour, because the router never changes `/model` or settings |
| `/jev-model probe` | Learns each family's full id and effort support through tiny subagents |
| `/jev-model reset` | Clears learned ids and this session's failed models |
| `/jev-model models` | Shows the models this Claude Code lists and which are routable |
| `/jev-log` | Shows the last 20 log lines: rounds, steps, loads, turns, probes |
| `/jev-index` | Shows the skill index |

## Logs

Logging is **off by default**. Turn on `Write log` in the plugin settings to record it. While it is off, nothing is written and `/jev-log` says so; model routing, the line under each answer and what the probe learns work the same.

Logs go to `~/.claude/plugins/data/jev-router-jev-local/logs/YYYY-MM-DD.jsonl` (UTC dates). Each line has one of these types:

- `round`: Jev's skill and model answers with confidences, the decision with any reason it was not taken, and each Jev call's status, latency and token counts.
- `step`: the model and effort a request came with, what was sent, what would have been sent (dry-run), the model the API reported answering, reasons and fallback.
- `load`, `turn`, `probe`, `session`.

The log never holds the API key, request headers, prompt text or skill text.

## Subscription

The router never touches Claude's credentials. Jev requests go to `api.typesafe.ai` without them. Each turn records whether `$.session.usage()` reported rate-limit windows, which Claude Code reports only on a subscription.

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

Tests answer Jev with the test's own `http.fetch` hook and model requests with the test's own `turn.step` hook. They use a placeholder key and make no network or model calls.
