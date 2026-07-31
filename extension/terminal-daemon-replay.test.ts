import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { describe, expect, test } from "vite-plus/test";
import { TerminalDaemonRingBuffer } from "./terminal-daemon-ring-buffer";
import {
  createTerminalReplayChunks,
  createPendingAttachQueue,
  createTerminalReplaySnapshot,
  splitTerminalReplaySnapshot,
  queuePendingAttachChunk,
  serializeTerminalReplayHistory,
  trimTerminalReplayHistory,
} from "./terminal-daemon-replay";

describe("createTerminalReplaySnapshot", () => {
  test("should retain an active alternate-screen view for session replay", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(64);

    historyBuffer.write(Buffer.from("\u001b[?1049h\u001b[Hbuild output\r\n"));

    expect(createTerminalReplaySnapshot(historyBuffer)).toEqual(
      Buffer.from("\u001b[?1049h\u001b[Hbuild output\r\n"),
    );
  });

  test("should skip a wrapped partial utf8 prefix in the binary replay path", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(4);

    historyBuffer.write(Buffer.from("A🙂B", "utf8"));

    expect(createTerminalReplaySnapshot(historyBuffer).toString("utf8")).toBe("B");
  });

  test("should skip a wrapped partial OSC sequence in the binary replay path", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(6);

    historyBuffer.write(Buffer.from("\u001b]0;title\u0007ok", "utf8"));

    expect(createTerminalReplaySnapshot(historyBuffer).toString("utf8")).toBe("ok");
  });
});

describe("createTerminalReplayChunks", () => {
  test("should split the replay snapshot into ordered chunks", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(64);

    historyBuffer.write(Buffer.from("0123456789abcdef", "utf8"));

    expect(createTerminalReplayChunks(historyBuffer, historyBuffer.bytesWritten, 5)).toEqual([
      Buffer.from("01234"),
      Buffer.from("56789"),
      Buffer.from("abcde"),
      Buffer.from("f"),
    ]);
  });

  test("should preserve the tail when replay and live output are stitched at the ready cursor", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(64);

    historyBuffer.write(Buffer.from("before-ready\n", "utf8"));
    const pendingAttachQueue = createPendingAttachQueue(historyBuffer.bytesWritten);
    const replayChunks = createTerminalReplayChunks(
      historyBuffer,
      pendingAttachQueue.replayCursor,
      5,
    );

    const liveChunk = Buffer.from("after-ready\n", "utf8");
    queuePendingAttachChunk(
      pendingAttachQueue,
      liveChunk,
      historyBuffer.bytesWritten,
      historyBuffer.bytesWritten + liveChunk.length,
    );

    expect(Buffer.concat([...replayChunks, ...pendingAttachQueue.chunks]).toString("utf8")).toBe(
      "before-ready\nafter-ready\n",
    );
  });
});

describe("serializeTerminalReplayHistory", () => {
  test("should expose the buffered VT stream as a utf8 string when the buffer starts cleanly", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(16);

    historyBuffer.write(Buffer.from("prompt\r\noutput\r\n", "utf8"));

    expect(serializeTerminalReplayHistory(historyBuffer)).toBe("prompt\r\noutput\r\n");
  });

  test("should drop a wrapped partial utf8 prefix before serializing", () => {
    const historyBuffer = new TerminalDaemonRingBuffer(4);

    historyBuffer.write(Buffer.from("A🙂B", "utf8"));

    expect(serializeTerminalReplayHistory(historyBuffer)).toBe("B");
  });
});

describe("trimTerminalReplayHistory", () => {
  test("should preserve a safe tail when persisted scrollback exceeds its cap", () => {
    expect(trimTerminalReplayHistory("\u001b]0;title\u0007ok", 6)).toBe("ok");
  });
});

describe("rendered xterm replay", () => {
  test("should restore an active alternate-screen view", async () => {
    const source = new HeadlessTerminal({ allowProposedApi: true, cols: 20, rows: 3 });
    const serializeAddon = new SerializeAddon();
    source.loadAddon(serializeAddon);
    await writeHeadlessTerminal(source, "normal output\r\n\u001b[?1049h\u001b[Hbuild output");

    const restored = new HeadlessTerminal({ allowProposedApi: true, cols: 20, rows: 3 });
    await writeHeadlessTerminal(restored, serializeAddon.serialize({ excludeModes: true }));

    expect(restored.buffer.active.type).toBe("alternate");
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("build output");
  });
});

describe("queuePendingAttachChunk", () => {
  test("should ignore chunks that end at or before the replay cursor", () => {
    const pendingAttachQueue = createPendingAttachQueue(5);

    queuePendingAttachChunk(pendingAttachQueue, Buffer.from("hello"), 0, 5);

    expect(pendingAttachQueue.chunks).toEqual([]);
  });

  test("should queue whole chunks that start after the replay cursor", () => {
    const pendingAttachQueue = createPendingAttachQueue(5);

    queuePendingAttachChunk(pendingAttachQueue, Buffer.from(" world"), 5, 11);

    expect(pendingAttachQueue.chunks).toEqual([Buffer.from(" world")]);
  });

  test("should queue only the unseen suffix when a chunk straddles the replay cursor", () => {
    const pendingAttachQueue = createPendingAttachQueue(3);

    queuePendingAttachChunk(pendingAttachQueue, Buffer.from("hello"), 0, 5);

    expect(pendingAttachQueue.chunks).toEqual([Buffer.from("lo")]);
  });
});

describe("splitTerminalReplaySnapshot", () => {
  test("should keep the full snapshot as one frame when it already fits", () => {
    expect(splitTerminalReplaySnapshot(Buffer.from("hello"), 16)).toEqual([Buffer.from("hello")]);
  });

  test("should split large snapshots into ordered chunks", () => {
    expect(splitTerminalReplaySnapshot(Buffer.from("abcdefgh"), 3)).toEqual([
      Buffer.from("abc"),
      Buffer.from("def"),
      Buffer.from("gh"),
    ]);
  });

  test("should return no frames for an empty snapshot", () => {
    expect(splitTerminalReplaySnapshot(Buffer.alloc(0), 3)).toEqual([]);
  });
});

function writeHeadlessTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}
