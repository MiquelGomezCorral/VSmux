import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  isTerminalWorkspaceSearchTarget,
  TERMINAL_WORKSPACE_FILENAME_SOURCE,
} from "../shared/terminal-path-link";

const MAX_LINKS_PER_LINE = 10;
const MAX_LOGICAL_LINE_LENGTH = 2_000;

type TerminalPathLinkKind = "path" | "search";

export type TerminalPathLink = {
  column?: number;
  end: number;
  kind: TerminalPathLinkKind;
  line?: number;
  path: string;
  start: number;
  text: string;
};

type TerminalPathLinkProviderOptions = {
  activate: (event: MouseEvent, link: TerminalPathLink) => void;
  isWindows: boolean;
  terminal: Terminal;
};

const QUOTED_PATH_PATTERN =
  /(["'])(file:\/\/\/?|\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)([^"']*)\1(?<suffix>(?::|#)\d+(?:[:.]\d+)?|(?:,|:)?\s+line\s+\d+(?:,\s*(?:col(?:umn)?|character)\s+\d+)?|\s*\(\d+(?:[,:]\s*\d+)?\))?/giu;
const PATH_TOKEN_PATTERN =
  /(?:file:\/\/\/?[^\s<>"'`()[\]{}]+|(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])[^\s<>"'`()[\]{}]+|[^\s<>"'`()[\]{}]+[\\/][^\s<>"'`()[\]{}]+)/gu;
const SEARCH_TOKEN_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])${TERMINAL_WORKSPACE_FILENAME_SOURCE}(?:(?::|#)\d+(?:[:.]\d+)?)?`,
  "gu",
);
/**
 * CDXC:TerminalLinks 2026-07-31-13:45
 * Prefixed diagnostics often leave paths unquoted. Restrict space-aware matching to
 * recognized position suffixes so ordinary terminal prose does not become a path link.
 */
const POSITIONED_PATH_TOKEN_PATTERN =
  /(?:(?:file:\/\/\/?|[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])[^<>"'`()[\]{}]*?|[^\\/\s<>"'`()[\]{}]+[\\/][^<>"'`()[\]{}]*?)(?:(?::|#)\d+(?:[:.]\d+)?|(?:,|:)?\s+line\s+\d+(?:,\s*(?:col(?:umn)?|character)\s+\d+)?|\s*\(\d+(?:[,:]\s*\d+)?\)|\s+\d+(?:[:.]\d+)?)(?=$|[\s,;!?)}\]])/giu;
const POSITION_SUFFIX_PATTERNS = [
  /(?::|#)(?<line>\d+)(?:[:.](?<column>\d+))?$/u,
  /(?:,|:)?\s+line\s+(?<line>\d+)(?:,\s*(?:col(?:umn)?|character)\s+(?<column>\d+))?$/iu,
  /\s*\((?<line>\d+)(?:[,:]\s*(?<column>\d+))?\)$/u,
  /\s+(?<line>\d+)(?:[:.](?<column>\d+))?$/u,
];

/**
 * CDXC:TerminalLinks 2026-07-31-13:45
 * Terminal output must support VS Code-style local navigation, including wrapped and
 * common diagnostic paths, without replacing xterm's maintained HTTP(S) link addon.
 * Wrapped web URLs stay with xterm; the extension validates local targets after Cmd/Ctrl-click.
 */
export class TerminalPathLinkProvider implements ILinkProvider {
  public constructor(private readonly options: TerminalPathLinkProviderOptions) {}

  public provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const logicalLine = getLogicalLine(this.options.terminal, bufferLineNumber - 1);
    if (!logicalLine || logicalLine.text.length > MAX_LOGICAL_LINE_LENGTH) {
      callback(undefined);
      return;
    }

    const links = parseTerminalPathLinks(logicalLine.text, this.options.isWindows)
      .map((link) => {
        const start = mapStringIndex(
          this.options.terminal,
          logicalLine.startLineIndex,
          0,
          link.start,
        );
        const end = mapStringIndex(
          this.options.terminal,
          start.lineIndex,
          start.columnIndex,
          link.end - link.start,
        );
        if (start.lineIndex < 0 || end.lineIndex < 0) {
          return undefined;
        }

        return {
          activate: (event: MouseEvent) => this.options.activate(event, link),
          range: {
            start: { x: start.columnIndex + 1, y: start.lineIndex + 1 },
            end: { x: end.columnIndex, y: end.lineIndex + 1 },
          },
          text: link.text,
        } satisfies ILink;
      })
      .filter((link): link is ILink => link !== undefined);

    callback(links.length > 0 ? links : undefined);
  }
}

export function parseTerminalPathLinks(text: string, isWindows: boolean): TerminalPathLink[] {
  const links: TerminalPathLink[] = [];

  const add = (raw: string, start: number) => {
    const link = parseTerminalPathLink(raw, start, isWindows);
    if (!link) {
      return;
    }

    links.push(link);
  };

  for (const match of text.matchAll(QUOTED_PATH_PATTERN)) {
    const path = `${match[2] ?? ""}${match[3] ?? ""}`;
    const suffix = match.groups?.suffix ?? "";
    const start = (match.index ?? 0) + 1;
    const link = parseTerminalPathLink(`${path}${suffix}`, start, isWindows);
    if (link) {
      links.push({
        ...link,
        end: (match.index ?? 0) + match[0].length,
        text: match[0].slice(1),
      });
    }
  }

  for (const match of text.matchAll(POSITIONED_PATH_TOKEN_PATTERN)) {
    add(match[0], match.index ?? 0);
  }

  for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
    add(match[0], match.index ?? 0);
  }

  for (const match of text.matchAll(SEARCH_TOKEN_PATTERN)) {
    if (isInsideUnsupportedUrl(text, match.index ?? 0)) {
      continue;
    }
    add(match[0], match.index ?? 0);
  }

  const trimmed = text.trim();
  if (trimmed.length > 0) {
    add(trimmed, text.indexOf(trimmed));
  }

  return links
    .sort(
      (left, right) =>
        left.start - right.start ||
        Number(right.line !== undefined) - Number(left.line !== undefined) ||
        right.end - left.end,
    )
    .reduce<TerminalPathLink[]>((accepted, link) => {
      if (
        accepted.length >= MAX_LINKS_PER_LINE ||
        accepted.some((existing) => link.start < existing.end && existing.start < link.end)
      ) {
        return accepted;
      }

      accepted.push(link);
      return accepted;
    }, []);
}

function parseTerminalPathLink(
  raw: string,
  start: number,
  isWindows: boolean,
): TerminalPathLink | undefined {
  const unwrapped = unwrapTerminalPathToken(raw.trimEnd().replace(/[.,;!?]+$/u, ""));
  let text = unwrapped.text;
  start += unwrapped.startOffset;
  const suffix = getPositionSuffix(text);
  const path = (suffix ? text.slice(0, suffix.index) : text).replace(/^['"]|['"]$/gu, "");
  if (!path || hasUnsupportedScheme(path)) {
    return undefined;
  }

  const kind = getTerminalPathLinkKind(path, isWindows);
  if (!kind) {
    return undefined;
  }

  text = text.slice(0, path.length + (suffix?.text.length ?? 0));
  return {
    column: suffix?.column,
    end: start + text.length,
    kind,
    line: suffix?.line,
    path,
    start,
    text,
  };
}

function getPositionSuffix(
  text: string,
): { column?: number; index: number; line: number; text: string } | undefined {
  for (const pattern of POSITION_SUFFIX_PATTERNS) {
    const match = text.match(pattern);
    const line = Number(match?.groups?.line);
    if (!match || !Number.isSafeInteger(line) || line < 1) {
      continue;
    }

    const columnValue = match.groups?.column;
    const column = columnValue === undefined ? undefined : Number(columnValue);
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
      continue;
    }

    return {
      column,
      index: match.index ?? text.length - match[0].length,
      line,
      text: match[0],
    };
  }

  return undefined;
}

function getTerminalPathLinkKind(
  path: string,
  isWindows: boolean,
): TerminalPathLinkKind | undefined {
  if (/^file:\/\//iu.test(path)) {
    return "path";
  }
  if (isWindows && (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\"))) {
    return "path";
  }
  if (/^(?:\/|~[\\/]|\.{1,2}[\\/])/u.test(path)) {
    return "path";
  }
  if (/^[^\\/\s<>"'`()[\]{}]+(?:[\\/][^\\/<>"'`()[\]{}]+)+$/u.test(path)) {
    return "path";
  }
  if (isTerminalWorkspaceSearchTarget(path)) {
    return "search";
  }
  return undefined;
}

function unwrapTerminalPathToken(raw: string): { startOffset: number; text: string } {
  let startOffset = 0;
  let text = raw;
  const closingDelimiterByOpeningDelimiter: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
  };

  while (text.length > 1 && closingDelimiterByOpeningDelimiter[text[0]] === text[text.length - 1]) {
    text = text.slice(1, -1);
    startOffset += 1;
  }

  return { startOffset, text };
}

function hasUnsupportedScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) && !/^file:\/\//iu.test(path);
}

