import { continueTrace, startInactiveSpan, withActiveSpan } from "@sentry/react";

import type { CodexRequestTraceContext } from "../../../shared/codex-request-lifecycle";

export interface CodexRequestInteractionTrace {
  readonly trace: CodexRequestTraceContext;
  finish(error?: unknown): void;
}

export interface CodexWorkspaceDiscoveryInteraction {
  readonly hostId: string;
  readonly interactionTrace: CodexRequestInteractionTrace | null;
  pendingCount: number;
  readonly startedAtMs: number;
  timeout: ReturnType<typeof setTimeout> | null;
  error?: unknown;
}

const WORKSPACE_DISCOVERY_GROUP_WINDOW_MS = 1_000;
const WORKSPACE_DISCOVERY_TIMEOUT_MS = 30_000;
const activeWorkspaceDiscovery = new Map<string, CodexWorkspaceDiscoveryInteraction>();

function traceFromSpan(
  span: ReturnType<typeof startInactiveSpan>,
): CodexRequestTraceContext | null {
  if (!span.isRecording()) return null;
  const context = span.spanContext();
  const traceFlags = (context.traceFlags & 1).toString(16).padStart(2, "0");
  const tracestate = context.traceState?.serialize();
  return {
    traceparent: `00-${context.traceId}-${context.spanId}-${traceFlags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

function failureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.message === "Timeout") return "timeout";
  return "operation";
}

function markSpanFailure(span: ReturnType<typeof startInactiveSpan>, error: unknown): void {
  span.setAttribute("codex.outcome", "failure");
  span.setAttribute("error.category", failureReason(error));
  span.setAttribute("error.type", "operation_failed");
  if (error instanceof Error) {
    span.setAttribute("error.name", error.name);
    span.setAttribute("error.message", error.message);
  }
  span.setStatus({ code: 2 });
}

/** Creates the same root plus request-child shape used by renderer app-server interactions. */
export function startCodexRequestInteractionTrace(input: {
  readonly rootName: string;
  readonly childName: string;
  readonly attributes: Readonly<Record<string, string | boolean | number>>;
}): CodexRequestInteractionTrace | null {
  const root = startInactiveSpan({ name: input.rootName, attributes: input.attributes });
  if (!root.isRecording()) {
    root.end();
    return null;
  }
  const child = withActiveSpan(root, () =>
    startInactiveSpan({ name: input.childName, attributes: input.attributes }),
  );
  const trace = traceFromSpan(child);
  if (!trace) {
    child.end();
    root.end();
    return null;
  }
  let finished = false;
  return {
    trace,
    finish(error) {
      if (finished) return;
      finished = true;
      if (error !== undefined) {
        markSpanFailure(child, error);
        markSpanFailure(root, error);
      }
      child.end();
      root.end();
    },
  };
}

/** Mirrors the renderer trace shape used when answering an app-server initiated request. */
export function startCodexServerResponseInteractionTrace(
  method: string,
): CodexRequestInteractionTrace | null {
  if (method === "currentTime/read") return null;
  const isToolResponse = method === "item/tool/call" || method === "item/tool/requestOptionPicker";
  return startCodexRequestInteractionTrace({
    attributes: { "app_server.method": method },
    childName: isToolResponse ? "tool.response" : "approval.response",
    rootName: isToolResponse ? "desktop.tool_response" : "desktop.approval_response",
  });
}

function sentryTraceHeader(trace: CodexRequestTraceContext): string | undefined {
  const match = trace.traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match;
  if (!traceId || !spanId || !flags) return undefined;
  return `${traceId}-${spanId}-${(Number.parseInt(flags, 16) & 1) === 1 ? "1" : "0"}`;
}

/** Records a completed child span from an existing W3C request trace. */
export function recordCodexRequestTraceSpan(input: {
  readonly trace: CodexRequestTraceContext;
  readonly name: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly attributes: Readonly<Record<string, string | boolean | number>>;
  readonly failed?: boolean;
}): void {
  const header = sentryTraceHeader(input.trace);
  const start = () =>
    startInactiveSpan({
      name: input.name,
      startTime: new Date(input.startTimeMs),
      attributes: input.attributes,
    });
  const span = header ? continueTrace({ sentryTrace: header, baggage: undefined }, start) : start();
  if (input.failed) {
    span.setAttribute("codex.outcome", "failure");
    span.setStatus({ code: 2 });
  }
  span.end(new Date(input.endTimeMs));
}

export function beginCodexWorkspaceDiscovery(input: {
  readonly hostId: string;
  readonly method: string;
  readonly priority: string;
  readonly source: string;
  readonly now?: number;
}): CodexWorkspaceDiscoveryInteraction {
  const now = input.now ?? Date.now();
  let interaction = activeWorkspaceDiscovery.get(input.hostId);
  if (!interaction || now - interaction.startedAtMs > WORKSPACE_DISCOVERY_GROUP_WINDOW_MS) {
    const trace = startCodexRequestInteractionTrace({
      attributes: {
        "app_server.method": input.method,
        "app_server.priority": input.priority,
        "app_server.source": input.source,
      },
      childName: "app_server.discovery",
      rootName: "desktop.workspace_discovery",
    });
    interaction = {
      hostId: input.hostId,
      interactionTrace: trace,
      pendingCount: 0,
      startedAtMs: now,
      timeout: null,
    };
    if (trace) {
      const target = interaction;
      interaction.timeout = setTimeout(() => {
        if (target.error === undefined) {
          target.error = new Error("Workspace discovery trace timed out");
          target.interactionTrace?.finish(target.error);
        } else {
          target.interactionTrace?.finish(target.error);
        }
        if (activeWorkspaceDiscovery.get(input.hostId) === target)
          activeWorkspaceDiscovery.delete(input.hostId);
      }, WORKSPACE_DISCOVERY_TIMEOUT_MS);
    }
    activeWorkspaceDiscovery.set(input.hostId, interaction);
  }
  interaction.pendingCount += 1;
  return interaction;
}

export function finishCodexWorkspaceDiscovery(
  interaction: CodexWorkspaceDiscoveryInteraction | null,
  error?: unknown,
): void {
  if (!interaction) return;
  if (interaction.error === undefined && error !== undefined) interaction.error = error;
  interaction.pendingCount -= 1;
  if (interaction.pendingCount !== 0) return;
  if (interaction.timeout) clearTimeout(interaction.timeout);
  if (interaction.error === undefined) interaction.interactionTrace?.finish();
  else interaction.interactionTrace?.finish(interaction.error);
  if (activeWorkspaceDiscovery.get(interaction.hostId) === interaction)
    activeWorkspaceDiscovery.delete(interaction.hostId);
}
