import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreHttpError, CoreTransportError } from "../core-client/uds-http";
import type { CleanupReport } from "./MainCleanup";
import { MainApplicationError, type MainApplicationPhase, type MainExit } from "./MainExit";

const MAX_CAUSES = 12;
const MAX_CAUSE_VISITS = 48;
const MAX_FRAMES = 4;
const MAX_CLEANUP_FAILURES = 8;
const BUILTIN_ERRORS = [
  ["AggregateError", AggregateError],
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["ReferenceError", ReferenceError],
  ["SyntaxError", SyntaxError],
  ["URIError", URIError],
  ["EvalError", EvalError],
] as const;

export interface MainFatalCause {
  readonly kind: "failure" | "defect" | "interruption";
  readonly parent: number | null;
  readonly name: string;
  readonly operation?: string;
  readonly reason?: string;
  readonly generation?: string;
  readonly retryable?: boolean;
  readonly transportKind?: string;
  readonly code?: string;
  readonly status?: number;
  readonly frames: readonly {
    readonly function: string;
    readonly line: number;
    readonly column: number;
  }[];
}

/** Content-free evidence: no raw error messages, request properties, stack paths or payloads. */
export interface MainFatalIncident {
  readonly version: 1;
  readonly id: string;
  readonly occurredAt: string;
  readonly appVersion: string;
  readonly phase: MainApplicationPhase;
  readonly summary: string;
  readonly causes: readonly MainFatalCause[];
  readonly truncated: boolean;
  readonly cleanup: {
    readonly failureCount: number;
    readonly failures: readonly { readonly operation: string; readonly subsystem: string }[];
  };
}

export interface MainFailurePresentation {
  readonly incidentId: string;
  readonly detail: string;
}

const identifier = (value: string, fallback: string): string =>
  /^[a-zA-Z0-9_$][a-zA-Z0-9_.$:/-]{0,79}$/u.test(value) ? value : fallback;

const framesOf = (error: unknown): MainFatalCause["frames"] => {
  if (!(error instanceof Error)) return [];
  // V8's first line is the raw message. Retain only bounded code symbols/coordinates,
  // never the source path (which may name a user's home, workspace or document).
  return (error.stack ?? "")
    .slice(0, 8 * 1024)
    .split("\n", MAX_FRAMES + 2)
    .slice(1)
    .flatMap((line) => {
      const match = /^\s+at (?:async )?([a-zA-Z_$][\w.$]*) \(.+:(\d+):(\d+)\)$/u.exec(line);
      if (!match) return [];
      const lineNumber = Number(match[2]);
      const column = Number(match[3]);
      if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) return [];
      return [{ function: identifier(match[1]!, "anonymous"), line: lineNumber, column }];
    })
    .slice(0, MAX_FRAMES);
};

const causeMetadata = (value: unknown): Omit<MainFatalCause, "kind" | "parent"> => {
  const base = { frames: framesOf(value) };
  if (Schema.is(MainApplicationError)(value)) {
    return {
      ...base,
      name: "MainApplicationError",
      operation: identifier(value.operation, "application"),
    };
  }
  if (Schema.is(CoreRuntimeError)(value)) {
    return {
      ...base,
      name: "CoreRuntimeError",
      operation: identifier(value.operation, "core"),
      reason: value.reason,
      retryable: value.retryable,
      ...(value.generation ? { generation: identifier(value.generation, "unknown") } : {}),
    };
  }
  if (value instanceof CoreTransportError) {
    return {
      ...base,
      name: "CoreTransportError",
      transportKind: value.kind,
      ...(value.code ? { code: identifier(value.code, "unknown") } : {}),
    };
  }
  if (value instanceof CoreHttpError)
    return { ...base, name: "CoreHttpError", status: value.status };
  // Dependency-owned names are arbitrary strings, even when they resemble identifiers.
  const name =
    value instanceof Error
      ? (BUILTIN_ERRORS.find(([, constructor]) => value instanceof constructor)?.[0] ?? "Error")
      : typeof value;
  return { ...base, name };
};

const summaryFor = (phase: MainApplicationPhase, causes: readonly MainFatalCause[]): string => {
  if (phase === "closing") return "Nodex could not finish shutting down.";
  if (phase !== "runtime") return "Nodex could not initialize the application.";
  if (causes.some((cause) => cause.reason === "protocol")) {
    return "Nodex received incompatible data from its local data service.";
  }
  if (causes.some((cause) => cause.operation === "core")) {
    return "Nodex could not continue using its local data service.";
  }
  return "Nodex could not continue the application runtime.";
};

export const makeMainFatalIncident = (
  exit: Extract<MainExit, { readonly _tag: "Failure" }>,
  cleanup: CleanupReport,
  context: { readonly id: string; readonly occurredAt: string; readonly appVersion: string },
): MainFatalIncident => {
  const causes: MainFatalCause[] = [];
  const seen = new WeakSet<object>();
  let truncated = false;
  let visits = 0;
  const visit = (value: unknown, kind: MainFatalCause["kind"], parent: number | null): void => {
    // Cause containers do not emit an entry, so bound traversal independently of output.
    if (causes.length >= MAX_CAUSES || visits >= MAX_CAUSE_VISITS) {
      truncated = true;
      return;
    }
    visits += 1;
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Cause.isCause(value)) {
      for (const reason of value.reasons.slice(0, MAX_CAUSES)) {
        if (causes.length >= MAX_CAUSES) {
          truncated = true;
          break;
        }
        if (Cause.isFailReason(reason)) visit(reason.error, "failure", parent);
        else if (Cause.isDieReason(reason)) visit(reason.defect, "defect", parent);
        else causes.push({ kind: "interruption", parent, name: "Interrupt", frames: [] });
      }
      if (value.reasons.length > MAX_CAUSES) truncated = true;
      return;
    }
    const index = causes.length;
    try {
      causes.push({ kind, parent, ...causeMetadata(value) });
    } catch {
      causes.push({ kind, parent, name: "UninspectableError", frames: [] });
    }
    // Read only data properties; an error supplied by a dependency may have throwing getters.
    const nested = value instanceof Error ? Object.getOwnPropertyDescriptor(value, "cause") : null;
    if (nested && "value" in nested && nested.value !== null && nested.value !== undefined) {
      visit(nested.value, kind, index);
    }
  };
  visit(exit.cause, "failure", null);
  return {
    version: 1,
    ...context,
    appVersion: identifier(context.appVersion, "unknown"),
    phase: exit.phase,
    summary: summaryFor(exit.phase, causes),
    causes,
    truncated,
    cleanup: {
      failureCount: cleanup.failures.length,
      failures: cleanup.failures.slice(0, MAX_CLEANUP_FAILURES).map((failure) => ({
        operation: identifier(failure.operation, "cleanup"),
        subsystem: identifier(failure.subsystem, "application"),
      })),
    },
  };
};

export const fatalIncidentPresentation = (
  incident: MainFatalIncident,
  storedPath: string | null,
): MainFailurePresentation => ({
  incidentId: incident.id,
  detail: `${incident.summary}\n\nIncident: ${incident.id}\n${storedPath ? `Diagnostics: ${storedPath}` : "The diagnostic record could not be saved."}`,
});
