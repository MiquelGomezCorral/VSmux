import { describe, expect, test } from "vite-plus/test";
import type { WorkspacePanelPane } from "../shared/workspace-panel-contract";
import {
  buildFullSessionOrderFromVisiblePaneOrder,
  buildVisiblePaneOrderForDrop,
  sortPanesBySessionIds,
  sortVisiblePanesBySlotIndex,
} from "./workspace-pane-reorder";

describe("buildVisiblePaneOrderForDrop", () => {
  test("should insert the dragged pane at the target slot and keep non-reorderable panes fixed", () => {
    expect(
      buildVisiblePaneOrderForDrop(
        ["terminal-1", "t3-1", "terminal-2", "terminal-3"],
        ["terminal-1", "terminal-2", "terminal-3"],
        "terminal-3",
        "terminal-1",
      ),
    ).toEqual(["terminal-3", "t3-1", "terminal-1", "terminal-2"]);
  });

  test("should place a pane after the target when dragging from left to right", () => {
    expect(
      buildVisiblePaneOrderForDrop(
        ["terminal-1", "terminal-2"],
        ["terminal-1", "terminal-2"],
        "terminal-1",
        "terminal-2",
      ),
    ).toEqual(["terminal-2", "terminal-1"]);
  });

  test("should shift middle panes when moving a terminal across the grid", () => {
    expect(
      buildVisiblePaneOrderForDrop(
        ["terminal-1", "terminal-2", "terminal-3"],
        ["terminal-1", "terminal-2", "terminal-3"],
        "terminal-1",
        "terminal-3",
      ),
    ).toEqual(["terminal-2", "terminal-3", "terminal-1"]);
  });

  test("should return undefined when the drop target is the dragged pane", () => {
    expect(
      buildVisiblePaneOrderForDrop(
        ["terminal-1", "terminal-2"],
        ["terminal-1", "terminal-2"],
        "terminal-1",
        "terminal-1",
      ),
    ).toBeUndefined();
  });
});

describe("buildFullSessionOrderFromVisiblePaneOrder", () => {
  test("should append hidden sessions after the visible pane order", () => {
    expect(
      buildFullSessionOrderFromVisiblePaneOrder(
        ["terminal-1", "terminal-2", "terminal-3", "terminal-4"],
        ["terminal-3", "terminal-1"],
      ),
    ).toEqual(["terminal-3", "terminal-1", "terminal-2", "terminal-4"]);
  });
});

describe("sortPanesBySessionIds", () => {
  test("should sort panes to match the provided session order", () => {
    const panes: WorkspacePanelPane[] = [
      createTerminalPane("terminal-2"),
      createTerminalPane("terminal-3"),
      createTerminalPane("terminal-1"),
    ];

    expect(sortPanesBySessionIds(panes, ["terminal-1", "terminal-2", "terminal-3"])).toEqual([
      createTerminalPane("terminal-1"),
      createTerminalPane("terminal-2"),
      createTerminalPane("terminal-3"),
    ]);
  });
});

describe("sortVisiblePanesBySlotIndex", () => {
  test("should sort visible panes by their explicit visible slot index", () => {
    const panes: WorkspacePanelPane[] = [
      createTerminalPane("terminal-2", { visibleSlotIndex: 1 }),
      createTerminalPane("terminal-3", { visibleSlotIndex: 2 }),
      createTerminalPane("terminal-1", { visibleSlotIndex: 0 }),
    ];

    expect(sortVisiblePanesBySlotIndex(panes)).toEqual([
      createTerminalPane("terminal-1", { visibleSlotIndex: 0 }),
      createTerminalPane("terminal-2", { visibleSlotIndex: 1 }),
      createTerminalPane("terminal-3", { visibleSlotIndex: 2 }),
    ]);
  });
});

function createTerminalPane(
  sessionId: string,
  options?: {
    visibleSlotIndex?: number;
  },
): WorkspacePanelPane {
  return {
    isVisible: true,
    kind: "terminal",
    sessionId,
    visibleSlotIndex: options?.visibleSlotIndex,
    sessionRecord: {
      alias: sessionId,
      column: 0,
      createdAt: new Date(0).toISOString(),
      displayId: sessionId,
      kind: "terminal",
      row: 0,
      sessionId,
      slotIndex: 0,
      terminalEngine: "ghostty-non-persistent",
      title: sessionId,
    },
  };
}
