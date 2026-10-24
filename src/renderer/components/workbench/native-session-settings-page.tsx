import { useEffect, useState } from "react";
import type { ClaudeAgentInstanceConfig } from "../../../shared/claude-agent-settings";
import type {
  NativeSessionAttachInput,
  NativeSessionAttachResult,
  NativeSessionCatalogInput,
} from "../../../shared/native-session-catalog";
import type { ClaudeAgentSettings, ProjectWindow } from "../../../shared/types";
import {
  attachNativeSession,
  importCodexThread,
  listNativeSessions,
  pickCodexThreadImportDirectory,
  previewCodexThreadImport,
  readNativeSessionProjects,
} from "../../lib/native-session-catalog";
import { readClaudeAgentSettings } from "./workbench-settings-overlay-deps";
import { NodexButton } from "../ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "../ui/dropdown";
import { NodexSettingsPageSurface, NodexSettingsRow, NodexSettingsSection } from "../ui/settings";
import { AgentImportSettingsPage } from "./agent-import-settings-page";
import {
  CodexThreadImportSection,
  type CodexThreadImportRuntime,
} from "./codex-thread-import-section";
import {
  NativeSessionCatalogList,
  NativeSessionCatalogRow,
  NativeSessionDestinationPicker,
  nativeSessionErrorMessage,
  nativeSessionTitle,
  useNativeSessionCatalog,
  type NativeSessionDestinations,
} from "./native-session-catalog-browser";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

export interface NativeSessionSettingsRuntime extends CodexThreadImportRuntime {
  readonly profiles: () => Promise<ClaudeAgentSettings>;
  readonly projects: (after?: string | null) => Promise<ProjectWindow>;
  readonly attach: (input: NativeSessionAttachInput) => Promise<NativeSessionAttachResult>;
}

const defaultRuntime: NativeSessionSettingsRuntime = {
  profiles: readClaudeAgentSettings,
  projects: readNativeSessionProjects,
  list: listNativeSessions,
  attach: attachNativeSession,
  previewCodexImport: previewCodexThreadImport,
  importCodex: importCodexThread,
  pickDirectory: pickCodexThreadImportDirectory,
};

export function NativeSessionSettingsPage({
  open,
  activeProjectId = null,
  onOpenThread,
  runtime = defaultRuntime,
}: Pick<SettingsSectionPageProps, "open" | "onOpenThread"> & {
  readonly activeProjectId?: string | null;
  readonly runtime?: NativeSessionSettingsRuntime;
}) {
  const [profiles, setProfiles] = useState<ClaudeAgentSettings>({ instances: [] });
  const [projects, setProjects] = useState<ProjectWindow | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([runtime.profiles(), runtime.projects()]).then(
      ([nextProfiles, nextProjects]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        setProjects(nextProjects);
      },
      (cause: unknown) => {
        if (active) setError(nativeSessionErrorMessage(cause));
      },
    );
    return () => {
      active = false;
      setError(null);
    };
  }, [open, runtime]);

  const loadMoreProjects = async () => {
    if (!projects?.nextCursor || loadingProjects) return;
    setLoadingProjects(true);
    try {
      const next = await runtime.projects(projects.nextCursor);
      setProjects((current) => ({ ...next, items: [...(current?.items ?? []), ...next.items] }));
    } catch (cause) {
      setError(nativeSessionErrorMessage(cause));
    } finally {
      setLoadingProjects(false);
    }
  };

  const destinations: NativeSessionDestinations = {
    window: projects,
    loadingMore: loadingProjects,
    loadMore: () => void loadMoreProjects(),
    defaultProjectId:
      activeProjectId && projects?.items.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : null,
  };
  const claudeProfiles = profiles.instances.filter((instance) => instance.enabled);

  return (
    <NodexSettingsPageSurface title="Conversations">
      {error ? (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      ) : null}
      <CodexThreadImportSection
        open={open}
        runtime={runtime}
        destinations={destinations}
        onOpenThread={onOpenThread}
      />
      {claudeProfiles.length > 0 ? (
        <ClaudeConnectSection
          open={open}
          runtime={runtime}
          profiles={claudeProfiles}
          destinations={destinations}
        />
      ) : null}
      <details className="text-sm" onToggle={(event) => setShowCopy(event.currentTarget.open)}>
        <summary className="cursor-interaction py-2 text-token-text-secondary">
          Copy data to Codex
        </summary>
        {showCopy ? <AgentImportSettingsPage open={open} embedded /> : null}
      </details>
    </NodexSettingsPageSurface>
  );
}

