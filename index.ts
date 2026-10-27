/**
 * Subagents — expose the standalone `agent` CLI to pi two ways:
 *
 *   /agent:<name> <task>   you run it (every agent)
 *   subagent tool          the model runs it (only agents that define a description)
 *
 * The `agent` CLI owns where agents live, how their config is spelled, and how a run
 * is composed. This extension discovers agents through it, registers the user command
 * for all of them, and registers one model-callable `subagent` tool listing only the
 * agents that opted in. An agent with no description stays user-only.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAgents, runTask, type AgentEntry, type ExecFn } from "./src/agent-cli.ts";
import { prepareTask, rememberToolCall, resetChanges } from "./src/changes.ts";
import { answerOf, failureText } from "./src/runner.ts";

/** Slash-command names allow no spaces or colons, and neither does an agent name. */
const VALID_NAME = /^[\w.-]+$/;

/** One status line is shared by the command and the tool, so they overwrite each other. */
const STATUS_KEY = "subagent";

/** The model-callable tool, present only when at least one agent opts in. */
const SubagentParams = Type.Object({
  agent: Type.String({ description: "Name of the subagent to run. Must be one of the names listed above." }),
  task: Type.String({
    description:
      "The task to delegate. The subagent cannot see this conversation, so include the files and context it needs.",
  }),
});

export default async function (pi: ExtensionAPI) {
  const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
  // `AGENT_BIN` points at an install that is not on PATH.
  const bin = process.env.AGENT_BIN || "agent";

  const agents = (await listAgents(exec, bin)).filter((agent) => {
    if (VALID_NAME.test(agent.name)) return true;
    console.warn(`[subagents] skipping "${agent.name}": name must match ${VALID_NAME}`);
    return false;
  });

  // Changes are per session, so drop whatever the previous one left behind.
  pi.on("session_start", () => {
    resetChanges();
  });

  // Record every edit/write so a subagent task can carry the actual change.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    rememberToolCall(event.toolName, event.input as Record<string, unknown>);
  });

  // User path: every agent gets a `/agent:<name>` command.
  for (const agent of agents) {
    pi.registerCommand(`agent:${agent.name}`, {
      description: `Delegate a task to the "${agent.name}" subagent`,
      handler: async (args, ctx) => {
        const task = args.trim();
        if (!task) {
          ctx.ui.notify(`Usage: /agent:${agent.name} <task>`, "warning");
          return;
        }
        ctx.ui.notify(`Running subagent "${agent.name}"…`, "info");

        ctx.ui.setStatus(STATUS_KEY, `running ${agent.name}…`);
        try {
          const result = await runTask(exec, bin, agent.name, prepareTask(ctx, task), ctx.cwd, ctx.signal);
          const answer = answerOf(result);
          const message =
            answer === undefined ? failureText(agent.name, result) : `[subagent "${agent.name}" output]\n${answer}`;
          // Idle → start a turn now; streaming → queue so the main model still sees it.
          if (ctx.isIdle()) pi.sendUserMessage(message);
          else pi.sendUserMessage(message, { deliverAs: "followUp" });
        } finally {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      },
    });
  }

  // Model path: one tool, listing only the agents that define a description.
  const callable = agents.filter((agent) => agent.description);
  if (callable.length === 0) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a task to a specialized subagent. It runs in its own isolated pi process and returns only its final answer.",
      "The subagent cannot see this conversation — put everything it needs (file paths, the exact scope, what you already changed) in `task`.",
      "",
      "Available subagents:",
      ...callable.map((agent) => `- ${agent.name}: ${agent.description}`),
    ].join("\n"),
    promptSnippet: "Delegate a task to a specialized subagent",
    promptGuidelines: [
      "After you finish a set of file edits, call the `subagent` tool for any listed subagent whose description says to use it after editing files, passing the exact files you edited, then apply its suggestions.",
    ],
    parameters: SubagentParams,
    execute: async (_toolCallId, params: Static<typeof SubagentParams>, signal, _onUpdate, ctx) => {
      const agent = callable.find((entry) => entry.name === params.agent);
      if (!agent) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown subagent "${params.agent}". Available: ${callable.map((a) => a.name).join(", ")}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      ctx.ui.setStatus(STATUS_KEY, `running ${agent.name}…`);
      try {
        const result = await runTask(exec, bin, agent.name, prepareTask(ctx, params.task), ctx.cwd, signal);
        const answer = answerOf(result);
        if (answer !== undefined) {
          return { content: [{ type: "text" as const, text: answer }], details: undefined };
        }
        return {
          content: [{ type: "text" as const, text: failureText(agent.name, result) }],
          details: undefined,
          isError: true,
        };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
