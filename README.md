# pi-subagents

Delegate work to a fresh pi agent and get back only the answer.

## Why

Some jobs want a clean, focused context — a code review, a research sweep, a second
opinion — and you don't want that whole exploration in your main session, or on your
token bill. Today you either paste a long prompt into your session and keep all the tool
noise forever, or open a second terminal, run `pi`, and copy the answer back by hand.

This extension automates the second one. Agents come from the [`agent`
CLI](https://github.com/levi/agent-framework), so the same agent runs from a slash
command here and from a terminal anywhere else.

## Features

- **One definition, two places to run it.** Agents are defined once for the `agent` CLI.
  This extension reads that same catalog, so `/agent:<name>` and `agent run <name>` are
  never out of sync.
- **Explicit trigger only** — nothing happens unless you type `/agent:<name>`, or the
  model calls an agent you gave a `description`.
- **Isolated context** — each run is a fresh headless `pi` process. Your session receives
  the final message and nothing else.
- **Main agent continues** — the answer is added to your session and starts a turn, so a
  review agent's findings can be applied immediately.
- **Diff-scoped tasks** — every subagent task carries an index of the files this session
  changed plus a path to the full diff, so it reviews the change rather than re-reading
  the repo.
- **Blocking** — the command waits for the agent to finish, then hands you the result.
  `Ctrl+C` stops it.

## Prerequisites

- [pi](https://pi.dev) with model auth already configured (`pi auth check`, or `/login`
  inside pi).
- The [`agent` CLI](https://github.com/levi/agent-framework) on your `PATH` as `agent`,
  with at least one agent defined.

## Quick start

```sh
# 1. Install this extension.
pi install git:github.com/levi/agent-framework-pi

# 2. Check the CLI can see your agents.
agent list

# 3. In pi, run /reload, then:
/agent:reviewer review src/auth.ts and list the concrete fixes
```

If the CLI is not on your `PATH`, point at it explicitly:

```sh
export AGENT_BIN=~/code/agent-framework/src/index.ts
```

## Usage

1. Type `/agent:<name> <task>`, where `<name>` is one of the agents `agent list` shows.
2. The agent runs headless in your current working directory with its own model, system
   prompt, tools and skills.
3. When it exits, its final message is added to your session and the main agent takes a
   turn on it.

```
> /agent:reviewer review src/auth.ts and list the concrete fixes

⠋ running reviewer…

✓ subagent "reviewer" output
  1. `validateToken` accepts expired tokens — expiry check uses `<` instead of `<=` (src/auth.ts:42).
  2. Missing null check on `session.user` before `.id` access (src/auth.ts:57).
  3. Token comparison is not constant-time; use `crypto.timingSafeEqual`.

> I'll fix those three now.
  …
```

Every task also carries an index of the files edited in this session and a path to the
full diff (written to a temp file), so the agent reviews exactly what changed. Agents
that don't need the diff just ignore the path.

Agents are discovered when the extension loads. Add one, then run `/reload` in pi.

### Letting the model call an agent

An agent runs only when you type `/agent:<name>` unless its config sets a `description`:

```yaml
# ~/.agent/reviewer/agent.yaml
description: Reviews code and returns prioritized suggestions. Does not edit files. Pass the exact files to review.
model: ":deep:"
```

Agents with a `description` are listed in a single `subagent` tool the model can call;
their `/agent:<name>` command still works. Agents without one never appear there.

The description is the trigger, exactly like a skill description: phrase it as *when* to
use the agent, not just what it does. While the tool is active, pi also tells the model to
call a listed agent whose description says to use it after editing files — that is what
makes a checker run automatically after edits.

## Configuration

Agents, their config format, the agent root, and the model map all belong to the `agent`
CLI. See its README for the field table. Two things are worth knowing here:

| Setting | Where | Meaning |
|---|---|---|
| `description` | agent config | Makes the agent model-callable. Omit it to keep the agent user-only. |
| `AGENT_BIN` | environment | The CLI to run. Default `agent`. |
| `AGENT_HOME`, `AGENT_MODELS` | environment | Passed straight through to the CLI. |

Each run is a real pi process, so your installed packages, extensions and global settings
apply to subagents too.

## Development

```sh
bun install
bun test          # unit + mocked-ExtensionAPI integration tests
bun run typecheck
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the architecture and design decisions.
