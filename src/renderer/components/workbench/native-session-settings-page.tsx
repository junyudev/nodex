import { useEffect, useRef, useState } from "react";
import type {
  NativeSessionAttachInput,
  NativeSessionAttachResult,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ClaudeAgentSettings, ProjectWindow } from "../../../shared/types";
import {
  attachNativeSession,
  listNativeSessions,
  readNativeSessionProjects,
} from "../../lib/native-session-catalog";
import { readClaudeAgentSettings } from "./workbench-settings-overlay-deps";
import { NodexButton } from "../ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "../ui/dropdown";
import { NodexSettingsPageSurface, NodexSettingsRow, NodexSettingsSection } from "../ui/settings";
import { AgentImportSettingsPage } from "./agent-import-settings-page";

export interface NativeSessionSettingsRuntime {
  readonly profiles: () => Promise<ClaudeAgentSettings>;
  readonly projects: (after?: string | null) => Promise<ProjectWindow>;
  readonly list: (input: NativeSessionCatalogInput) => Promise<NativeSessionCatalogPage>;
  readonly attach: (input: NativeSessionAttachInput) => Promise<NativeSessionAttachResult>;
}

const defaultRuntime: NativeSessionSettingsRuntime = {
  profiles: readClaudeAgentSettings,
  projects: readNativeSessionProjects,
  list: listNativeSessions,
  attach: attachNativeSession,
};
const sourceInput = (source: string): NativeSessionCatalogInput =>
  source === "codex"
    ? { backendKind: "codex" }
    : { backendKind: "claude", instanceConfigId: source.slice("claude:".length) };
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function NativeSessionSettingsPage({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: NativeSessionSettingsRuntime;
}) {
  const [profiles, setProfiles] = useState<ClaudeAgentSettings>({ instances: [] });
  const [projects, setProjects] = useState<ProjectWindow | null>(null);
  const [source, setSource] = useState("codex");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [page, setPage] = useState<NativeSessionCatalogPage | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(false);
    setConnecting(null);
    setError(null);
    void Promise.all([runtime.profiles(), runtime.projects()]).then(
      ([nextProfiles, nextProjects]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        setProjects(nextProjects);
      },
      (cause: unknown) => {
        if (active) setError(message(cause));
      },
    );
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [open, runtime]);

  const sources = [
    { value: "codex", label: "Codex" },
    ...profiles.instances
      .filter((instance) => instance.enabled)
      .map((instance) => ({
        value: `claude:${instance.id}`,
        label: `Claude Code · ${instance.displayName}`,
      })),
  ];
  const busy = loading || connecting !== null;

  const browse = async (cursor?: string, history: (string | undefined)[] = [undefined]) => {
    if (busy) return;
    const ownGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await runtime.list({ ...sourceInput(source), ...(cursor ? { cursor } : {}) });
      if (generation.current !== ownGeneration) return;
      setPage(next);
      setCursors(history);
    } catch (cause) {
      if (generation.current === ownGeneration) setError(message(cause));
    } finally {
      if (generation.current === ownGeneration) setLoading(false);
    }
  };

  const connect = async (nativeSessionId: string) => {
    if (!page || busy) return;
    const ownGeneration = generation.current;
    setConnecting(nativeSessionId);
    setError(null);
    try {
      const result = await runtime.attach({
        ...sourceInput(source),
        nativeSessionId,
        expectedHome: page.nativeHome,
        projectId,
      });
      if (generation.current !== ownGeneration) return;
      setPage((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.nativeSessionId === nativeSessionId
                  ? {
                      ...entry,
                      attachedThreadId: result.threadId,
                      attachedSessionId: result.sessionId,
                    }
                  : entry,
              ),
            }
          : current,
      );
    } catch (cause) {
      if (generation.current === ownGeneration) setError(message(cause));
    } finally {
      if (generation.current === ownGeneration) setConnecting(null);
    }
  };

  const loadProjects = async () => {
    if (!projects?.nextCursor || loadingProjects) return;
    setLoadingProjects(true);
    try {
      const next = await runtime.projects(projects.nextCursor);
      setProjects((current) => ({ ...next, items: [...(current?.items ?? []), ...next.items] }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoadingProjects(false);
    }
  };

  return (
    <NodexSettingsPageSurface title="Connect conversations">
      <NodexSettingsSection>
        <NodexSettingsRow label="Agent">
          <NodexOptionPicker
            value={source}
            options={sources}
            search="filter"
            disabled={busy}
            onValueChange={(value) => {
              generation.current += 1;
              setSource(value);
              setPage(null);
              setCursors([undefined]);
              setError(null);
            }}
            triggerButton={
              <NodexSettingsDropdownTrigger aria-label="Conversation agent">
                {sources.find((entry) => entry.value === source)?.label}
              </NodexSettingsDropdownTrigger>
            }
          />
          <NodexButton size="sm" variant="secondary" disabled={busy} onClick={() => void browse()}>
            {loading ? "Loading…" : "Browse"}
          </NodexButton>
        </NodexSettingsRow>
        <NodexSettingsRow label="Destination">
          <NodexOptionPicker
            value={projectId ?? "projectless"}
            options={[
              { value: "projectless", label: "Projectless" },
              ...(projects?.items ?? []).map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
            search="filter"
            disabled={busy || !projects}
            onValueChange={(value) => setProjectId(value === "projectless" ? null : value)}
            triggerButton={
              <NodexSettingsDropdownTrigger aria-label="Conversation destination">
                {projects?.items.find((project) => project.id === projectId)?.name ?? "Projectless"}
              </NodexSettingsDropdownTrigger>
            }
          />
          {projects?.nextCursor ? (
            <NodexButton
              size="sm"
              variant="ghost"
              disabled={loadingProjects}
              onClick={() => void loadProjects()}
            >
              More projects
            </NodexButton>
          ) : null}
        </NodexSettingsRow>
      </NodexSettingsSection>

      {page ? (
        <NodexSettingsSection>
          <div className="truncate px-3 py-2 text-xs text-token-text-secondary">
            {page.nativeHome}
          </div>
          {page.entries.map((entry) => (
            <NodexSettingsRow
              key={entry.nativeSessionId}
              label={entry.title || "Untitled conversation"}
              description={entry.cwd}
            >
              <NodexButton
                aria-label={`${entry.attachedThreadId ? "Connected" : "Connect"} ${entry.title || "Untitled conversation"}`}
                size="sm"
                variant="secondary"
                disabled={busy || Boolean(entry.attachedThreadId)}
                onClick={() => void connect(entry.nativeSessionId)}
              >
                {connecting === entry.nativeSessionId
                  ? "Connecting…"
                  : entry.attachedThreadId
                    ? "Connected"
                    : "Connect"}
              </NodexButton>
            </NodexSettingsRow>
          ))}
          {page.entries.length === 0 ? (
            <div className="p-3 text-sm text-token-text-secondary">No conversations found.</div>
          ) : null}
          {cursors.length > 1 || page.nextCursor ? (
            <div className="flex justify-end gap-2 p-3">
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={busy || cursors.length === 1}
                onClick={() => {
                  const previous = cursors.slice(0, -1);
                  void browse(previous.at(-1), previous);
                }}
              >
                Previous
              </NodexButton>
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={busy || !page.nextCursor}
                onClick={() => {
                  if (!page.nextCursor) return;
                  void browse(page.nextCursor, [...cursors, page.nextCursor]);
                }}
              >
                Next
              </NodexButton>
            </div>
          ) : null}
        </NodexSettingsSection>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <details className="text-sm" onToggle={(event) => setShowCopy(event.currentTarget.open)}>
        <summary className="cursor-interaction py-2 text-token-text-secondary">
          Copy data to Codex…
        </summary>
        {showCopy ? <AgentImportSettingsPage open={open} embedded /> : null}
      </details>
    </NodexSettingsPageSurface>
  );
}
