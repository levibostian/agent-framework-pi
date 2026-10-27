import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** Cap model-facing output, and say how much was dropped so the model can ask for less. */
export function truncateOutput(text: string, cap = 50 * 1024): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= cap) return text;

  let truncated = text.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
  const omitted = bytes - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted]`;
}

/** The agent's final answer, or undefined when the run produced none. */
export function answerOf(result: ExecResult): string | undefined {
  return result.code === 0 && result.stdout.trim() ? truncateOutput(result.stdout.trim()) : undefined;
}

/**
 * What the model sees when a run produced no answer. A silent empty result would
 * read as success, so name the reason and include whatever the run did say.
 */
export function failureText(name: string, result: ExecResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const reason = result.killed
    ? "killed"
    : result.code === 0
      ? "returned no output"
      : `exited with code ${result.code}`;
  return `[subagent "${name}" ${reason}]${detail ? `\n${truncateOutput(detail)}` : ""}`;
}
