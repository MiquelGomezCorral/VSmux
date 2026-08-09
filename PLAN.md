<!-- CDXC:TerminalMigration 2026-08-07-14:11 Requirement: define a new, non-destructive native VS Code terminal architecture before implementation. The old native projection must not be revived because it corrupted editor layouts and left ghost/dead terminals. -->

# Native Terminal Migration Plan

## Resolved Decisions

These product decisions are settled. They are the contract for implementation.

## Final Verdict

The lowest-risk implementation is an opt-in terminal-only pilot. Keep the daemon/custom
surface as the default. When `VSmux.terminalSurface` is `vscode-native`, use a fresh
native terminal owner that creates ordinary VS Code terminals, attaches restored terminals
by managed identity, and uses public split-terminal APIs only. Do not revive the historical
workbench projection backend and do not migrate live sessions when the setting changes.

The first code slice must establish the surface selector, the identity/group contract, the
fresh native owner, and controller routing for terminal focus and rendering. Agent wrappers
remain available through a post-shell-integration PATH bootstrap; user shell startup remains
owned by VS Code. T3/browser surfaces continue using their existing paths.

### Surface and scope

- Each VSmux group is one native VS Code terminal editor tab; the group's terminals are native split panes inside that tab.
- VSmux accepts VS Code's native split geometry. It does not reproduce the current 1/2/3/4/6/9 grid by manipulating editor groups.
- The pilot manages only VSmux-created terminals. Arbitrary user-created terminals are never claimed, disposed, moved, or recreated.
- Files, diffs, browsers, and T3 sessions are out of scope for the terminal pilot. T3 and browser sessions keep their current surfaces while native terminal mode is active, and selecting their cards reveals their own surface.

### Session lifecycle

- Inactive groups keep running when the user switches groups. The existing configured idle auto-sleep timeout still applies later.
- Closing a VSmux native terminal through VS Code closes and archives the VSmux session. It is never resurrected automatically.
- Sidebar session order is authoritative. VSmux never repairs or rewrites manual native split/tab rearrangement; it only tracks ownership and the focused session.
- Changing a group worktree affects future terminals only. Live terminals stay in the worktree where they started.
- The first live session anchors the group tab. When it closes, VSmux promotes another live session to anchor. No dedicated shell is created.
- Native close, restart, and repeated switching are idempotent.
- The public API cannot report native split topology, so sidebar order and focus events are the source of truth for terminal ordering.

### Surface switching and migration

- Native terminal mode is an opt-in workspace-level surface setting, separate from the current custom workspace rendering.
- Changing the surface takes effect after a workspace reload and never migrates live sessions in place.
- On reload after a surface change, existing custom sessions are recreated as native terminals: resumable agents resume from metadata, ordinary shells reopen at their persisted cwd, and running shell jobs and exact scrollback do not transfer.
- A session that fails to migrate remains as a stopped session card with history preserved and a manual restart option. Migration failure never reverts to custom rendering.
- Existing sessions are converged onto the selected surface so a group does not permanently mix custom and native surfaces.

### Agent tracking and shell

- Manually typed `opencode`, `claude`, and `codex` inside VSmux-owned native shells keep structured VSmux running/waiting/done tracking and notifications.
- VSmux does not set `shellPath`, `shellArgs`, `PATH`, or `ZDOTDIR` on creation, so VS Code owns the normal profile startup and PATH.
- VSmux passes only identity and state variables at process creation.
- After VS Code native shell integration initializes, VSmux runs a one-time lightweight bootstrap that prepends wrapper paths to the already-resolved PATH and registers tracking hooks. It does not source dotfiles again.
- Bootstrap happens before first reveal.
- If shell integration never becomes ready, the terminal is shown normally, tracking is marked unavailable on the sidebar card, and VSmux never silently switches to the custom renderer.

### Focus and surface behavior

- Selecting a VSmux group reveals and focuses the previously focused native terminal.
- Group switching calls only `terminal.show`. VSmux never calls editor-layout, tab-movement, tab-group, locking, parking, or title-discovery commands.

### Sleep and replay

- Group switching never sleeps terminals immediately; configured idle auto-sleep still applies.
- Moon/sleep stops the native terminal and later resumes the known agent or opens a fresh shell at cwd. Frozen-screen replay is an accepted pilot limitation because the public API does not expose complete scrollback serialization.

## Goal

Replace VSmux's custom terminal rendering path with normal VS Code terminals while keeping VSmux's useful organization:

