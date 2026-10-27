import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChangeIndex,
  buildSessionDiff,
  changeFromToolCall,
  collectChanges,
  prepareTask,
  rememberToolCall,
  resetChanges,
} from "../src/changes.ts";
import { sessionWith, toolCallEntry } from "./helpers.ts";

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  const path = join(dir, "file.ts");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

describe("changeFromToolCall", () => {
  test("reads an edit's hunks", () => {
    const change = changeFromToolCall("edit", {
      path: "/a.ts",
      edits: [
        { oldText: "one", newText: "two" },
        { oldText: "three", newText: "four" },
      ],
    });

    expect(change).toEqual({
      path: "/a.ts",
      hunks: [
        { before: "one", after: "two" },
        { before: "three", after: "four" },
      ],
    });
  });

  test("accepts file_path and drops incomplete edits", () => {
    expect(changeFromToolCall("edit", { file_path: "/a.ts", edits: [{ oldText: "one" }, { newText: "two" }] })).toBeUndefined();
    expect(changeFromToolCall("edit", { file_path: "/a.ts", edits: [{ oldText: "one", newText: "two" }] })?.path).toBe("/a.ts");
  });

  test("a call with no path, no edits, or an unrelated tool yields nothing", () => {
    expect(changeFromToolCall("edit", { edits: [{ oldText: "a", newText: "b" }] })).toBeUndefined();
    expect(changeFromToolCall("edit", { path: "/a.ts", edits: [] })).toBeUndefined();
    expect(changeFromToolCall("bash", { path: "/a.ts", content: "x" })).toBeUndefined();
    expect(changeFromToolCall(undefined, { path: "/a.ts" })).toBeUndefined();
  });

  test("reads a write's previous content only when a reader is supplied", () => {
    const existing = tempFile("old contents");

    const reconstructed = changeFromToolCall("write", { path: existing, content: "new" });
    expect(reconstructed?.hunks).toEqual([{ before: "", after: "new" }]);

    const live = changeFromToolCall("write", { path: existing, content: "new" }, (path) => readFileSync(path, "utf8"));
    expect(live?.hunks).toEqual([{ before: "old contents", after: "new" }]);
  });

  test("a write to a file that does not exist yet is a pure addition", () => {
    resetChanges();
    const missing = join(tempFile(), "..", "not-created.ts");

    expect(changeFromToolCall("write", { path: missing, content: "new" }, () => "")?.hunks).toEqual([
      { before: "", after: "new" },
    ]);

    // Live tracking reads the file itself; a missing one must not throw.
    rememberToolCall("write", { path: missing, content: "new" });
    expect(collectChanges(sessionWith([]))[0]?.hunks).toEqual([{ before: "", after: "new" }]);
    resetChanges();
  });
});

describe("collectChanges", () => {
  test("includes live-tracked changes", () => {
    resetChanges();
    rememberToolCall("edit", { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(collectChanges(sessionWith([]))).toEqual([{ path: "/a.ts", hunks: [{ before: "a", after: "b" }] }]);
  });

  test("rebuilds from the transcript, so resume and reload survive", () => {
    resetChanges();
    const branch = [
      toolCallEntry("edit", { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] }),
      toolCallEntry("write", { path: "/b.ts", content: "hello" }),
      toolCallEntry("read", { path: "/c.ts" }),
      { message: { role: "user", content: "hi" } },
      { message: { role: "assistant", content: [{ type: "text", text: "no call here" }] } },
      "garbage",
    ];

    expect(collectChanges(sessionWith(branch))).toEqual([
      { path: "/a.ts", hunks: [{ before: "a", after: "b" }] },
      { path: "/b.ts", hunks: [{ before: "", after: "hello" }] },
    ]);
  });

  test("a live write beats its transcript copy", () => {
    resetChanges();
    const path = tempFile("old");
    const branch = [toolCallEntry("write", { path, content: "new" })];
    rememberToolCall("write", { path, content: "new" });

    const changes = collectChanges(sessionWith(branch));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.hunks).toEqual([{ before: "old", after: "new" }]);
  });

  test("resetChanges clears what the previous session left behind", () => {
    resetChanges();
    rememberToolCall("edit", { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] });
    resetChanges();
    expect(collectChanges(sessionWith([]))).toEqual([]);
  });
});

describe("buildSessionDiff", () => {
  test("groups hunks by file and marks before and after", () => {
    const diff = buildSessionDiff([
      { path: "/a.ts", hunks: [{ before: "old", after: "new" }] },
      { path: "/a.ts", hunks: [{ before: "x", after: "y" }] },
      { path: "/b.ts", hunks: [{ before: "", after: "added" }] },
    ]);

    expect(diff).toBe(
      [
        "--- /a.ts",
        "+++ /a.ts",
        "-old",
        "+new",
        "-x",
        "+y",
        "--- /b.ts",
        "+++ /b.ts",
        "-",
        "+added",
      ].join("\n"),
    );
  });
});

describe("buildChangeIndex", () => {
  test("totals added and removed lines per file", () => {
    const index = buildChangeIndex([
      { path: "/a.ts", hunks: [{ before: "one\ntwo\n", after: "one" }] },
      { path: "/a.ts", hunks: [{ before: "", after: "three\nfour" }] },
      { path: "/b.ts", hunks: [{ before: "", after: "" }] },
    ]);

    expect(index).toBe(["- /a.ts (+3/-2)", "- /b.ts (+0/-0)"].join("\n"));
  });
});

describe("prepareTask", () => {
  test("returns the task untouched when nothing changed", () => {
    resetChanges();
    expect(prepareTask(sessionWith([]), "review this")).toBe("review this");
  });

  test("appends a change index and a path to the full diff", () => {
    resetChanges();
    rememberToolCall("edit", { path: "/a.ts", edits: [{ oldText: "old", newText: "new" }] });

    const task = prepareTask(sessionWith([]), "review this");

    expect(task.startsWith("review this\n\n## Changes made in this session\n\n- /a.ts (+1/-1)\n")).toBe(true);
    const file = task.split("Full diff: ")[1]?.split(" ")[0] as string;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("-old\n+new");
    resetChanges();
  });

  test("the diff file is named after the session", () => {
    resetChanges();
    rememberToolCall("edit", { path: "/a.ts", edits: [{ oldText: "old", newText: "new" }] });

    expect(prepareTask(sessionWith([], "abc-123"), "task")).toContain(`/pi-subagents/abc-123.diff`);
    resetChanges();
  });
});
