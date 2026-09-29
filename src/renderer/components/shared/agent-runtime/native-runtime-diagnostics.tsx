import { useCallback, useEffect, useState } from "react";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import type { ClaudeRuntimeDiagnostics } from "../../../../shared/claude-models";

export function useOpenNativeRuntimeDiagnostics(
  read: (() => Promise<ClaudeRuntimeDiagnostics>) | undefined,
) {
  const appHandle = useScopeHandle(appScope);
  return useCallback(() => {
    if (!read) return;
    openModal(appHandle, NativeRuntimeDiagnosticsDialog, { read });
  }, [appHandle, read]);
}

function NativeRuntimeDiagnosticsDialog({
  read,
  onClose,
}: ModalCloseProps & { readonly read: () => Promise<ClaudeRuntimeDiagnostics> }) {
  const [diagnostics, setDiagnostics] = useState<ClaudeRuntimeDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setDiagnostics(null);
    setError(null);
    void read().then(
      (value) => {
        if (current) setDiagnostics(value);
      },
      (cause: unknown) => {
        if (current)
          setError(cause instanceof Error ? cause.message : "Could not inspect Claude runtime");
      },
    );
    return () => {
      current = false;
    };
  }, [read]);
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent aria-describedby={undefined}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Claude status</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody>
            {error ? <p role="alert">{error}</p> : null}
            {!diagnostics && !error ? <p role="status">Loading…</p> : null}
            {diagnostics ? <DiagnosticsDetails diagnostics={diagnostics} /> : null}
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function DiagnosticsDetails({ diagnostics }: { diagnostics: ClaudeRuntimeDiagnostics }) {
  const { health, mcpServers, agents, capabilities } = diagnostics;
  const values = [
    ["Runtime", health.status],
    ["Version", health.version],
    ["Executable", health.executable],
    ["Account", health.account?.email],
    ["Provider", health.account?.apiProvider],
    ["Authentication", health.account?.tokenSource],
    ["Subscription", health.account?.subscriptionType],
  ];
  return (
    <div className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto text-sm select-text">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {values
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-token-text-tertiary">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
      </dl>
      {health.error ? <p role="alert">{health.error}</p> : null}
      <section aria-label="MCP servers">
        <h3 className="mb-1 text-token-text-tertiary">MCP servers</h3>
        {mcpServers.length ? (
          <ul className="flex flex-col gap-1">
            {mcpServers.map((server, index) => (
              <li key={`${server.name}:${index}`}>
                <div className="flex justify-between gap-4">
                  <span className="min-w-0 break-words">{server.name}</span>
                  <span>{server.status}</span>
                </div>
                {server.error ? (
                  <p className="break-words text-token-text-tertiary">{server.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>None</p>
        )}
      </section>
      {agents.length ? (
        <section aria-label="Agents">
          <h3 className="mb-1 text-token-text-tertiary">Agents</h3>
          <ul className="flex flex-col gap-1">
            {agents.map((agent, index) => (
              <li key={`${agent.name}:${index}`}>
                {agent.name}
                {agent.description ? (
                  <span className="text-token-text-tertiary"> · {agent.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {capabilities.length ? (
        <section aria-label="Capabilities">
          <h3 className="mb-1 text-token-text-tertiary">Capabilities</h3>
          <p className="break-words">{capabilities.join(", ")}</p>
        </section>
      ) : null}
    </div>
  );
}
