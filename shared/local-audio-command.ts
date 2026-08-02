import {
  clampCompletionSoundSetting,
  type CompletionSoundSetting,
} from "./completion-sound";

export const VSMUX_LOCAL_AUDIO_PLAY_COMMAND = "VSmuxLocalAudio.playNotificationSound";

export type VSmuxLocalAudioPlayRequest = {
  sound: CompletionSoundSetting;
  volume: number;
};

export function normalizeLocalAudioPlayRequest(
  value: unknown,
): VSmuxLocalAudioPlayRequest | undefined {
  /**
   * CDXC:Agent-notifications 2026-07-31-14:30
   * Remote workspaces must ask a local UI extension to play validated bundled
   * sounds; never pass remote filesystem paths or arbitrary commands.
   */
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<Record<keyof VSmuxLocalAudioPlayRequest, unknown>>;
  const volume = typeof candidate.volume === "number" ? candidate.volume : 1;
  return {
    sound: clampCompletionSoundSetting(
      typeof candidate.sound === "string" ? candidate.sound : undefined,
    ),
    volume: Math.max(0, Math.min(1, volume)),
  };
}
