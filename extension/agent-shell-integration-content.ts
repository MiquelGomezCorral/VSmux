import { quoteShellLiteral } from "./agent-shell-integration-utils";

export type AgentWrapperName = "claude" | "codex" | "gemini" | "opencode";

export function getAgentWrapperShellScriptContent(
  agentName: AgentWrapperName,
  options: {
    binDir: string;
    claudeSettingsPath: string;
    debugLogPath: string;
    notifyPath: string;
    opencodeConfigDir: string;
    wrapperRunnerPath: string;
  },
): string {
  return `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec ${quoteShellLiteral(process.execPath)} ${quoteShellLiteral(options.wrapperRunnerPath)} --agent ${quoteShellLiteral(agentName)} --bin-dir ${quoteShellLiteral(options.binDir)} --claude-settings-path ${quoteShellLiteral(options.claudeSettingsPath)} --debug-log-path ${quoteShellLiteral(options.debugLogPath)} --notify-runner-path ${quoteShellLiteral(options.notifyPath)} --opencode-config-dir ${quoteShellLiteral(options.opencodeConfigDir)} -- "$@"
`;
}

export function getAgentWrapperCmdContent(
  agentName: AgentWrapperName,
  options: {
    binDir: string;
    claudeSettingsPath: string;
    debugLogPath: string;
    notifyPath: string;
    opencodeConfigDir: string;
    wrapperRunnerPath: string;
  },
): string {
  return `@echo off
setlocal
set "_vsmux_node="
for %%I in (node.exe) do set "_vsmux_node=%%~$PATH:I"
if defined _vsmux_node (
  "%_vsmux_node%" "${options.wrapperRunnerPath}" --agent ${agentName} --bin-dir "${options.binDir}" --claude-settings-path "${options.claudeSettingsPath}" --debug-log-path "${options.debugLogPath}" --notify-runner-path "${options.notifyPath}" --opencode-config-dir "${options.opencodeConfigDir}" -- %*
) else (
  set ELECTRON_RUN_AS_NODE=1
  "${process.execPath}" "${options.wrapperRunnerPath}" --agent ${agentName} --bin-dir "${options.binDir}" --claude-settings-path "${options.claudeSettingsPath}" --debug-log-path "${options.debugLogPath}" --notify-runner-path "${options.notifyPath}" --opencode-config-dir "${options.opencodeConfigDir}" -- %*
)
`;
}

export function getClaudeNotifyCommandContent(notifyPath: string): string {
  if (process.platform === "win32") {
    return `@echo off
setlocal
set VSMUX_AGENT=claude
set ELECTRON_RUN_AS_NODE=1
"${process.execPath}" "${notifyPath}" %*
`;
  }

  return `#!/bin/sh
export VSMUX_AGENT=claude
export ELECTRON_RUN_AS_NODE=1
exec ${quoteShellLiteral(process.execPath)} ${quoteShellLiteral(notifyPath)} "$@"
`;
}

export function getClaudeHookSettingsContent(
  notifyPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const command = platform === "win32" ? `"${notifyPath}"` : quoteShellLiteral(notifyPath);

  return `${JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        StopFailure: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        PermissionDenied: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        Elicitation: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        ElicitationResult: [
          {
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
        Notification: [
          {
            matcher: "permission_prompt",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export function getBashRcShimContent(binDir: string): string {
  const quotedBinDir = quoteShellLiteral(binDir);
  const quotedClaudeWrapperPath = quoteShellLiteral(`${binDir}/claude`);

  /**
   * CDXC:Terminal-cwd 2026-07-29-21:45
   * Bash prompt hooks record the live directory only after a prompt is ready.
   * Input transport clears the idle state before user text reaches the PTY.
   */
  return `export CLAUDE_BIN=${quotedClaudeWrapperPath}

if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

export PATH=${quotedBinDir}:$PATH
export CLAUDE_BIN=${quotedClaudeWrapperPath}
hash -r 2>/dev/null || true
unalias claude 2>/dev/null || true
unalias codex 2>/dev/null || true
unalias gemini 2>/dev/null || true
unalias opencode 2>/dev/null || true

if [ -z "\${__VSMUX_BASH_HOOKS_INSTALLED:-}" ]; then
  __VSMUX_BASH_HOOKS_INSTALLED=1

  __vsmux_write_shell_state() {
    local prompt_idle="$1"
    local state_file="\${VSMUX_SHELL_STATE_FILE:-}"
    local state_dir tmp_file line

    [ -n "$state_file" ] || return 0
    case "$PWD" in
      *$'\r'*|*$'\n'*) return 0 ;;
    esac
    state_dir="\${state_file%/*}"
    if [ "$state_dir" != "$state_file" ] && ! mkdir -p -- "$state_dir"; then
      return 0
    fi

    tmp_file="$state_file.tmp.$$"
    {
      if [ -r "$state_file" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
          case "$line" in
            cwd=*|shellPromptIdle=*) ;;
            *) printf '%s\\n' "$line" ;;
          esac
        done < "$state_file"
      fi
      printf 'cwd=%s\\n' "$PWD"
      printf 'shellPromptIdle=%s\\n' "$prompt_idle"
    } > "$tmp_file" && mv -f -- "$tmp_file" "$state_file"
  }

  __vsmux_mark_prompt_idle() {
    __vsmux_write_shell_state 1
  }

  __vsmux_mark_command_started() {
    __vsmux_write_shell_state 0
  }

  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    "declare -a"*) PROMPT_COMMAND+=(__vsmux_mark_prompt_idle) ;;
    *) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }__vsmux_mark_prompt_idle" ;;
  esac
  PS0='$( __vsmux_mark_command_started )'"\${PS0-}"
