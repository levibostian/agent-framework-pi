/**
 * The `agent` CLI owns where agents live, how their config is spelled, and how one
 * is run. This module is the whole boundary: discovery in, a finished run out.
 * Nothing here parses a config or knows a config field name.
 */
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/** Runs a command and captures its output. `pi.exec` in pi, a stub in tests. */
export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface AgentEntry {
  name: string;
  description?: string;
  dir: string;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAgentEntry(value: unknown): value is { name: string; dir: string; description?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && typeof entry.dir === "string";
}

/**
 * Every agent the CLI knows about, sorted by name. Read-only: `agent list` never
 * runs an agent or its `system-cmd`.
 *
 * A failure returns an empty list rather than throwing. Discovery runs while pi is
 * starting, so a missing or broken `agent` must cost the extension its agents, not
 * the user their session.
 */
export async function listAgents(exec: ExecFn, bin: string): Promise<AgentEntry[]> {
  const result = await exec(bin, ["list", "--json"], {});

  // `agent list` reports each broken agent on stderr and exits 1, but still prints
  // the valid ones on stdout. So warn, then parse stdout regardless of exit code.
  const stderr = result.stderr.trim();
  if (stderr) console.warn(`[subagents] ${stderr}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    console.warn(
      `[subagents] cannot read agents from "${bin}" (exit ${result.code})` +
        `${stderr ? "" : " — is it installed and on PATH? Set AGENT_BIN to point at it."}`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[subagents] "${bin} list --json" did not return an array`);
    return [];
  }

  return parsed
    .filter(isAgentEntry)
    .map((entry) => ({ name: entry.name, dir: entry.dir, description: asText(entry.description) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Run one agent to completion. The caller decides what to do with the result. */
export function runTask(
  exec: ExecFn,
  bin: string,
  name: string,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  return exec(bin, ["run", name, task], { cwd, signal });
}
