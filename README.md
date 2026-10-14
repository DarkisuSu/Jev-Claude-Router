# Jev Claude Router

A Claude Code plugin (a mod) that asks [TypeSafe](https://docs.typesafe.ai) Jev, on each new prompt, which local skills fit and which Claude model and reasoning effort to use. The model and effort choice is applied to each request through the `turn.step` mod event.

This repository is a plugin marketplace. The plugin itself is in [`plugins/jev-router`](plugins/jev-router), and its README describes how it works and how to configure it.

## Install

At a Claude Code prompt:

```
/plugin install jev-router --marketplace DarkisuSu/Jev-Claude-Router
```

Then enter a TypeSafe API key in the plugin's settings. Model routing starts in `dry-run`.

## Install with another Claude

If you use Claude Code and want it to install this plugin for you, paste this prompt into a session:

```
Install the "jev-router" Claude Code plugin from GitHub, then stop and tell me what happened.

1. Run this at the prompt and answer "y" when it asks to add the marketplace:
   /plugin install jev-router --marketplace DarkisuSu/Jev-Claude-Router
   Choose the user scope.
2. Run /reload-plugins.
3. Ask me to set the TypeSafe API key myself in the plugin's settings (/plugin, then Installed, then jev-router; or /plugin configure jev-router). Do not ask me to paste the key into this chat, and do not write it to a file, an environment variable or a command line.
4. Run /jev-model. It should print "model routing: dry-run". Do not turn routing on (/jev-model on) unless I ask you to.

Requires Claude Code 2.1.287 or later. If a step fails, quote the exact error message.
```

## Requirements

- Claude Code 2.1.287 or later (mods)
- A TypeSafe API key