fi
`;
}

export function getZshEnvShimContent(): string {
  return `if [ -f "$HOME/.zshenv" ]; then
  . "$HOME/.zshenv"
fi
`;
}

export function getZshPassThroughShimContent(
  fileName: ".zprofile" | ".zlogin" | ".zlogout",
): string {
  return `if [ -f "$HOME/${fileName}" ]; then
  . "$HOME/${fileName}"
fi
`;
}

export function getZshRcShimContent(binDir: string): string {
  const quotedBinDir = quoteShellLiteral(binDir);
  const quotedClaudeWrapperPath = quoteShellLiteral(`${binDir}/claude`);

  return `export CLAUDE_BIN=${quotedClaudeWrapperPath}

if [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc"
fi

export PATH=${quotedBinDir}:$PATH
export CLAUDE_BIN=${quotedClaudeWrapperPath}
rehash 2>/dev/null || true
unalias claude 2>/dev/null || true
unalias codex 2>/dev/null || true
unalias gemini 2>/dev/null || true
unalias opencode 2>/dev/null || true

if [ -z "$__VSMUX_ZSH_HOOKS_INSTALLED" ]; then
  typeset -g __VSMUX_ZSH_HOOKS_INSTALLED=1

  __vsmux_read_state_value() {
    emulate -L zsh
    local state_file="\${VSMUX_SESSION_STATE_FILE:-}"
    local wanted_key="$1"

    [ -n "$state_file" ] || return 1
    [ -r "$state_file" ] || return 1

    local key value
    while IFS='=' read -r key value; do
      if [ "$key" = "$wanted_key" ]; then
        value=\${value//$'\\r'/ }
        value=\${value//$'\\n'/ }
        value=\${value//$'\\t'/ }
        if [ -n "$value" ]; then
          printf '%s' "$value"
          return 0
        fi

        return 1
      fi
    done < "$state_file"

    return 1
  }

  __vsmux_emit_session_title() {
    emulate -L zsh
    local title="$1"
    [ -n "$title" ] || return 0
    printf '\\033]0;%s\\007' "$title" > /dev/tty
  }

  __vsmux_read_session_title() {
    emulate -L zsh
    __vsmux_read_state_value title
  }

  __vsmux_restore_session_title() {
    emulate -L zsh
    local title="$(__vsmux_read_session_title)"
    [ -n "$title" ] || return 0
    __vsmux_emit_session_title "$title"
  }

  __vsmux_write_session_title() {
    emulate -L zsh
    local state_file="\${VSMUX_SESSION_STATE_FILE:-}"
    local title="$1"

    [ -n "$state_file" ] || return 0

    title=\${title//$'\\r'/ }
    title=\${title//$'\\n'/ }
    title=\${title//$'\\t'/ }

    mkdir -p -- "\${state_file:h}" || return 0
    local tmp_file="$state_file.tmp.$$"
    {
      if [ -r "$state_file" ]; then
        local line
        while IFS= read -r line || [ -n "$line" ]; do
          case "$line" in
            title=*) ;;
            *) printf '%s\\n' "$line" ;;
          esac
        done < "$state_file"
      fi
      printf 'title=%s\\n' "$title"
    } >| "$tmp_file" && mv -f -- "$tmp_file" "$state_file"
  }

  __vsmux_write_shell_state() {
    emulate -L zsh
    local state_file="\${VSMUX_SHELL_STATE_FILE:-}"
    local prompt_idle="$1"

    [ -n "$state_file" ] || return 0
    case "$PWD" in
      *$'\r'*|*$'\n'*) return 0 ;;
    esac
    mkdir -p -- "\${state_file:h}" || return 0
    local tmp_file="$state_file.tmp.$$"
    {
      if [ -r "$state_file" ]; then
        local line
        while IFS= read -r line || [ -n "$line" ]; do
          case "$line" in
            cwd=*|shellPromptIdle=*) ;;
            *) printf '%s\\n' "$line" ;;
          esac
        done < "$state_file"
      fi
      printf 'cwd=%s\\n' "$PWD"
      printf 'shellPromptIdle=%s\\n' "$prompt_idle"
    } >| "$tmp_file" && mv -f -- "$tmp_file" "$state_file"
  }

  vsmux_set_title() {
    emulate -L zsh
    __vsmux_write_session_title "$*"
    __vsmux_emit_session_title "$*"
  }

  alias vam-title='vsmux_set_title'

  autoload -Uz add-zsh-hook 2>/dev/null || true
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    __vsmux_before_command() {
      __vsmux_write_shell_state 0
      __vsmux_restore_session_title
    }

    __vsmux_prompt_ready() {
      __vsmux_write_shell_state 1
      __vsmux_restore_session_title
    }

    add-zsh-hook preexec __vsmux_before_command
    add-zsh-hook precmd __vsmux_prompt_ready
  fi
fi

claude() {
  command ${quotedBinDir}/claude "$@"
}
codex() {
  command ${quotedBinDir}/codex "$@"
}
gemini() {
  command ${quotedBinDir}/gemini "$@"
}
opencode() {
  command ${quotedBinDir}/opencode "$@"
}
`;
}

export function getPowerShellBootstrapContent(): string {
  return `$ErrorActionPreference = "SilentlyContinue"

$profileCandidates = @(
  $PROFILE.CurrentUserAllHosts,
  $PROFILE.CurrentUserCurrentHost,
  $PROFILE.AllUsersAllHosts,
  $PROFILE.AllUsersCurrentHost
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

foreach ($profilePath in $profileCandidates) {
  if (Test-Path -LiteralPath $profilePath) {
    . $profilePath
  }
}

if (-not (Get-Variable -Name __VSMUX_POWERSHELL_INIT -Scope Global -ErrorAction SilentlyContinue)) {
  $global:__VSMUX_POWERSHELL_INIT = $true

  function global:__vsmux_normalize_title([string]$Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) {
      return $null
    }

    return (($Title -replace "[\`r\`n\`t]+", " " -replace "\\s+", " ").Trim())
  }

  function global:__vsmux_read_state_value([string]$WantedKey) {
    $stateFile = $env:VSMUX_SESSION_STATE_FILE
    if ([string]::IsNullOrWhiteSpace($stateFile) -or -not (Test-Path -LiteralPath $stateFile)) {
      return $null
    }

    foreach ($line in [System.IO.File]::ReadAllLines($stateFile)) {
      $separatorIndex = $line.IndexOf("=")
      if ($separatorIndex -lt 0) {
        continue
      }

      $key = $line.Substring(0, $separatorIndex)
      if ($key -ne $WantedKey) {
        continue
      }

      $value = $line.Substring($separatorIndex + 1).Trim()
      if ([string]::IsNullOrWhiteSpace($value)) {
        return $null
      }

      return $value
    }

    return $null
  }

  function global:__vsmux_write_session_title([string]$Title) {
    $stateFile = $env:VSMUX_SESSION_STATE_FILE
    if ([string]::IsNullOrWhiteSpace($stateFile)) {
      return
    }

    $normalizedTitle = __vsmux_normalize_title $Title
    $persistedTitle = ""
    if ($null -ne $normalizedTitle) {
      $persistedTitle = [string]$normalizedTitle
    }

    $directory = [System.IO.Path]::GetDirectoryName($stateFile)
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }

    $tmpFile = "$stateFile.tmp.$PID"
    $nextLines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $stateFile) {
      foreach ($line in [System.IO.File]::ReadAllLines($stateFile)) {
        if ($line.StartsWith("title=")) {
          continue
        }

        $nextLines.Add($line)
      }
    }
    $nextLines.Add("title=$persistedTitle")
    [System.IO.File]::WriteAllLines($tmpFile, $nextLines)
    Move-Item -LiteralPath $tmpFile -Destination $stateFile -Force
  }

  function global:__vsmux_write_shell_state([bool]$IsPromptIdle) {
    $stateFile = $env:VSMUX_SHELL_STATE_FILE
    if ([string]::IsNullOrWhiteSpace($stateFile)) {
      return
    }

    $currentLocation = $executionContext.SessionState.Path.CurrentLocation.Path
    if ($currentLocation.IndexOf([char]13) -ge 0 -or $currentLocation.IndexOf([char]10) -ge 0) {
      return
    }

    $directory = [System.IO.Path]::GetDirectoryName($stateFile)
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }

    $tmpFile = "$stateFile.tmp.$PID"
    $nextLines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $stateFile) {
      foreach ($line in [System.IO.File]::ReadAllLines($stateFile)) {
        if ($line.StartsWith("cwd=") -or $line.StartsWith("shellPromptIdle=")) {
          continue
        }

        $nextLines.Add($line)
      }
    }
    $nextLines.Add("cwd=$currentLocation")
    $nextLines.Add("shellPromptIdle=$(if ($IsPromptIdle) { '1' } else { '0' })")
    [System.IO.File]::WriteAllLines($tmpFile, $nextLines)
    Move-Item -LiteralPath $tmpFile -Destination $stateFile -Force
  }

  function global:__vsmux_emit_session_title([string]$Title) {
    $normalizedTitle = __vsmux_normalize_title $Title
    if ([string]::IsNullOrWhiteSpace($normalizedTitle)) {
      return
    }

    [System.Console]::Out.Write("$([char]27)]0;$normalizedTitle$([char]7)")
  }

  function global:__vsmux_get_current_title() {
    $title = $null
    try {
      $title = $Host.UI.RawUI.WindowTitle
    } catch {}

    if ([string]::IsNullOrWhiteSpace($title)) {
      try {
        $title = [Console]::Title
      } catch {}
    }

    return __vsmux_normalize_title $title
  }

  function global:__vsmux_sync_current_title() {
    $title = __vsmux_get_current_title
    if ([string]::IsNullOrWhiteSpace($title)) {
      $title = __vsmux_normalize_title (__vsmux_read_state_value "title")
    }

    if ([string]::IsNullOrWhiteSpace($title)) {
      return
    }

    try {
      $Host.UI.RawUI.WindowTitle = $title
    } catch {}

    try {
      [Console]::Title = $title
    } catch {}

    __vsmux_write_session_title $title
    __vsmux_emit_session_title $title
  }

  function global:vsmux_set_title {
    param(
      [Parameter(ValueFromRemainingArguments = $true)]
      [string[]]$TitleParts
    )

    $title = __vsmux_normalize_title ($TitleParts -join " ")
    if ([string]::IsNullOrWhiteSpace($title)) {
      return
    }

    try {
      $Host.UI.RawUI.WindowTitle = $title
    } catch {}

    try {
      [Console]::Title = $title
    } catch {}

    __vsmux_write_session_title $title
    __vsmux_emit_session_title $title
  }

  Set-Alias -Name vam-title -Value vsmux_set_title -Scope Global

  $global:__vsmux_prompt_idle_supported = $false
  $readLineCommand = Get-Command -Name PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue
  if ($readLineCommand) {
    $global:__vsmux_original_read_line = $readLineCommand.ScriptBlock
    function global:PSConsoleHostReadLine {
      $line = & $global:__vsmux_original_read_line
      __vsmux_write_shell_state $false
      return $line
    }
    $global:__vsmux_prompt_idle_supported = $true
  }

  $global:__vsmux_original_prompt = if (Test-Path Function:\\prompt) {
    (Get-Item Function:\\prompt).ScriptBlock
  } else {
    $null
  }

  function global:prompt {
    if ($global:__vsmux_prompt_idle_supported) {
      __vsmux_write_shell_state $true
    }
    __vsmux_sync_current_title
    if ($global:__vsmux_original_prompt) {
      & $global:__vsmux_original_prompt
      return
    }

    "PS $($executionContext.SessionState.Path.CurrentLocation)> "
  }
}

