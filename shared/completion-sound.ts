export const COMPLETION_SOUND_OPTIONS = [
  {
    fileName: "ping.mp3",
    label: "Ping",
    value: "ping",
  },
  {
    fileName: "glimmer.mp3",
    label: "Glimmer",
    value: "glimmer",
  },
  {
    fileName: "arcade.mp3",
    label: "Arcade",
    value: "arcade",
  },
  {
    fileName: "confirmation-003.mp3",
    label: "Confirmation 003",
    value: "confirmation-003",
  },
  {
    fileName: "shamisen.mp3",
    label: "Shamisen",
    value: "shamisen",
  },
  {
    fileName: "success-chime.mp3",
    label: "Success Chime",
    value: "success-chime",
  },
] as const;

export type CompletionSoundSetting = (typeof COMPLETION_SOUND_OPTIONS)[number]["value"];

export const DEFAULT_COMPLETION_SOUND: CompletionSoundSetting = "confirmation-003";

export function clampCompletionSoundSetting(value: string | undefined): CompletionSoundSetting {
  return (
    COMPLETION_SOUND_OPTIONS.find((option) => option.value === value)?.value ??
    DEFAULT_COMPLETION_SOUND
  );
}

export function getCompletionSoundLabel(value: CompletionSoundSetting): string {
  return (
    COMPLETION_SOUND_OPTIONS.find((option) => option.value === value)?.label ??
    getCompletionSoundLabel(DEFAULT_COMPLETION_SOUND)
  );
}

export function getCompletionSoundFileName(value: CompletionSoundSetting): string {
  return (
    COMPLETION_SOUND_OPTIONS.find((option) => option.value === value)?.fileName ??
    getCompletionSoundFileName(DEFAULT_COMPLETION_SOUND)
  );
}