function ClaudeConnectSection({
  open,
  runtime,
  profiles,
  destinations,
}: {
  open: boolean;
  runtime: NativeSessionSettingsRuntime;
  profiles: readonly ClaudeAgentInstanceConfig[];
  destinations: NativeSessionDestinations;
}) {
  const [profileChoice, setProfileChoice] = useState<string | null>(null);
  const profile = profiles.find((instance) => instance.id === profileChoice) ?? profiles[0]!;
  const [projectChoice, setProjectChoice] = useState<string | null | undefined>(undefined);
  const projectId = projectChoice === undefined ? destinations.defaultProjectId : projectChoice;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useNativeSessionCatalog(runtime.list, open);
  const input: NativeSessionCatalogInput = { backendKind: "claude", instanceConfigId: profile.id };
  const busy = catalog.loading || connecting !== null;

  const connect = async (nativeSessionId: string, expectedHome: string) => {
    if (busy) return;
    setConnecting(nativeSessionId);
    setError(null);
    try {
      const result = await runtime.attach({
        ...input,
        nativeSessionId,
        expectedHome,
        projectId,
      });
      catalog.update((page) =>
        page.nativeHome !== expectedHome
          ? page
          : {
              ...page,
              entries: page.entries.map((entry) =>
                entry.nativeSessionId === nativeSessionId
                  ? {
                      ...entry,
                      attachedThreadId: result.threadId,
                      attachedSessionId: result.sessionId,
                    }
                  : entry,
              ),
            },
      );
    } catch (cause) {
      setError(nativeSessionErrorMessage(cause));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <NodexSettingsSection title="Connect Claude Code">
      <NodexSettingsRow
        label="Profile"
        description="Connected conversations open as read-only history."
      >
        <NodexOptionPicker
          value={profile.id}
          options={profiles.map((instance) => ({
            value: instance.id,
            label: instance.displayName,
          }))}
          search="filter"
          disabled={busy}
          onValueChange={(value) => {
            setProfileChoice(value);
            setError(null);
            catalog.reset();
          }}
          triggerButton={
            <NodexSettingsDropdownTrigger aria-label="Claude Code profile">
              {profile.displayName}
            </NodexSettingsDropdownTrigger>
          }
        />
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void catalog.browse(input)}
        >
          {catalog.loading ? "Loading…" : "Browse"}
        </NodexButton>
      </NodexSettingsRow>
      <NodexSettingsRow label="Destination">
        <NativeSessionDestinationPicker
          destinations={destinations}
          value={projectId}
          onValueChange={setProjectChoice}
          disabled={busy}
          ariaLabel="Connection destination"
        />
      </NodexSettingsRow>
      <NativeSessionCatalogList
        catalog={catalog}
        input={input}
        disabled={busy}
        emptyMessage="No Claude Code conversations found."
        renderEntry={(entry, page) => {
          const title = nativeSessionTitle(entry.title);
          const connected = Boolean(entry.attachedThreadId);
          return (
            <NativeSessionCatalogRow
              key={entry.nativeSessionId}
              entry={entry}
              action={
                <NodexButton
                  aria-label={`${connected ? "Connected" : "Connect"} ${title}`}
                  size="sm"
                  variant="secondary"
                  disabled={busy || connected}
                  onClick={() => void connect(entry.nativeSessionId, page.nativeHome)}
                >
                  {connecting === entry.nativeSessionId
                    ? "Connecting…"
                    : connected
                      ? "Connected"
                      : "Connect"}
                </NodexButton>
              }
            />
          );
        }}
      />
      {error ? (
        <div role="alert" className="px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
    </NodexSettingsSection>
  );
}