function isInsideUnsupportedUrl(text: string, index: number): boolean {
  const tokenStart = Math.max(text.lastIndexOf(" ", index), text.lastIndexOf("\t", index)) + 1;
  return hasUnsupportedScheme(text.slice(tokenStart, index).replace(/^[<({["'`]+/u, ""));
}

function getLogicalLine(
  terminal: Terminal,
  lineIndex: number,
): { startLineIndex: number; text: string } | undefined {
  const buffer = terminal.buffer.active;
  const currentLine = buffer.getLine(lineIndex);
  if (!currentLine) {
    return undefined;
  }

  const lines = [currentLine.translateToString(true)];
  let startLineIndex = lineIndex;
  while (buffer.getLine(startLineIndex)?.isWrapped && startLineIndex > 0) {
    startLineIndex -= 1;
    const previousLine = buffer.getLine(startLineIndex);
    if (!previousLine) {
      break;
    }
    lines.unshift(previousLine.translateToString(true));
  }

  let endLineIndex = lineIndex;
  while (buffer.getLine(endLineIndex + 1)?.isWrapped) {
    endLineIndex += 1;
    const nextLine = buffer.getLine(endLineIndex);
    if (!nextLine) {
      break;
    }
    lines.push(nextLine.translateToString(true));
  }

  return { startLineIndex, text: lines.join("") };
}

function mapStringIndex(
  terminal: Terminal,
  lineIndex: number,
  columnIndex: number,
  stringIndex: number,
): { columnIndex: number; lineIndex: number } {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let start = columnIndex;

  while (stringIndex > 0) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      return { columnIndex: -1, lineIndex: -1 };
    }

    for (let index = start; index < line.length; index += 1) {
      line.getCell(index, cell);
      if (cell.getWidth() === 0) {
        continue;
      }

      const chars = cell.getChars();
      stringIndex -= chars.length || 1;
      if (index === line.length - 1 && chars === "") {
        const nextLine = buffer.getLine(lineIndex + 1);
        if (nextLine?.isWrapped) {
          nextLine.getCell(0, cell);
          if (cell.getWidth() === 2) {
            stringIndex += 1;
          }
        }
      }
      if (stringIndex < 0) {
        return { columnIndex: index, lineIndex };
      }
    }

    lineIndex += 1;
    start = 0;
  }

  return { columnIndex: start, lineIndex };
}
