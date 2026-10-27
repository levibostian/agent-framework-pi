import { describe, expect, test } from "bun:test";
import { listAgents, runTask } from "../src/agent-cli.ts";
import { argvOf, execResult, fakeExec, withWarnings } from "./helpers.ts";

describe("listAgents", () => {
  test("asks the CLI for JSON and returns agents sorted by name", async () => {
    const { exec, calls } = fakeExec(() =>
      execResult({
        stdout: JSON.stringify([
          { name: "reviewer", description: "Reviews diffs.", dir: "/agents/reviewer" },
          { name: "alpha", dir: "/agents/alpha" },
        ]),
      }),
    );

    const agents = await listAgents(exec, "agent");

    expect(argvOf(calls[0]!)).toBe("agent list --json");
    expect(agents).toEqual([
      { name: "alpha", dir: "/agents/alpha", description: undefined },
      { name: "reviewer", description: "Reviews diffs.", dir: "/agents/reviewer" },
    ]);
  });

  test("keeps the valid agents when the CLI reports a broken one on stderr and exits 1", async () => {
    const { exec } = fakeExec(() =>
      execResult({
        stdout: JSON.stringify([{ name: "ok", description: "Fine.", dir: "/agents/ok" }]),
        stderr: "agent: broken agent: bad/agent.yaml: unknown key \"colour\"",
        code: 1,
      }),
    );

    const warnings = await withWarnings(async () => {
      const agents = await listAgents(exec, "agent");
      expect(agents.map((agent) => agent.name)).toEqual(["ok"]);
    });

    expect(warnings.join("\n")).toContain("unknown key");
  });

  test("a missing or unusable CLI costs the agents, not the session", async () => {
    const { exec } = fakeExec(() => execResult({ code: 1 }));

    const warnings = await withWarnings(async () => {
      expect(await listAgents(exec, "agent")).toEqual([]);
    });

    expect(warnings.join("\n")).toContain("AGENT_BIN");
  });

  test("stdout that is not a JSON array yields no agents", async () => {
    for (const stdout of ["not json", "{}", "null"]) {
      const { exec } = fakeExec(() => execResult({ stdout }));
      const warnings = await withWarnings(async () => {
        expect(await listAgents(exec, "npm-agent")).toEqual([]);
      });
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  test("entries without a name or directory are dropped", async () => {
    const { exec } = fakeExec(() =>
      execResult({
        stdout: JSON.stringify([
          { name: "ok", dir: "/agents/ok" },
          { name: "no-dir" },
          { dir: "/agents/no-name" },
          "nonsense",
          null,
        ]),
      }),
    );

    expect((await listAgents(exec, "agent")).map((agent) => agent.name)).toEqual(["ok"]);
  });

  test("a blank description is treated as absent, so the agent stays user-only", async () => {
    const { exec } = fakeExec(() =>
      execResult({ stdout: JSON.stringify([{ name: "quiet", dir: "/agents/quiet", description: "   " }]) }),
    );

    expect((await listAgents(exec, "agent"))[0]?.description).toBeUndefined();
  });
});

describe("runTask", () => {
  test("runs the named agent with the task, in the caller's directory", async () => {
    const { exec, calls } = fakeExec(() => execResult({ stdout: "the answer" }));
    const controller = new AbortController();

    const result = await runTask(exec, "agent", "reviewer", "review this", "/work", controller.signal);

    expect(argvOf(calls[0]!)).toBe("agent run reviewer review this");
    expect(calls[0]!.options).toEqual({ cwd: "/work", signal: controller.signal });
    expect(result.stdout).toBe("the answer");
  });

  test("a task with newlines and quotes stays one argument", async () => {
    const { exec, calls } = fakeExec(() => execResult());

    await runTask(exec, "agent", "reviewer", 'line one\nline "two"', "/work", undefined);

    expect(calls[0]!.args).toEqual(["run", "reviewer", 'line one\nline "two"']);
    expect(calls[0]!.options).toEqual({ cwd: "/work", signal: undefined });
  });
});
