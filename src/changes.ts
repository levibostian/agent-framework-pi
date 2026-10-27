/**
 * Every file this session edited or wrote, kept so a subagent can be handed the
 * change instead of the whole repo.
 *
 * Two sources are merged: live tracking from the `tool_call` hook, which is the
 * only place a `write` can still see the pre-write content, and the session
 * transcript, which survives `/reload` and `--resume`. Live wins on duplicates.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateOutput } from "./runner.ts";

export interface ChangeHunk {
  before: string;
  after: string;
}

export interface FileChange {
  path: string;
  hunks: ChangeHunk[];
}

/** The slice of `ExtensionContext` this module needs, so tests can pass a stub. */
export interface SessionLike {
  sessionManager: {
    getBranch(): readonly unknown[];
    getSessionId(): string;
  };
}

const sessionChanges: FileChange[] = [];

export function resetChanges(): void {
  sessionChanges.length = 0;
}

/** Live-track one tool call from the `tool_call` hook, before the change lands. */
export function rememberToolCall(name: string, args: Record<string, unknown>): void {
  const change = changeFromToolCall(name, args, (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return ""; // A file that does not exist yet is a pure addition.
    }
  });
  if (change) sessionChanges.push(change);
}

/**
 * Turn one edit/write tool call's arguments into a change, or undefined.
 *
 * `readCurrent` is passed only for live tracking: a `write` needs the content it is
 * about to replace, and the `tool_call` hook is the last moment that content exists.
 * Rebuilding from the transcript passes nothing, because by then it is gone — the
 * transcript stores no pre-write content, so a reconstructed write reads as an addition.
 */
export function changeFromToolCall(
  name: string | undefined,
  args: Record<string, unknown>,
  readCurrent?: (path: string) => string,
): FileChange | undefined {
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if (!path) return undefined;

  if (name === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const hunks: ChangeHunk[] = [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
      if (typeof oldText === "string" && typeof newText === "string") hunks.push({ before: oldText, after: newText });
    }
    return hunks.length > 0 ? { path, hunks } : undefined;
  }

  if (name === "write" && typeof args.content === "string") {
    return { path, hunks: [{ before: readCurrent ? readCurrent(path) : "", after: args.content }] };
  }

  return undefined;
}

/** Rebuild this session's changes from the transcript, so resume and /reload survive. */
function collectChangesFromBranch(entries: readonly unknown[]): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const call = part as { type?: string; name?: string; arguments?: unknown };
      if (call.type !== "toolCall" || !call.arguments || typeof call.arguments !== "object") continue;
      const change = changeFromToolCall(call.name, call.arguments as Record<string, unknown>);
      if (change) changes.push(change);
    }
  }
  return changes;
}

/** Identity of a change, ignoring `before` so a live write dedupes against its branch copy. */
function changeKey(change: FileChange): string {
  return `${change.path}\u0000${change.hunks.map((hunk) => hunk.after).join("\u0001")}`;
}

/** Live-tracked changes merged with the transcript, live winning on duplicates. */
export function collectChanges(session: SessionLike): FileChange[] {
  const merged = [...sessionChanges];
  const seen = new Set(merged.map(changeKey));
  for (const change of collectChangesFromBranch(session.sessionManager.getBranch())) {
    const key = changeKey(change);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(change);
    }
  }
  return merged;
}

function countLines(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 0 : body.split("\n").length;
}

/** Pseudo-diff of every edit/write this session, grouped by file. */
export function buildSessionDiff(changes: FileChange[]): string {
  const byPath = new Map<string, ChangeHunk[]>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (existing) existing.push(...change.hunks);
    else byPath.set(change.path, [...change.hunks]);
  }

  const lines: string[] = [];
  for (const [path, hunks] of byPath) {
    lines.push(`--- ${path}`, `+++ ${path}`);
    for (const hunk of hunks) {
      for (const line of hunk.before.split("\n")) lines.push(`-${line}`);
      for (const line of hunk.after.split("\n")) lines.push(`+${line}`);
    }
  }
  return lines.join("\n");
}

/** One line per changed file: path and added/removed line counts. */
export function buildChangeIndex(changes: FileChange[]): string {
  const totals = new Map<string, { added: number; removed: number }>();
  for (const change of changes) {
    const total = totals.get(change.path) ?? { added: 0, removed: 0 };
    for (const hunk of change.hunks) {
      total.added += countLines(hunk.after);
      total.removed += countLines(hunk.before);
    }
    totals.set(change.path, total);
  }
  return [...totals].map(([path, total]) => `- ${path} (+${total.added}/-${total.removed})`).join("\n");
}

/** Write the full diff to a session-scoped file; returns the path or undefined. */
function writeDiffFile(session: SessionLike, diff: string): string | undefined {
  try {
    const dir = join(tmpdir(), "pi-subagents");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${session.sessionManager.getSessionId()}.diff`);
    writeFileSync(file, diff, { encoding: "utf8", mode: 0o600 });
    return file;
  } catch (error) {
    console.warn(`[subagents] could not write diff file: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Append a cheap change index and the path to the full diff, if anything changed.
 * The index is small enough to always include; the diff is not, so it goes to a
 * file the agent can read only when it needs the exact text.
 */
export function prepareTask(session: SessionLike, task: string): string {
  const changes = collectChanges(session);
  if (changes.length === 0) return task;

  const diff = buildSessionDiff(changes).trim();
  if (!diff) return task;

  const file = writeDiffFile(session, diff);
  const lines = ["", "## Changes made in this session", "", buildChangeIndex(changes), ""];
  lines.push(file ? `Full diff: ${file} — read it if you need the exact changes.` : truncateOutput(diff));
  return `${task}\n${lines.join("\n")}`;
}
