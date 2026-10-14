# Jev Claude Router

A Claude Code plugin (a mod) that asks [TypeSafe](https://docs.typesafe.ai) Jev, on each new prompt, which local skills fit and which Claude model and reasoning effort to use. The model and effort choice is applied to each request through the `turn.step` mod event.

This repository is a plugin marketplace. The plugin itself is in [`plugins/jev-router`](plugins/jev-router), and its README describes how it works and how to configure it.

## Install

At a Claude Code prompt:

```
/plugin install jev-router --marketplace DarkisuSu/Jev-Claude-Router
```

Then enter a TypeSafe API key in the plugin's settings. Model routing starts in `dry-run`.

## Requirements

- Claude Code 2.1.287 or later (mods)
- A TypeSafe API key
