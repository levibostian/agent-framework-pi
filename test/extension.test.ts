import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index.ts";
import { resetChanges } from "../src/changes.ts";
import {
  argvOf,
  execResult,
  fakeExec,
  makeContext,
  makeFakePi,
  withWarnings,
  type ExecCall,
  type ExecResult,
} from "./helpers.ts";

const DISCOVERY = JSON.stringify([
  { name: "reviewer", description: "Reviews diffs.", dir: "/agents/reviewer" },
  { name: "quiet", dir: "/agents/quiet" },
]);

interface LoadOptions {
  /** What `agent list --json` answers. Defaults to DISCOVERY. */
  list?: ExecResult;
  /** What `agent run ...` answers. Defaults to "the answer". */
  run?: () => ExecResult;
}

/** Load the extension against a fake `agent` CLI, and expose what it registered. */
async function load(options: LoadOptions = {}) {
  const { exec, calls } = fakeExec((_command, args) => {
    if (args[0] === "list") return options.list ?? execResult({ stdout: DISCOVERY });
    return options.run?.() ?? execResult({ stdout: "the answer" });
  });
  const fake = makeFakePi(exec);
  await register(fake.pi);
  return { ...fake, calls, runCalls: (): ExecCall[] => calls.filter((call) => call.args[0] === "run") };
}

const originalBin = process.env.AGENT_BIN;

afterEach(() => {
  resetChanges();
  if (originalBin === undefined) delete process.env.AGENT_BIN;
  else process.env.AGENT_BIN = originalBin;
});

describe("discovery", () => {
  test("goes through the CLI's read-only list, not the filesystem", async () => {
    const { calls } = await load();

    expect(calls).toHaveLength(1);
    expect(argvOf(calls[0]!)).toBe("agent list --json");
  });

  test("AGENT_BIN overrides the binary, for an install that is not on PATH", async () => {
    process.env.AGENT_BIN = "/opt/agent/bin/agent";
    const { calls } = await load();

    expect(calls[0]!.command).toBe("/opt/agent/bin/agent");
  });

  test("a missing CLI leaves pi usable and says how to fix it", async () => {
    let commands = 0;
    let tools = 0;
    const warnings = await withWarnings(async () => {
      const loaded = await load({ list: execResult({ code: 1 }) });
      commands = loaded.commands.size;
      tools = loaded.tools.size;
    });

    expect(commands).toBe(0);
    expect(tools).toBe(0);
    expect(warnings.join("\n")).toContain("AGENT_BIN");
  });
});

describe("commands", () => {
  test("every agent gets one, described or not", async () => {
    const { commands } = await load();

    expect([...commands.keys()]).toEqual(["agent:quiet", "agent:reviewer"]);
    expect(commands.get("agent:reviewer")!.description).toContain('"reviewer"');
  });

  test("a name that cannot be a slash command is skipped with a warning", async () => {
    const list = execResult({ stdout: JSON.stringify([{ name: "with space", dir: "/agents/x" }]) });
    let commands = 0;
    const warnings = await withWarnings(async () => {
      commands = (await load({ list })).commands.size;
    });

    expect(commands).toBe(0);
    expect(warnings.join("\n")).toContain("with space");
  });

  test("an empty task shows usage and runs nothing", async () => {
    const { commands, calls } = await load();
    const ctx = makeContext();

    await commands.get("agent:reviewer")!.handler("   ", ctx);

    expect(ctx.notifications).toEqual([{ message: "Usage: /agent:reviewer <task>", level: "warning" }]);
    expect(calls.filter((call) => call.args[0] === "run")).toHaveLength(0);
  });

  test("a task runs the agent and hands the answer to the session", async () => {
    const { commands, sentMessages, runCalls } = await load({ run: () => execResult({ stdout: "looks good\n" }) });
    const ctx = makeContext();

    await commands.get("agent:reviewer")!.handler("review src/a.ts", ctx);

    expect(argvOf(runCalls()[0]!)).toBe("agent run reviewer review src/a.ts");
    expect(runCalls()[0]!.options).toMatchObject({ cwd: "/work" });
    expect(sentMessages).toEqual([{ content: '[subagent "reviewer" output]\nlooks good', options: undefined }]);
    expect(ctx.statuses).toEqual([
      { key: "subagent", text: "running reviewer…" },
      { key: "subagent", text: undefined },
    ]);
  });

  test("the answer is queued while the main model is streaming", async () => {
    const { commands, sentMessages } = await load();
    const ctx = makeContext({ isIdle: () => false });

    await commands.get("agent:reviewer")!.handler("review", ctx);

    expect(sentMessages[0]!.options).toEqual({ deliverAs: "followUp" });
  });

  test("a failed run reports why, rather than an empty answer", async () => {
    const { commands, sentMessages } = await load({
      run: () => execResult({ code: 2, stderr: "unknown agent" }),
    });

    await commands.get("agent:reviewer")!.handler("review", makeContext());

    expect(sentMessages[0]!.content).toContain('subagent "reviewer" exited with code 2');
    expect(sentMessages[0]!.content).toContain("unknown agent");
  });
});