__vsmux_sync_current_title
`;
}

export function getOpenCodePluginContent(notifyPath: string, nodePath: string): string {
  return `/**
 * VSmux notification plugin for OpenCode.
 */
export const VSmuxNotifyPlugin = async ({ client }) => {
  if (globalThis.__vsmuxNotifyPluginV1) return {};
  globalThis.__vsmuxNotifyPluginV1 = true;

  const currentSessionId = process?.env?.VSMUX_SESSION_ID;
  if (!currentSessionId) return {};

  const notifyPath = ${JSON.stringify(notifyPath)};
  const nodePath = ${JSON.stringify(nodePath)};
  let currentState = "idle";
  let rootSessionId = null;
  let stopSent = false;
  const childSessionCache = new Map();
  const waitingRequestIds = new Set();

  const notify = async (eventName) => {
    const payload = JSON.stringify({
      agent: "opencode",
      hook_event_name: eventName,
    });

    try {
      const { spawn } = await import("node:child_process");
      await new Promise((resolve) => {
        const child = spawn(nodePath, [notifyPath, payload], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            VSMUX_AGENT: "opencode",
          },
          stdio: "ignore",
        });
        child.once("error", () => resolve(undefined));
        child.once("exit", () => resolve(undefined));
      });
    } catch {
      // best effort only
    }
  };

  const isChildSession = async (sessionId) => {
    if (!sessionId) {
      return true;
    }
    if (!client?.session?.list) {
      return true;
    }
    if (childSessionCache.has(sessionId)) {
      return childSessionCache.get(sessionId);
    }

    try {
      const sessions = await client.session.list();
      const session = sessions.data?.find((candidate) => candidate.id === sessionId);
      const isChild = !!session?.parentID;
      childSessionCache.set(sessionId, isChild);
      return isChild;
    } catch {
      return true;
    }
  };

  const isSessionActive = (status) => status?.type && status.type !== "idle";

  const handleBusy = async (sessionId) => {
    if (!rootSessionId) {
      rootSessionId = sessionId;
    }

    if (sessionId !== rootSessionId) {
      return;
    }

    if (waitingRequestIds.size > 0) {
      return;
    }

    if (currentState !== "busy") {
      currentState = "busy";
      stopSent = false;
      await notify("Start");
      return;
    }
  };

  const handleStop = async (sessionId) => {
    if (rootSessionId && sessionId !== rootSessionId) {
      return;
    }

    if (waitingRequestIds.size > 0) {
      return;
    }

    if (currentState !== "idle" && !stopSent) {
      currentState = "idle";
      stopSent = true;
      rootSessionId = null;
      await notify("Stop");
    }
  };

  const handleWaiting = async (sessionId, requestId) => {
    if (!rootSessionId) {
      rootSessionId = sessionId;
    }

    if (sessionId !== rootSessionId) {
      return;
    }

    waitingRequestIds.add(requestId);

    if (currentState !== "waiting") {
      currentState = "waiting";
      stopSent = false;
      await notify("Wait");
    }
  };

  const handleUserReply = async (sessionId, requestId) => {
    if (rootSessionId && sessionId !== rootSessionId) {
      return;
    }

    waitingRequestIds.delete(requestId);

    if (currentState === "waiting" && waitingRequestIds.size === 0) {
      currentState = "busy";
      stopSent = false;
      await notify("Start");
    }
  };

  const syncInitialStatus = async () => {
    if (!client?.session?.status) {
      return;
    }

    if (await isChildSession(currentSessionId)) {
      return;
    }

    try {
      const statuses = await client.session.status();
      const status = statuses.data?.[currentSessionId];
      if (isSessionActive(status)) {
        await handleBusy(currentSessionId);
        return;
      }

      if (status?.type === "idle") {
        await handleStop(currentSessionId);
      }
    } catch {
      // best effort only
    }
  };

  setTimeout(() => {
    void syncInitialStatus();
  }, 0);

  return {
    event: async ({ event }) => {
      const sessionId = event.properties?.sessionID;
      if (await isChildSession(sessionId)) {
        return;
      }

      const requestId = event.properties?.id ?? event.properties?.requestID;
      if (event.type === "permission.asked" || event.type === "question.asked") {
        if (!requestId) {
          return;
        }
        await handleWaiting(sessionId, requestId);
        return;
      }

      if (
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
      ) {
        if (!requestId) {
          return;
        }
        await handleUserReply(sessionId, requestId);
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (isSessionActive(status)) {
          await handleBusy(sessionId);
        } else if (status?.type === "idle") {
          await handleStop(sessionId);
        }
      }

      if (event.type === "session.busy") {
        await handleBusy(sessionId);
      }

      if (event.type === "session.idle") {
        await handleStop(sessionId);
      }

      if (event.type === "session.error") {
        waitingRequestIds.clear();
        await handleStop(sessionId);
      }
    },
  };
};
`;
}
