import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Maximize2, Minimize2 } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "../../../../../components/ui/tooltip";
import type { McpAppSurfaceMode } from "../../../../../lib/mcp-app/mcp-app-runtime-manager";
import { useMcpAppRuntimeManager } from "../../../../../lib/mcp-app/mcp-app-runtime-context";
import { useMcpAppFollowUpHandler } from "../../../../../lib/mcp-app/mcp-app-follow-up-context";
import type { McpAppRuntimeConfig } from "../../../../../lib/mcp-app/mcp-app-runtime";
import { cn } from "../../../../../lib/utils";
import {
  resolveMcpAppFrameHeight,
  type McpRenderableResource,
} from "./mcp-tool-call-resource-utils";

interface McpCapabilityViewFrameProps {
  capabilityId: string;
  mode?: "inline" | "side-panel";
  resource?: McpRenderableResource;
  runtimeConfig?: Omit<McpAppRuntimeConfig, "capabilityId" | "resource" | "sendFollowUpMessage">;
}

const UNAVAILABLE_SNAPSHOT = {
  diagnostic: null,
  error: null,
  requestedDisplayMode: null,
  status: "loading" as const,
};

export function McpCapabilityViewFrame({
  capabilityId,
  mode = "inline",
  resource,
  runtimeConfig,
}: McpCapabilityViewFrameProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null);
  const runtimeManager = useMcpAppRuntimeManager();
  const sendFollowUpMessage = useMcpAppFollowUpHandler();
  const isSidePanel = mode === "side-panel";

  useLayoutEffect(() => {
    if (!resource || !runtimeConfig) return;
    runtimeManager.upsert({
      ...runtimeConfig,
      capabilityId,
      resource,
      ...(sendFollowUpMessage ? { sendFollowUpMessage } : {}),
    });
  }, [capabilityId, resource, runtimeConfig, runtimeManager, sendFollowUpMessage]);

  const subscribeRuntime = useCallback(
    (listener: () => void) => runtimeManager.subscribeRuntime(capabilityId, listener),
    [capabilityId, runtimeManager],
  );
  const readRuntime = useCallback(
    () => runtimeManager.get(capabilityId),
    [capabilityId, runtimeManager],
  );
  const runtime = useSyncExternalStore(subscribeRuntime, readRuntime, readRuntime);
  const surfaceMode: McpAppSurfaceMode = isExpanded ? "fullscreen" : mode;
  useLayoutEffect(() => {
    if (!surfaceElement || !runtime) return;
    return runtimeManager.registerSurface({
      capabilityId,
      element: surfaceElement,
      mode: surfaceMode,
      visible: true,
    });
  }, [capabilityId, runtime, runtimeManager, surfaceElement, surfaceMode]);

  const subscribe = useCallback(
    (listener: () => void) => runtime?.subscribe(listener) ?? (() => undefined),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime?.getSnapshot() ?? UNAVAILABLE_SNAPSHOT, [runtime]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!snapshot.requestedDisplayMode) return;
    setIsExpanded(snapshot.requestedDisplayMode === "fullscreen");
  }, [snapshot.requestedDisplayMode]);

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-token-input-background",
        resource?.metadata.prefersBorder ? "rounded-lg border border-token-border" : "rounded-md",
        isSidePanel && "h-full rounded-none border-0",
        isExpanded && "fixed inset-3 z-50 rounded-xl border border-token-border shadow-2xl",
      )}
      data-mcp-app-frame-mode={surfaceMode}
      data-mcp-app-loading={snapshot.status === "loading" ? "true" : "false"}
      data-mcp-app-expanded={isExpanded ? "true" : "false"}
      style={{
        height:
          isSidePanel || isExpanded ? undefined : resolveMcpAppFrameHeight(resource?.metadata),
      }}
    >
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
        <NodexTooltip
          tooltipContent={isExpanded ? "Exit fullscreen" : "Open fullscreen"}
          side="top"
          delay={0}
        >
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-md bg-token-dropdown-background/80 text-token-description-foreground shadow-sm ring-1 ring-token-border backdrop-blur enabled:hover:text-token-foreground"
            aria-label={isExpanded ? "Exit fullscreen" : "Open fullscreen"}
            onClick={() => setIsExpanded((value) => !value)}
          >
            {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </NodexTooltip>
      </div>
      {snapshot.status === "loading" ? (
        <div className="absolute inset-0 grid place-items-center text-size-chat text-token-description-foreground">
          Loading app
        </div>
      ) : null}
      {snapshot.status === "error" ? (
        <div
          role="alert"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center text-size-chat text-token-description-foreground"
        >
          <span>{snapshot.error?.message ?? "The MCP app failed to load."}</span>
          <button
            type="button"
            className="rounded-md border border-token-border px-2.5 py-1 text-token-foreground hover:bg-token-bg-subtle"
            onClick={() => {
              runtimeManager.retry(capabilityId);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div
        ref={setSurfaceElement}
        className="h-full min-h-0 w-full"
        data-mcp-app-runtime-surface={capabilityId}
      />
    </div>
  );
}
