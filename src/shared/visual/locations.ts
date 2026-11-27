import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { SourceMap } from "oxc-transform";
import type { VisualSpan } from "./contract";
import type { VisualEdit } from "./literals";

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/gu))
    offsets.push(match.index + match[0].length);
  return offsets;
}

function undoEdits(edits: readonly VisualEdit[], offset: number): number {
  let delta = 0;
  for (const edit of edits) {
    const generated = edit.start + delta;
    if (offset < generated) break;
    if (offset < generated + edit.text.length) return edit.start;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return offset - delta;
}

export function visualLocations(
  transformed: string,
  edits: readonly VisualEdit[],
  map?: SourceMap,
) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const lines = lineOffsets(transformed);
  const trace = map && new TraceMap({ ...map, version: 3 });
  return {
    instrumented: (span: VisualSpan): VisualSpan => ({
      start: undoEdits(sorted, span.start),
      end: undoEdits(sorted, span.end),
    }),
    runtime: (line: number, column: number): VisualSpan | undefined => {
      if (!trace || line < 1 || column < 1) return undefined;
      const original = originalPositionFor(trace, { line, column: column - 1 });
      if (original.line === null) return undefined;
      const start = undoEdits(sorted, lines[original.line - 1] + original.column);
      return { start, end: start + 1 };
    },
  };
}