- VSmux sidebar groups remain the source of truth for session organization.
- Each group may represent a worktree and owns its VSmux-created terminals.
- Selecting a group reveals that group's terminal surface.
- Agent lifecycle tracking, titles, close/kill, restart, notifications, sounds, and session identity remain VSmux features.
- Normal VS Code editor tabs and layouts must not be moved, closed, locked, or rebuilt by VSmux.
- The first migration scope is terminals only. Files, diffs, browsers, and T3 surfaces are explicitly out of scope until terminal behavior is stable.

## Recommended Surface

Use one native **VS Code terminal editor tab per VSmux group**. The group's terminals are native split terminals inside that surface:

```text
VSmux group: Feature A
Worktree: /repo/worktrees/feature-a

Native terminal editor surface
|- OpenCode
|- Claude
`- Shell
```

Selecting another VSmux group reveals that group's anchor terminal. This keeps VSmux's group concept while letting VS Code own terminal rendering, shell profiles, PATH, terminal search, scrollback, persistence, and input handling.

The first version accepts VS Code's native split arrangement. VSmux must not attempt to reproduce its current 1/2/3/4/6/9 grid by manipulating editor groups.

## Explicitly Avoid

Do not reuse the deleted historical editor-projection backend as the coordinator. Do not bring back:

- `vscode.setEditorLayout`.
- `workbench.action.moveEditorToLeftGroup` or `moveEditorToRightGroup`.
- `workbench.action.terminal.moveToEditor` or `moveToTerminalPanel`.
- `workbench.action.openEditorAtIndex*`.
- Editor-group lock/unlock commands.
- Title-based terminal discovery.
- Polling the workbench until tab movement settles.
- Park/restore cycles that move all terminals around the user's workbench.

Those mechanisms caused the known ghost-terminal, dead-terminal, focus, and editor-layout failures.

## Ownership Model

Introduce a fresh native terminal owner, for example `NativeTerminalGroupManager`, rather than reviving the old projection backend.

```text
groupId -> {
  anchorTerminal: vscode.Terminal,
  terminalIds: sessionId[]
}

sessionId -> vscode.Terminal
vscode.Terminal -> sessionId
```

The manager owns only terminals created by VSmux. It does not claim arbitrary user-created terminals.

Session/group state remains in the existing VSmux store and controller. The manager owns the live VS Code object bindings and lifecycle events.

## Terminal Creation

The first terminal in a group is created in the editor area. Additional terminals are created beside an existing group terminal using the public `TerminalSplitLocationOptions` API.

Conceptually:

```ts
const anchor = vscode.window.createTerminal({
  cwd: groupWorktreePath,
  env: managedIdentityEnvironment,
  iconPath: new vscode.ThemeIcon("terminal"),
  name: groupTerminalName,
  location: { viewColumn: vscode.ViewColumn.Active },
});

