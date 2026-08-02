import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_COMPLETION_SOUND } from "./completion-sound";
import { normalizeLocalAudioPlayRequest } from "./local-audio-command";

describe("local audio command", () => {
  test("normalizes trusted sound ids and clamps volume", () => {
    expect(normalizeLocalAudioPlayRequest({ sound: "ping", volume: 2 })).toEqual({
      sound: "ping",
      volume: 1,
    });
  });

  test("rejects non-object payloads and normalizes unknown sounds", () => {
    expect(normalizeLocalAudioPlayRequest(undefined)).toBeUndefined();
    expect(normalizeLocalAudioPlayRequest({ sound: "../../bad", volume: -1 })).toEqual({
      sound: DEFAULT_COMPLETION_SOUND,
      volume: 0,
    });
  });
});
