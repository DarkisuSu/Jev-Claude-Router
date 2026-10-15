---
name: ask-jev
description: You may ask Jev (TypeSafe) to decide a narrow question within your own authority, with the decide tool; use it when a choice between options, a yes/no judgment or a rating can be settled from evidence you already hold.
---

# Ask Jev

Jev already screens every user message for a fitting skill or saved tool before you see it, and what it picked rides beside the message. This skill is about the other decisions, the ones that come up while you work. You **may** hand those to Jev with `mcp__jev-router__decide`; nothing requires it.

## When it fits

A decision you own, that Jev can judge from the evidence you supply, as one of:

- **Choice**: pick one of a finite set of options (which approach, which file, which of several fixes).
- **Noul**: how likely a yes/no proposition is (does this step belong to the task the user asked for, is this change safe to make without asking).
- **Score**: where something falls on one ordered rubric of 2 to 10 concrete levels.

Whether a step still belongs to the work the user asked for is such a decision.

## When it does not

- The user chose, or the requirement is deterministic: follow it directly.
- It is the user's to make: preferences, consent, authorization, an unresolved requirement. Never submit these to Jev and never infer permission from its answer. Ask the user.
- It needs a plan, a fact you have not found or extended reasoning. Jev cannot generate or discover; do that yourself and submit only the bounded judgment.

## How

1. Say who owns the decision (`decision_owner`: `assistant`) and describe your delegated authority in `authority`.
2. Send a concise `state`: the goal, constraints, the facts you have and what you do not know. No credentials or private content beyond what the question needs.
3. Ask one narrow judgment per question; batch independent questions about the same state. Build the options and criteria from the current task, include deferral or gathering evidence where it is viable, and invent no facts.
4. Read the answer by its probability and confidence. If it is uncertain, gather the missing evidence or reason further; ask the user only when their input is required. If the tool is unavailable or the request invalid, carry on with your own judgment and do not claim Jev decided. Never retry an unchanged question in a loop.

The tool only evaluates. It executes nothing and grants no permission; your usual permission checks still apply.