describe("the subagent tool", () => {
  test("is not registered when no agent opted in", async () => {
    const list = execResult({ stdout: JSON.stringify([{ name: "quiet", dir: "/agents/quiet" }]) });
    const { tools, commands } = await load({ list });

    expect(tools.size).toBe(0);
    expect(commands.has("agent:quiet")).toBe(true);
  });

  test("lists only the agents that define a description", async () => {
    const { tools } = await load();
    const tool = tools.get("subagent")!;

    expect(tool.description).toContain("- reviewer: Reviews diffs.");
    expect(tool.description).not.toContain("quiet");
    expect(tool.promptGuidelines?.join(" ")).toContain("After you finish a set of file edits");
  });

  test("returns the agent's answer", async () => {
    const { tools, runCalls } = await load({ run: () => execResult({ stdout: "  findings  \n" }) });

    const result = await tools
      .get("subagent")!
      .execute("call-1", { agent: "reviewer", task: "review" }, undefined, undefined, makeContext());

    expect(argvOf(runCalls()[0]!)).toBe("agent run reviewer review");
    expect(result.content).toEqual([{ type: "text", text: "findings" }]);
    expect(result.isError).toBeUndefined();
  });

  test("refuses an agent the model was never offered", async () => {
    const { tools, calls } = await load();

    const result = await tools
      .get("subagent")!
      .execute("call-1", { agent: "ghost", task: "review" }, undefined, undefined, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown subagent "ghost"');
    expect(result.content[0]!.text).toContain("Available: reviewer");
    expect(calls.filter((call) => call.args[0] === "run")).toHaveLength(0);
  });

  test("a failed run becomes an error result", async () => {
    const { tools } = await load({ run: () => execResult({ code: 1, stderr: "boom" }) });

    const result = await tools
      .get("subagent")!
      .execute("call-1", { agent: "reviewer", task: "review" }, undefined, undefined, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("boom");
  });

  test("shows and clears a status while it runs", async () => {
    const { tools } = await load();
    const ctx = makeContext();

    await tools.get("subagent")!.execute("call-1", { agent: "reviewer", task: "review" }, undefined, undefined, ctx);

    expect(ctx.statuses).toEqual([
      { key: "subagent", text: "running reviewer…" },
      { key: "subagent", text: undefined },
    ]);
  });
});

describe("change tracking", () => {
  test("the tool_call hook records an edit and the next task carries it", async () => {
    const { on, commands, runCalls } = await load();

    await on("tool_call", {
      toolName: "edit",
      input: { path: "/src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
    });
    await commands.get("agent:reviewer")!.handler("review", makeContext());

    const task = runCalls()[0]!.args[2] as string;
    expect(task).toContain("## Changes made in this session");
    expect(task).toContain("- /src/a.ts (+1/-1)");
    expect(task).toContain("Full diff:");
  });

  test("a write records the content it replaced", async () => {
    const { on, commands, runCalls } = await load();
    const path = join(mkdtempSync(join(tmpdir(), "pi-subagents-write-")), "written.txt");
    writeFileSync(path, "before\n");

    await on("tool_call", { toolName: "write", input: { path, content: "after\n" } });
    await commands.get("agent:reviewer")!.handler("review", makeContext());

    const task = runCalls()[0]!.args[2] as string;
    expect(task).toContain(`${path} (+1/-1)`);
    const diffFile = task.split("Full diff: ")[1]!.split(" ")[0]!;
    expect(readFileSync(diffFile, "utf8")).toContain("-before");
    expect(readFileSync(diffFile, "utf8")).toContain("+after");
  });

  test("other tools are ignored", async () => {
    const { on, commands, runCalls } = await load();

    await on("tool_call", { toolName: "bash", input: { command: "ls" } });
    await on("tool_call", { toolName: "read", input: { path: "/src/a.ts" } });
    await commands.get("agent:reviewer")!.handler("review", makeContext());

    const task = runCalls()[0]!.args[2] as string;
    expect(task).toBe("review");
  });

  test("session_start clears what the previous session left behind", async () => {
    const { on, commands, runCalls } = await load();

    await on("tool_call", { toolName: "edit", input: { path: "/src/a.ts", edits: [{ oldText: "old", newText: "new" }] } });
    await on("session_start", { type: "session_start" });
    await commands.get("agent:reviewer")!.handler("review", makeContext());

    expect(runCalls()[0]!.args[2]).toBe("review");
  });
});
