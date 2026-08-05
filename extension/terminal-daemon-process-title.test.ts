import { describe, expect, test } from "vite-plus/test";
import { getSessionPresentationTitle, waitForSessionStop } from "./terminal-daemon-process";

describe("getSessionPresentationTitle", () => {
  test("should preserve ordinary live titles", () => {
    expect(getSessionPresentationTitle("Implement title filtering")).toBe(
      "Implement title filtering",
    );
  });

  test("should drop bare agent titles for presentation", () => {
    expect(getSessionPresentationTitle("Codex")).toBeUndefined();
    expect(getSessionPresentationTitle("Codex CLI")).toBeUndefined();
    expect(getSessionPresentationTitle("OpenAI Codex")).toBeUndefined();
    expect(getSessionPresentationTitle("Claude")).toBeUndefined();
    expect(getSessionPresentationTitle("Claude Code")).toBeUndefined();
    expect(getSessionPresentationTitle("⠸ Codex")).toBeUndefined();
    expect(getSessionPresentationTitle("✳ Claude Code")).toBeUndefined();
  });

  test("should sanitize OpenCode prefixed titles for presentation", () => {
    expect(getSessionPresentationTitle("OC | Project overview question")).toBe(
      "Project overview question",
    );
  });

  test("should drop empty OpenCode prefixed titles after sanitization", () => {
    expect(getSessionPresentationTitle("OC |   ")).toBeUndefined();
  });
});

describe("waitForSessionStop", () => {
  test("waits for a terminal teardown before replacement", async () => {
    let resolveStop: (() => void) | undefined;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    let didFinishWaiting = false;
    const waitPromise = waitForSessionStop({ isStopping: true, stopPromise }).then(() => {
      didFinishWaiting = true;
    });

    await Promise.resolve();
    expect(didFinishWaiting).toBe(false);
    resolveStop?.();

    await expect(waitPromise).resolves.toBeUndefined();
  });

  test("rejects a replacement while a failed teardown remains stopping", async () => {
    await expect(waitForSessionStop({ isStopping: true })).rejects.toThrow(
      "VSmux terminal session teardown did not complete.",
    );
  });
});
