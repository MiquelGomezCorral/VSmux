import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { getCompletionSoundFileName } from "../shared/completion-sound";
import {
  normalizeLocalAudioPlayRequest,
  VSMUX_LOCAL_AUDIO_PLAY_COMMAND,
} from "../shared/local-audio-command";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(VSMUX_LOCAL_AUDIO_PLAY_COMMAND, (rawRequest: unknown) => {
      const request = normalizeLocalAudioPlayRequest(rawRequest);
      if (!request) {
        return;
      }

      const playerPath = getPlayerPath(context.extensionUri);
      const soundPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        "sounds",
        getCompletionSoundFileName(request.sound),
      ).fsPath;

      execFile(playerPath, [soundPath, String(request.volume)], () => undefined);
    }),
  );
}

function getPlayerPath(extensionUri: vscode.Uri): string {
  /**
   * CDXC:Agent-notifications 2026-07-31-14:30
   * Audio playback is local UI-host work. The workspace extension sends only a
   * validated sound id; this companion resolves bundled media and binaries.
   */
  const executableName = process.platform === "win32" ? "vsmux-play-sound.exe" : "vsmux-play-sound";
  return vscode.Uri.joinPath(
    extensionUri,
    "bin",
    `${process.platform}-${process.arch}`,
    executableName,
  ).fsPath;
}