const child = vscode.window.createTerminal({
  cwd: groupWorktreePath,
  env: managedIdentityEnvironment,
  name: sessionName,
  location: { parentTerminal: anchor },
});
```

The actual implementation must use the repository's session and agent-launch data rather than introducing a second session model.

## Shell and PATH

Native terminal creation must not reconstruct the extension-host PATH. It must allow VS Code's selected terminal profile to provide the normal shell behavior.

For the reported macOS case, normal VS Code launches `/bin/zsh -il`; VSmux currently launches `/bin/zsh`. The native path must preserve the selected VS Code profile and avoid the custom daemon `ZDOTDIR` path unless agent instrumentation specifically requires it.

VSmux may add identity and state-file variables such as `VSMUX_SESSION_ID`, `VSMUX_WORKSPACE_ID`, `VSMUX_SESSION_STATE_FILE`, and `VSMUX_SHELL_STATE_FILE`. It must not overwrite PATH with a guessed or stale extension-host value.

Agent wrappers and notification hooks must remain reachable without breaking the user's normal shell startup. This needs an explicit implementation/test seam before migration is considered complete.

## Group Switching

Group switching should be deliberately small:

1. Update the VSmux active group in the existing store.
2. Resolve the group's live anchor terminal.
3. Call `anchorTerminal.show(false)` to reveal/focus the group's native terminal surface.
4. Create only terminals that are genuinely missing.
5. Do not modify unrelated editor tabs, editor groups, or user terminals.

Other groups remain alive and may remain represented in VS Code's terminal list. The public VS Code API does not provide per-terminal hiding within the shared terminal panel/editor surface. This is an accepted first-version limitation unless the user chooses a different surface later.

## Worktrees and CWD

- A group's worktree path is the default `cwd` for newly created sessions in that group.
- A terminal's existing process must not be silently moved to a new cwd when the group worktree changes.
- Session creation from the current directory keeps its explicit cwd.
- Recreated sessions use the stored group worktree unless a more specific persisted session cwd exists.

## Lifecycle

### Create

Sidebar session creation adds a VSmux session record, then the native manager creates or attaches the corresponding VS Code terminal and binds it by managed identity.

### Attach and reload

On activation/reload:

- Inspect `vscode.window.terminals` once.
- Resolve VSmux ownership from managed environment identity, never from terminal title alone.
- Rebind matching terminals.
- Recreate missing terminals only when their VSmux session is expected to be live.

VS Code persistent terminal sessions remain VS Code-owned. VSmux must not create duplicate terminals when VS Code restores one.

### Close and kill

- VSmux close removes the VSmux session and disposes its owned terminal.
- A user-closing an owned terminal updates the VSmux session snapshot and sidebar state.
- Close operations must be idempotent and race-safe.
- Unowned terminals must never be disposed by VSmux.

### Restart

Restart disposes the owned terminal and creates a new one using the same VSmux session identity, group worktree, agent command, and persisted session metadata.

### Sleep

Native mode should initially use a conservative policy: keep live sessions alive when merely switching groups; only dispose/recreate on explicit sleep or existing auto-sleep rules.

Exact VSmux moon replay is not assumed to be available because the public VS Code terminal API does not expose complete scrollback serialization. This is a known design gap that must not be hidden behind fake replay behavior.

## Agent State and Notifications

Keep the existing extension-host state pipeline where possible:

- Managed environment identity.
- Agent wrapper commands.
- OpenCode state files and process ownership.
- Claude hooks.
- Codex notifications.
- Activity polling and transition logic.
- Completion sounds and attention acknowledgement.

The terminal renderer should not own agent lifecycle detection. Native VS Code terminal events can supplement activity, but they must not replace structured agent state.

## Implementation Phases

### Phase 0: Contract and safety tests

- Define the fresh manager's ownership maps and lifecycle contract.
- Add tests proving group switching does not call workbench layout or tab mutation commands.
- Add tests for managed identity attach and duplicate prevention.
- Add tests for worktree cwd selection.
- Add tests for close/restart race behavior.

### Phase 1: Native terminal pilot

- Add a new opt-in terminal engine/mode for VSmux-managed terminal sessions.
- Keep the current custom webview path available for comparison.
- Implement native group surfaces for terminal-only groups.
- Preserve sidebar state and agent notifications.
- Do not migrate T3 or browser sessions.

### Phase 2: macOS shell validation

- Verify native VSmux terminals report `/bin/zsh -il` or the user's selected VS Code profile.
- Verify `docker`, `zoxide`, `oh-my-posh`, Homebrew, Bun, Miniconda, and OpenCode are available.
- Verify group worktree cwd and shell prompt state.
- Verify no stale daemon PATH is involved.

### Phase 3: Performance and stability comparison

Compare the same workload in:

- Normal VS Code terminal.
- Native VSmux terminal mode.
- Current xterm mode.
- Current Ghostty/Restty mode.

Measure startup latency, output throughput, CPU usage, memory usage, WebGL context loss, visual repaint behavior under load, and VS Code crash/reload behavior.

### Phase 4: Decide whether to promote

Promote native mode only if it improves macOS rendering and shell correctness without damaging ordinary VS Code tabs or creating duplicate/ghost terminals.

## Acceptance Criteria

- Switching VSmux groups never changes editor layout.
- Switching VSmux groups never closes, moves, locks, or reorders unrelated user tabs.
- Each VSmux-created terminal has one stable session identity.
- Reload attaches restored terminals without duplicates.
- Close, restart, and repeated switching are idempotent.
- Group-created terminals start in the group's worktree.
- Native VSmux macOS terminals use the user's normal VS Code shell profile and PATH.
- `docker`, `zoxide`, and `oh-my-posh` work without VSmux-specific PATH hacks.
- Agent running/waiting/question/done indicators and notifications continue to work.
- Native terminal search and scrollback work through VS Code.
- The native pilot does not require the old `NativeTerminalWorkspaceBackend` workbench projection logic.
- Performance is measured against the current renderer before claiming success.

## Implementation Steps

### 1. Surface setting

- Add a workspace-level `VSmux.terminalSurface` setting with values `workspace` and `vscode-native`.
- Cache the selected surface at activation.
- Changing the setting shows a reload-required notice and never migrates live terminals in place.

### 2. Fresh native owner

- Introduce a fresh `NativeTerminalGroupManager`.
- Do not reuse the deleted historical editor-projection coordinator as the manager.
- The manager owns terminal objects and binds them by managed environment identity, not by title.

### 3. Terminal creation

- Create the group anchor terminal in the editor area with `location: { viewColumn }`.
- Create children with `location: { parentTerminal }`.
- Omit `shellPath`, `shellArgs`, `PATH`, and `ZDOTDIR` overrides.
- Pass only VSmux identity and state variables at creation.
- Use the group worktree as the cwd for newly created sessions; explicit per-session cwd wins over it.

### 4. Bootstrap and tracking

- After native shell integration initializes, run a one-time VSmux bootstrap that prepends wrapper paths to the shell's resolved PATH and registers hooks.
- Do not source user dotfiles again.
- Keep existing structured agent state files, hooks, activity transitions, notifications, and sounds.
- Mark a card as tracking unavailable if bootstrap cannot run; do not fall back to the custom renderer.

### 5. Group switching

- Update the active VSmux group in the store.
- Resolve the group's remembered focused terminal.
- Call `terminal.show(false)`.
- Create only genuinely missing terminals.
- Never call layout, tab-movement, locking, parking, or title-discovery commands.

### 6. Lifecycle events

- Attach restored terminals by managed identity on activation and reload.
- Prevent duplicate terminals when VS Code restores persistent sessions.
- Native close archives the VSmux session without resurrection.
- Restart disposes and recreates the owned terminal under the same session identity.
- Promote another live terminal to anchor when the current anchor closes.

### 7. Surface convergence on reload

- On reload after a surface change, converge each terminal session onto the selected surface.
- Resume known agents from metadata; reopen ordinary shells at persisted cwd.
- Mark failed migrations as stopped sessions; keep history and offer manual restart.
- Remove the opposite-owned surface for converged sessions.

### 8. Sleep and auto-sleep

- Group switching leaves inactive groups running.
- Apply the existing configured idle auto-sleep timeout to native sessions.
- Moon/sleep stops the native terminal and resumes the known agent or opens a fresh shell at cwd without frozen-screen replay.

### 9. Pilot validation

- Run the workload comparison across normal VS Code terminal, native VSmux terminal mode, current xterm, and current Ghostty/Restty.
- Measure startup latency, output throughput, CPU, memory, WebGL context loss, repaint behavior under load, and VS Code crash/reload behavior.
- Promote native mode only if it improves macOS rendering and shell correctness without damaging ordinary tabs or creating duplicate/ghost terminals.

## Current Implementation Status

<!-- CDXC:TerminalMigration 2026-08-07-14:11 Requirement: record which pilot guarantees are implemented so surface convergence is not mistaken for complete while the opposite-surface cleanup contract is still pending. -->

Implemented in the current worktree:

- Workspace-level `VSmux.terminalSurface` selection with reload-required behavior.
- Fresh native terminal ownership with managed identity, group identity, public split creation, duplicate prevention, anchor promotion, close archival, restart metadata/CWD preservation, and native focus.
- Native shell integration PATH bootstrap gated before focus and programmatic terminal writes; unavailable integration is reported on the session snapshot without custom-surface fallback.
- Native terminal panes excluded from the custom workspace panel while T3/browser surfaces remain on their existing paths.
- Surface convergence now retires the workspace-scoped daemon before native convergence and removes only identity-owned native terminals before custom-surface convergence.
- Focused identity, split, bootstrap, duplicate, close, anchor, and restart regression tests.

Still pending as a separate convergence phase:

- Failure-to-stopped-state tests and user-facing manual restart behavior for every migration error path.
- Cross-surface migration tests and the Phase 2-4 shell/performance validation workload.

## Relevant Existing Code

- `extension/native-terminal-workspace/controller.ts`
- `extension/terminal-workspace-backend.ts`
- `extension/daemon-terminal-workspace-backend.ts`
- `extension/native-managed-terminal.ts`
- `extension/native-terminal-process-identity.ts`
- `extension/session-state-file.ts`
- `extension/native-terminal-workspace/activity.ts`
- `extension/native-terminal-workspace/group-focus.ts`
- `extension/session-grid-store.ts`
- `shared/session-grid-contract-core.ts`
