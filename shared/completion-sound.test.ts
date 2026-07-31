import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  COMPLETION_SOUND_OPTIONS,
  DEFAULT_COMPLETION_SOUND,
  clampCompletionSoundSetting,
  getCompletionSoundFileName,
  getCompletionSoundLabel,
} from "./completion-sound";

type CompletionSoundManifestEntry = {
  default: string;
  enum: string[];
  enumItemLabels: string[];
};

const completionSoundManifest = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    contributes: { configuration: Record<string, CompletionSoundManifestEntry> };
  }
).contributes.configuration;

describe("completion sound settings", () => {
  test("should keep supported sound ids", () => {
    expect(clampCompletionSoundSetting("glimmer")).toBe("glimmer");
    expect(clampCompletionSoundSetting("shamisen")).toBe("shamisen");
  });

  test("should fall back to the default sound for unknown ids", () => {
    expect(clampCompletionSoundSetting(undefined)).toBe(DEFAULT_COMPLETION_SOUND);
    expect(clampCompletionSoundSetting("nope")).toBe(DEFAULT_COMPLETION_SOUND);
    expect(clampCompletionSoundSetting("glass")).toBe(DEFAULT_COMPLETION_SOUND);
  });

  test("should expose labels and filenames for supported sounds", () => {
    expect(getCompletionSoundLabel("ping")).toBe("Ping");
    expect(getCompletionSoundFileName("ping")).toBe("ping.mp3");
    expect(getCompletionSoundLabel("success-chime")).toBe("Success Chime");
    expect(getCompletionSoundFileName("success-chime")).toBe("success-chime.mp3");
    expect(getCompletionSoundLabel("shamisen")).toBe("Shamisen");
    expect(getCompletionSoundFileName("shamisen")).toBe("shamisen.mp3");
  });

  test("should include the bundled sound variants in the picker order", () => {
    expect(COMPLETION_SOUND_OPTIONS.map((option) => option.value)).toEqual([
      "ping",
      "glimmer",
      "arcade",
      "confirmation-003",
      "shamisen",
      "success-chime",
    ]);
  });

  test("should keep VS Code sound actions synchronized with the catalog", () => {
    const values = COMPLETION_SOUND_OPTIONS.map((option) => option.value);
    const labels = COMPLETION_SOUND_OPTIONS.map((option) => option.label);

    for (const setting of ["VSmux.completionSound", "VSmux.actionCompletionSound"]) {
      const entry = completionSoundManifest[setting];
      expect(entry?.default).toBe(DEFAULT_COMPLETION_SOUND);
      expect(entry?.enum).toEqual(values);
      expect(entry?.enumItemLabels).toEqual(labels);
    }
  });
});
