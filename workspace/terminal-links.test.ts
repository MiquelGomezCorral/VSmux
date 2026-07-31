import { describe, expect, test } from "vitest";
import { isPrimaryTerminalLinkActivation } from "./terminal-links";

describe("terminal links", () => {
  test("requires Cmd-click on macOS", () => {
    const baseEvent = { altKey: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false };

    expect(isPrimaryTerminalLinkActivation({ ...baseEvent, metaKey: true }, true)).toBe(true);
    expect(isPrimaryTerminalLinkActivation({ ...baseEvent, ctrlKey: true }, true)).toBe(false);
    expect(isPrimaryTerminalLinkActivation(baseEvent, true)).toBe(false);
  });

  test("requires Ctrl-click outside macOS", () => {
    const baseEvent = { altKey: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false };

    expect(isPrimaryTerminalLinkActivation({ ...baseEvent, ctrlKey: true }, false)).toBe(true);
    expect(isPrimaryTerminalLinkActivation({ ...baseEvent, metaKey: true }, false)).toBe(false);
  });
});
