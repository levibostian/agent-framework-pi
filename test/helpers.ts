import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export { type ExecResult, type ExtensionCommandContext, type ExtensionContext };
import type { ExecFn } from "../src/agent-cli.ts";

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

export interface ExecCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

/**
 * A stand-in for `pi.exec` that records every call. `handler` decides the result,
 * so a test can serve different answers for `list` and `run`.
 */
export function fakeExec(handler: (command: string, args: string[]) => ExecResult | Promise<ExecResult>) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, options });
    return await handler(command, args);
  };
  return { exec, calls };
}

/** Every argv the extension would hand to the CLI, newline-free for easy assertions. */
export function argvOf(call: ExecCall): string {
  return [call.command, ...call.args].join(" ");
}

export interface RegisteredCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { agent: string; task: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

export interface FakePi {
  pi: ExtensionAPI;
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, RegisteredTool>;
  on: (event: string, payload: unknown, ctx?: unknown) => Promise<void>;
  sentMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
}

/** An `ExtensionAPI` that records what the extension registers, and can fire events. */
export function makeFakePi(exec: ExecFn): FakePi {
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sentMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];

  const pi = {
    exec,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      sentMessages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    tools,
    sentMessages,
    on: async (event, payload, ctx = makeContext()) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

export type FakeContext = ExtensionContext &
  ExtensionCommandContext & {
    notifications: Array<{ message: string; level: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
  };

/** A context stub with the session, working directory and UI the extension touches. */
export function makeContext(overrides: Record<string, unknown> = {}): FakeContext {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  return {
    cwd: "/work",
    signal: undefined,
    isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    },
    notifications,
    statuses,
    ...overrides,
  } as unknown as FakeContext;
}

/** A session whose transcript holds the given entries. */
export function sessionWith(entries: readonly unknown[], id = "session-1") {
  return { sessionManager: { getBranch: () => entries, getSessionId: () => id } };
}

/** One assistant tool call, as the transcript stores it. */
export function toolCallEntry(name: string, args: Record<string, unknown>) {
  return { message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
}

/** Run something with `console.warn` captured, for asserting on extension diagnostics. */
export async function withWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}
