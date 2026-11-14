import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { ChevronRightMdIcon } from "@/components/shared/icons/customize-action-icons";
import { PageEmptyState } from "@/components/ui/section-header";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { PluginAppLogo } from "./plugin-logo";
import { buildPluginDetailPath, PLUGINS_ROOT_PATH } from "../plugins-routes";
import { useReadPluginAppFollowUp } from "@/features/local-conversation/view/plugin-app-conversation";
import { useReadRouteComposerAppModelContext } from "@/features/local-conversation/view/composer/composer-app-model-context";
import type { McpAppFollowUpMessage } from "@/lib/mcp-app/mcp-app-follow-up";
import { McpAppRpcError } from "@/lib/mcp-app/mcp-app-host-dispatcher";
import { useMemo } from "react";
import { pluginAppBindingKey } from "../../../../shared/agent-plugins/app-entrypoints";
import { useEffect, useRef, useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { McpAppRuntime } from "@/lib/mcp-app/mcp-app-runtime";
import { pluginAppAdapter } from "@/lib/plugin-app-adapter";
import { rendererSpaceId } from "@/lib/renderer-space";
import type { PluginAppBinding } from "../../../../shared/agent-plugins/app-entrypoints";

type AppProps = {
  readonly binding: PluginAppBinding;
  readonly onOpenPlugins?: (path: string) => void;
  readonly unavailable?: boolean;
  readonly conversation?: {
    readonly send: (message: McpAppFollowUpMessage, id: string) => Promise<void>;
    readonly update?: (id: string, value: unknown) => { readonly updateId?: string };
  };
};

export function PluginAppBreadcrumb({ binding }: Pick<AppProps, "binding">) {
  const { presentation } = binding;
  const name = presentation?.pluginName ?? "Plugin";
  const title = presentation?.entryTitle;
  return (
    <AppShellHeaderContentRegistrar
      content={
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <PluginAppLogo presentation={presentation} className="icon-xs shrink-0" />
          <span className="truncate">{name}</span>
          {title && title !== name && (
            <>
              <ChevronRightMdIcon className="icon-xs shrink-0 text-secondary" />
              <span className="truncate">{title}</span>
            </>
          )}
        </div>
      }
    />
  );
}

export function ThreadPluginAppView({
  binding,
  onOpenPlugins,
  hostId,
  threadId,
}: {
  readonly binding: Extract<PluginAppBinding, { kind: "thread" }>;
  readonly onOpenPlugins?: AppProps["onOpenPlugins"];
  readonly hostId: string;
  readonly threadId: string | null;
}) {
  const readFollowUp = useReadPluginAppFollowUp();
  const readContext = useReadRouteComposerAppModelContext();
  const sessionId = binding.sessionId;
  const sourceName = binding.presentation?.pluginName ?? "Plugin";
  const conversation = useMemo<AppProps["conversation"]>(
    () => ({
      send: async (message, id) => {
        const recipient = readFollowUp(sessionId);
        if (!recipient) throw new McpAppRpcError("The chat is unavailable.", -32000);
        return recipient.send(message, id);
      },
      update: threadId
        ? (id, value) => {
            const recipient = readContext({ hostId, threadId });
            if (!readFollowUp(sessionId) || !recipient)
              throw new McpAppRpcError("The chat composer is unavailable.", -32000);
            return recipient.publish({ id, sourceName, server: sourceName }, value);
          }
        : undefined,
    }),
    [hostId, readFollowUp, readContext, sessionId, sourceName, threadId],
  );
  return (
    <PluginAppView binding={binding} conversation={conversation} onOpenPlugins={onOpenPlugins} />
  );
}

export function PluginAppView(props: AppProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <PluginAppAttempt
      key={JSON.stringify([pluginAppBindingKey(props.binding), attempt])}
      {...props}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function PluginAppAttempt({
  binding,
  onOpenPlugins,
  conversation,
  unavailable,
  onRetry,
}: AppProps & { readonly onRetry: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "failed">("loading");

  useEffect(() => {
    const container = host.current;
    if (!container || unavailable) return;
    let retired = false;
    let release = () => {};
    const close = (viewId: string) => void pluginAppAdapter.close(viewId).catch(() => undefined);
    void pluginAppAdapter
      .open(binding)
      .then((result) => {
        if (!result.ok) {
          if (!retired)
            setStatus(result.error.code === "app_unavailable" ? "unavailable" : "failed");
          return;
        }
        const launch = result.value;
        if (retired) {
          close(launch.viewId);
          return;
        }
        const runtime = new McpAppRuntime({
          capabilityId: launch.viewId,
          resource: launch.resource,
          toolInput: launch.toolInput,
          toolResult: launch.toolResult,
          sendFollowUpMessage: conversation
            ? async (message) => {
                await pluginAppAdapter.request(launch.viewId, "ui/message", undefined);
                if (retired) throw new McpAppRpcError("The app is unavailable.", -32000);
                return conversation.send(message, launch.viewId);
              }
            : undefined,
          modelContext: conversation?.update
            ? {
                identity: launch.viewId,
                isCurrent: () => !retired,
                update: async (value) => {
                  await pluginAppAdapter.request(
                    launch.viewId,
                    "ui/update-model-context",
                    undefined,
                  );
                  if (retired) throw new McpAppRpcError("The app is unavailable.", -32000);
                  return conversation.update!(launch.viewId, value);
                },
              }
            : undefined,
          pluginApp: {
            fullscreen: binding.kind === "global",
            originKey: JSON.stringify([
              "plugin",
              rendererSpaceId(),
              binding.projectId,
              binding.pluginId,
              pluginAppBindingKey(binding),
            ]),
            fileResource: binding.kind === "file",
            request: (method, params) => pluginAppAdapter.request(launch.viewId, method, params),
          },
        });
        container.append(runtime.element);
        const unsubscribeRuntime = runtime.subscribe(() => {
          const status = runtime.getSnapshot();
          if (status.status === "ready") setStatus("ready");
          if (status.status === "error") {
            release();
            setStatus("failed");
          }
        });
        const unsubscribeView = pluginAppAdapter.subscribe((event) => {
          if (event.kind === "catalog-changed" || event.viewId !== launch.viewId) return;
          if (event.kind === "resource-updated") runtime.notifyPluginResourceUpdated(event.uri);
          else {
            release();
            setStatus("unavailable");
          }
        });
        release = () => {
          retired = true;
          unsubscribeRuntime();
          unsubscribeView();
          close(launch.viewId);
          release = () => {};
          void runtime.dispose();
        };
      })
      .catch(() => {
        if (!retired) setStatus("failed");
      });
    return () => {
      retired = true;
      release();
    };
  }, [binding, conversation, unavailable]);

  return (
    <div className="relative h-full min-h-0 min-w-0 flex-1">
      <div ref={host} className="h-full min-h-0" />
      {status !== "ready" || unavailable ? (
        <div className="absolute inset-0 grid place-items-center bg-surface">
          {status === "loading" && !unavailable ? (
            <ActivitySpinnerIcon className="icon-sm" aria-label="Opening plugin app" />
          ) : (
            <PageEmptyState
              illustration={
                <PluginAppLogo presentation={binding.presentation} className="size-8" />
              }
              description={
                unavailable || status === "unavailable"
                  ? "This app is no longer available here."
                  : "The plugin app could not start."
              }
              actions={
                <>
                  <NodexButton size="sm" variant="ghostSecondary" onClick={onRetry}>
                    Retry
                  </NodexButton>
                  {onOpenPlugins && (
                    <NodexButton
                      size="sm"
                      variant="ghostSecondary"
                      onClick={() => {
                        const target = binding.presentation?.target;
                        onOpenPlugins(target ? buildPluginDetailPath(target) : PLUGINS_ROOT_PATH);
                      }}
                    >
                      Open in Plugins
                    </NodexButton>
                  )}
                </>
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
