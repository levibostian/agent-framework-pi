import { describe, expect, test } from "bun:test";
import { answerOf, failureText, truncateOutput } from "../src/runner.ts";
import { execResult } from "./helpers.ts";

describe("truncateOutput", () => {
  test("leaves short output alone", () => {
    expect(truncateOutput("hello")).toBe("hello");
    expect(truncateOutput("hello", 5)).toBe("hello");
  });

  test("cuts to the cap and says how much was dropped", () => {
    const capped = truncateOutput("abcdefghij", 4);

    expect(capped).toBe("abcd\n\n[Output truncated: 6 bytes omitted]");
  });

  test("never cuts a multi-byte character in half", () => {
    const capped = truncateOutput("éééé", 5);

    expect(capped.startsWith("éé")).toBe(true);
    expect(capped).toContain("[Output truncated:");
    expect(Buffer.byteLength(capped.split("\n\n")[0] as string, "utf8")).toBeLessThanOrEqual(5);
  });
});

describe("answerOf", () => {
  test("returns the trimmed answer of a successful run", () => {
    expect(answerOf(execResult({ stdout: "  the answer  \n" }))).toBe("the answer");
  });

  test("returns nothing for a failed run or an empty answer", () => {
    expect(answerOf(execResult({ stdout: "partial", code: 1 }))).toBeUndefined();
    expect(answerOf(execResult({ stdout: "   \n" }))).toBeUndefined();
  });
});

describe("failureText", () => {
  test("names the exit code and shows stderr", () => {
    expect(failureText("reviewer", execResult({ code: 3, stderr: "no such agent\n" }))).toBe(
      '[subagent "reviewer" exited with code 3]\nno such agent',
    );
  });

  test("falls back to stdout when there is no stderr", () => {
    expect(failureText("reviewer", execResult({ code: 1, stdout: "something went wrong" }))).toBe(
      '[subagent "reviewer" exited with code 1]\nsomething went wrong',
    );
  });

  test("distinguishes a killed run and a silent success", () => {
    expect(failureText("reviewer", execResult({ killed: true }))).toBe('[subagent "reviewer" killed]');
    expect(failureText("reviewer", execResult({ code: 0, stdout: "  " }))).toBe(
      '[subagent "reviewer" returned no output]',
    );
  });

  test("truncates a long explanation", () => {
    const text = failureText("reviewer", execResult({ code: 1, stderr: "x".repeat(60 * 1024) }));

    expect(text).toContain("[Output truncated:");
  });
});
