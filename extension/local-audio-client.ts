import * as vscode from "vscode";
import {
  type VSmuxLocalAudioPlayRequest,
  VSMUX_LOCAL_AUDIO_PLAY_COMMAND,
} from "../shared/local-audio-command";

export async function playLocalNotificationSound(options: VSmuxLocalAudioPlayRequest): Promise<void> {
  /**
   * CDXC:Agent-notifications 2026-07-31-14:30
   * VS Code routes commands across local/remote extension hosts, so workspace
   * sessions can request local audio without relying on webview focus.
   */
  try {
    await vscode.commands.executeCommand(VSMUX_LOCAL_AUDIO_PLAY_COMMAND, options);
  } catch {
    // Sound delivery must never block terminal/session state handling.
  }
}
