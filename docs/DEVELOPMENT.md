# Development

Contributor notes. What the source cannot say about itself.

## Architecture

```
                    pi process
  ┌──────────────────────────────────────────────────────────┐
  │  index.ts        register /agent:<name> + subagent tool  │
  │    │                                                     │
  │    ├─► src/agent-cli.ts ──► pi.exec ──┐                  │
  │    ├─► src/changes.ts                 │                  │
  │    └─► src/runner.ts                  │                  │
  └───────────────────────────────────────┼──────────────────┘
                                          ▼
                                ┌───────────────────┐
                                │  agent (the CLI)  │
                                └─────────┬─────────┘
                                          ▼  pi --print …
                                    a second pi process
```

Everything about *what an agent is* — the root, the config file, model templates, skills,
`system-cmd` — lives on the right of that boundary. The extension never parses a config
and never enumerates the agent root. It asks the CLI for a catalog and hands the CLI a
name plus a task.

`src/agent-cli.ts` is the whole seam. `ExecFn` is the injection point that makes the rest
testable without spawning anything.

## Data flow

`/agent:<name> <task>`:

1. Extension load → `listAgents(exec, bin)` runs `agent list --json`.
2. Factory → registers `/agent:<name>` for every agent, and one `subagent` tool when at least one agent has a description.
3. User types the command → `prepareTask(ctx, task)` appends this session's change index and a diff file path.
4. `runTask` → `agent run <name> <task>` with the caller's cwd and abort signal.
5. `answerOf` → the answer becomes a session user message, which starts a turn; a failure becomes `failureText` instead.

The `subagent` tool is the same steps 3–5, returning the answer as a tool result instead.

`agent list --json` is the read-only catalog: it never runs an agent's `system-cmd`,
resolves a model, or touches the network.

## Key design decisions

### The CLI is the source of truth, so the extension does not read the filesystem

An earlier version of this extension read `settings.json` and `SYSTEM.md` directly from a
`subagents/` directory of its own. That meant two implementations of "what is an agent"
that could drift. Discovery now goes through `agent list --json`, which is defined as
read-only, so the extension gets names, descriptions and directories without re-deriving
any of the format rules.

### A broken agent root must not stop pi from starting

Discovery runs during extension load and returns `[]` on any failure — missing binary,
bad JSON, non-zero exit — after a `console.warn` that says what to do. The alternative,
throwing, would take down a session because of an unrelated config typo.

### `agent list` exits 1 for a broken agent but still lists the valid ones

So the exit code is deliberately ignored and stdout is parsed regardless; only
unparseable stdout gives up. Bailing on the exit code would hide every working agent
behind one bad one.

### Discovery is synchronous with the factory, not deferred to `session_start`

The pi docs suggest starting long-lived resources from `session_start`, and this call is a
subprocess. It is a bounded, read-only call that finishes in about 20 ms warm, and doing
it in the factory keeps registration linear instead of threading a "registered yet?" flag
through the session lifecycle. Deferring is a one-line move if `agent list` ever gets
slow.

### Change tracking reads files at `tool_call`, and the transcript is the fallback

A `write` destroys the content it replaces, and the transcript stores no pre-write
content, so only the `tool_call` hook can capture a real "before". That hook is lost
across `/reload` and `--resume`, so changes are *also* rebuilt from the session branch,
and the two sources are merged with live winning on duplicates.

### The diff goes to a file, the index goes in the prompt

The change index is one line per file — cheap enough to always include. The full diff is
not, so it is written to a session-scoped temp file and referenced by path. The agent
reads it only when it needs exact text.

### `AGENT_BIN` exists

The CLI ships as TypeScript in a git checkout, so the extension cannot assume it is on
`PATH`. One environment variable covers a non-`PATH` install, and it is also how the
end-to-end checks point the extension at a fake CLI.

### The tool returns an error result rather than throwing

An unknown agent name or a failed run is reported to the model as an error result with
the reason, so the model can correct itself. Throwing would end the turn with no
explanation.

## Maintenance

- **Test suite.** `bun test`. Unit tests cover the three `src/` modules; `test/extension.test.ts`
  drives the real registration path with a mocked `ExtensionAPI`, which is what gives
  `index.ts` full line coverage. `bun test --coverage` should stay above 99%.
- **Verifying against real pi** (needs auth and a model, so it is not a committed test):
  load the extension with `pi -ne -e <this repo>` — `-ne` matters, because it disables
  extension *discovery* so the old `subagents/` extension cannot load alongside and
  double-register `/agent:*`. Point `AGENT_BIN` at a recording script to confirm the argv,
  or at a real CLI and use `--mode rpc` to script a `/agent:<name>` prompt.
- **Do not add `--no-skills`, `-a`, or any other pi flag on the subagent's behalf.** The
  subagent's flags belong to the `agent` CLI; adding them here would split the two
  definitions again.
- **Two extension instances must never be installed at once.** This one and
  `~/.pi/agent/extensions/subagents/` register the same command names and the same
  `subagent` tool.
- **`pi.exec` needs an absolute path or a `PATH` entry.** It runs with `shell: false`, so
  `AGENT_BIN` must be executable and carry a shebang.
