import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { HookEventName } from "@nodex/codex-app-server-protocol/v2/HookEventName";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import { Plug, TriangleAlert, UserRound } from "@/components/shared/icons/generic-icons";
import {
  ActivitySpinnerIcon,
  ChevronDownIcon,
  FileIcon,
  HooksIcon,
  PermissionDefaultIcon,
  RefreshIcon,
  SettingsGitIcon,
} from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexSettingsPageSurface, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import type { Project } from "../../lib/types";
import { invoke } from "../../lib/api";
import {
  doesCodexHookNeedReview,
  groupCodexHooksListEntries,
  resolveSelectedCodexHooksEntry,
  sortCodexHooksForEvent,
  summarizeCodexHookEvents,
  type CodexHooksSourceEntry,
  type CodexHooksSourceSection,
} from "../../lib/codex-hooks-model";
import {
  parseCodexHooksSettingsHostId,
  parseCodexHooksSettingsSelection,
  replaceCodexHooksSettingsSelection,
  type CodexHooksSettingsSelection,
  type CodexHooksSettingsSource,
} from "../../lib/codex-hooks-route";
import {
  normalizeCodexHooksCwds,
  useCodexHooksList,
  useCodexHookStateMutation,
} from "../../lib/use-codex-hooks";
import { cn } from "../../lib/utils";

const HOOK_EVENT_LABELS: Record<HookEventName, string> = {
  preToolUse: "PreToolUse",
  permissionRequest: "PermissionRequest",
  postToolUse: "PostToolUse",
  preCompact: "PreCompact",
  postCompact: "PostCompact",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmit: "UserPromptSubmit",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  stop: "Stop",
};

const HOOK_EVENT_DESCRIPTIONS: Record<HookEventName, string> = {
  preToolUse: "Before a tool executes",
  permissionRequest: "When permission is requested",
  postToolUse: "After a tool executes",
  preCompact: "Before Nodex compacts the conversation",
  postCompact: "After Nodex compacts the conversation",
  sessionStart: "When a new session starts",
  sessionEnd: "When a session ends",
  userPromptSubmit: "When the user submits a prompt",
  subagentStart: "When a subagent starts",
  subagentStop: "When a subagent stops",
  stop: "Right before Nodex ends its turn",
};

const HOOK_SOURCE_LABELS: Record<CodexHooksSettingsSource, string> = {
  plugin: "Plugin",
  user: "User config",
  admin: "Admin config",
  project: "Project config",
  sessionFlags: "Session flags",
  unknown: "Unknown source",
};

const HOOK_SOURCE_ICONS: Record<CodexHooksSettingsSource, ComponentType<{ className?: string }>> = {
  plugin: Plug,
  user: UserRound,
  admin: PermissionDefaultIcon,
  project: SettingsGitIcon,
  sessionFlags: HooksIcon,
  unknown: HooksIcon,
};

function formatPluginName(pluginId: string | null | undefined): string {
  if (!pluginId) return "Unknown plugin";
  return pluginId.split("@")[0] || "Unknown plugin";
}

function formatProjectRoot(root: string, labels: Readonly<Record<string, string>>): string {
  const label = labels[root];
  if (label) return label;
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

function formatSelectionTitle(
  selection: CodexHooksSettingsSelection,
  entry: CodexHooksSourceEntry | null,
  projectRootLabels: Readonly<Record<string, string>>,
): string {
  if (selection.source === "project") {
    return formatProjectRoot(selection.projectRoot, projectRootLabels);
  }
  if (selection.source === "plugin") {
    if (selection.pluginId !== undefined) return formatPluginName(selection.pluginId);
    const commonPluginIds = new Set(entry?.hooks.map((hook) => hook.pluginId) ?? []);
    if (commonPluginIds.size === 1) return formatPluginName(commonPluginIds.values().next().value);
  }
  return HOOK_SOURCE_LABELS[selection.source];
}

function sourceSummary(entry: HooksListEntry): { issueCount: number; needsReview: number } {
  return {
    issueCount: entry.warnings.length + entry.errors.length,
    needsReview: entry.hooks.filter(doesCodexHookNeedReview).length,
  };
}

function formatSourceAttentionSummary(summary: ReturnType<typeof sourceSummary>): string {
  const labels = [
    summary.issueCount > 0
      ? `${summary.issueCount} ${summary.issueCount === 1 ? "issue" : "issues"}`
      : null,
    summary.needsReview > 0
      ? `${summary.needsReview} ${summary.needsReview === 1 ? "needs" : "need"} review`
      : null,
  ];
  return labels.filter((label): label is string => label != null).join(" · ");
}

function HookSourceRow({
  entry,
  label,
  source,
  onSelect,
}: {
  entry: CodexHooksSourceEntry;
  label: string;
  source: CodexHooksSettingsSource;
  onSelect: (selection: CodexHooksSettingsSelection) => void;
}) {
  const Icon = HOOK_SOURCE_ICONS[source];
  const summary = sourceSummary(entry);

  return (
    <div className="group flex w-full items-center hover:bg-token-list-hover-background focus-within:bg-token-list-hover-background">
      <button
        type="button"
        className="focus-visible:outline-token-focus flex min-w-0 flex-1 cursor-interaction items-center gap-6 px-4 py-3 text-left disabled:cursor-default disabled:opacity-60"
        onClick={() => onSelect(entry.selection)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0">
            <Icon className="icon-sm text-token-text-secondary" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="min-w-0 text-sm font-medium text-token-text-primary">
              <span className="block truncate">{label}</span>
            </div>
            <div className="min-w-0 text-xs leading-4 text-balance text-token-text-secondary">
              {entry.hooks.length} {entry.hooks.length === 1 ? "hook" : "hooks"}
            </div>
          </div>
        </div>
        {summary.issueCount > 0 || summary.needsReview > 0 ? (
          <div className="flex shrink-0 items-center gap-2 text-sm text-token-text-primary">
            {formatSourceAttentionSummary(summary)}
          </div>
        ) : null}
      </button>
    </div>
  );
}

function HookSourceGroup({ title, children }: { title: string; children: ReactNode }) {
  return <NodexSettingsSection title={title}>{children}</NodexSettingsSection>;
}

function HooksOverview({
  sections,
  projectRootLabels,
  onSelect,
}: {
  sections: readonly CodexHooksSourceSection[];
  projectRootLabels: Readonly<Record<string, string>>;
  onSelect: (selection: CodexHooksSettingsSelection) => void;
}) {
  const configSections = sections.filter(
    (section) => section.source === "user" || section.source === "admin",
  );
  const pluginSection = sections.find((section) => section.source === "plugin");
  const projectSection = sections.find((section) => section.source === "project");
  const otherSections = sections.filter(
    (section) => section.source === "sessionFlags" || section.source === "unknown",
  );

  return (
    <>
      {configSections.length > 0 ? (
        <HookSourceGroup title="From Config">
          {configSections.map((section) =>
            section.entry ? (
              <HookSourceRow
                key={section.source}
                entry={section.entry}
                label={HOOK_SOURCE_LABELS[section.source]}
                source={section.source}
                onSelect={onSelect}
              />
            ) : null,
          )}
        </HookSourceGroup>
      ) : null}

      {pluginSection?.pluginEntries?.length ? (
        <HookSourceGroup title="From Plugins">
          {pluginSection.pluginEntries.map((entry) => {
            const pluginId = entry.selection.source === "plugin" ? entry.selection.pluginId : null;
            return (
              <HookSourceRow
                key={pluginId ?? "unknown-plugin"}
                entry={entry}
                label={formatPluginName(pluginId)}
                source="plugin"
                onSelect={onSelect}
              />
            );
          })}
        </HookSourceGroup>
      ) : null}

      {projectSection?.projectEntries?.length ? (
        <HookSourceGroup title="From Projects">
          {projectSection.projectEntries.map((entry) => (
            <HookSourceRow
              key={entry.cwd}
              entry={entry}
              label={formatProjectRoot(entry.cwd, projectRootLabels)}
              source="project"
              onSelect={onSelect}
            />
          ))}
        </HookSourceGroup>
      ) : null}

      {otherSections.length > 0 ? (
        <HookSourceGroup title="Other sources">
          {otherSections.map((section) =>
            section.entry ? (
              <HookSourceRow
                key={section.source}
                entry={section.entry}
                label={HOOK_SOURCE_LABELS[section.source]}
                source={section.source}
                onSelect={onSelect}
              />
            ) : null,
          )}
        </HookSourceGroup>
      ) : null}
    </>
  );
}

function hookHandlerRows(hook: HookMetadata): readonly (readonly [string, string])[] {
  switch (hook.handlerType) {
    case "command":
      return [
        ["Handler", "Command"],
        ["Command", hook.command],
        ["Execution", hook.async ? "Asynchronous" : "Synchronous"],
      ];
    case "mcpTool":
      return [
        ["Handler", "MCP tool"],
        ["Server", hook.server],
        ["Tool", hook.tool],
      ];
    case "prompt":
      return [["Handler", "Prompt"]];
    case "agent":
      return [["Handler", "Agent"]];
  }
}

function HookDetails({ hook }: { hook: HookMetadata }) {
  const rows = [
    ...hookHandlerRows(hook),
    ...(hook.matcher == null ? [] : [["Matcher", hook.matcher]]),
    [
      "Timeout",
      new Intl.NumberFormat(undefined, {
        style: "unit",
        unit: "second",
        unitDisplay: "narrow",
      }).format(Number(hook.timeoutSec)),
    ],
    ...(hook.statusMessage == null ? [] : [["Status message", hook.statusMessage]]),
  ];

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-token-border text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-3 py-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-token-text-secondary">{label}</dt>
            <dd
              className={cn(
                "min-w-0 text-token-text-primary",
                label === "Command"
                  ? "block font-mono text-xs break-all whitespace-pre-wrap"
                  : null,
                label === "Matcher" ? "font-mono text-xs break-all" : null,
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HookRow({
  hook,
  index,
  onToggle,
  onTrust,
}: {
  hook: HookMetadata;
  index: number;
  onToggle: (hook: HookMetadata, enabled: boolean) => void;
  onTrust: (hook: HookMetadata) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsReview = doesCodexHookNeedReview(hook);
  const managed = hook.isManaged;

  return (
    <div className={cn(expanded ? "pb-2" : null)}>
      <div className="-mx-3 flex items-center gap-2 px-3 hover:bg-token-list-hover-background">
        <div className="relative flex min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            className={cn(
              "flex min-w-0 flex-1 cursor-interaction appearance-none items-center border-0 bg-transparent py-2 pl-7 text-left text-sm text-inherit [font:inherit] focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none",
              managed ? "pr-6" : "pr-12",
            )}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className="shrink-0 text-token-text-primary">Hook {index + 1}</span>
          </button>
          {!managed ? (
            <NodexTooltip tooltipContent="Open config file">
              <button
                type="button"
                aria-label="Open config file"
                className="absolute top-1/2 right-6 inline-flex size-5 -translate-y-1/2 cursor-interaction items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
                onClick={() => {
                  void invoke(
                    "shell:open-file-link",
                    { path: hook.sourcePath },
                    "fileManager",
                  ).catch(() => toast.danger("Could not open config file"));
                }}
              >
                <FileIcon className="icon-xxs" aria-hidden="true" />
              </button>
            </NodexTooltip>
          ) : null}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "icon-2xs pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 text-token-text-secondary",
              expanded ? "rotate-180" : null,
            )}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {needsReview ? (
            <NodexTooltip
              tooltipContent={
                hook.trustStatus === "modified" ? "Hook changed since last trusted" : "New hook"
              }
            >
              <NodexButton variant="outline" size="xs" onClick={() => onTrust(hook)}>
                <PermissionDefaultIcon className="icon-2xs" />
                Trust
              </NodexButton>
            </NodexTooltip>
          ) : null}
          <NodexTooltip
            tooltipContent={
              managed
                ? "Managed hooks are always on"
                : needsReview
                  ? "Disabled until hook is trusted"
                  : undefined
            }
          >
            <span
              className={cn((managed || needsReview) && "inline-flex cursor-not-allowed")}
              tabIndex={managed || needsReview ? 0 : undefined}
            >
              <NodexSwitch
                ariaLabel={`Hook ${index + 1}`}
                checked={managed || (hook.enabled && !needsReview)}
                className={managed || needsReview ? "pointer-events-none" : undefined}
                disabled={managed || needsReview}
                onCheckedChange={(enabled) => onToggle(hook, enabled)}
              />
            </span>
          </NodexTooltip>
        </div>
      </div>
      {expanded ? (
        <div className="pl-7">
          <HookDetails hook={hook} />
        </div>
      ) : null}
    </div>
  );
}

function HooksIssues({ entry }: { entry: CodexHooksSourceEntry }) {
  const [expanded, setExpanded] = useState(false);
  const issueCount = entry.warnings.length + entry.errors.length;
  if (issueCount === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-token-editor-warning-foreground/30 bg-token-editor-warning-background/30">
      <button
        type="button"
        className="flex w-full cursor-interaction items-center justify-between gap-3 px-3 py-2 text-left"
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm text-token-text-primary">
          <TriangleAlert className="icon-xs shrink-0 text-token-editor-warning-foreground" />
          {issueCount} {issueCount === 1 ? "issue" : "issues"} loading hooks for this source
        </span>
        <ChevronDownIcon
          className={cn("icon-2xs transition-transform", expanded ? "rotate-180" : null)}
        />
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-token-editor-warning-foreground/20 px-3 py-2 text-sm text-token-text-secondary">
          {entry.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
          {entry.errors.map((error) => (
            <div key={`${error.path}:${error.message}`}>
              {error.path}: {error.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HooksDetailDialog({
  entry,
  selection,
  title,
  loading,
  loadError,
  onClose,
  onToggle,
  onTrust,
}: {
  entry: CodexHooksSourceEntry | null;
  selection: CodexHooksSettingsSelection | null;
  title: string | null;
  loading: boolean;
  loadError: Error | null;
  onClose: () => void;
  onToggle: (hook: HookMetadata, enabled: boolean) => void;
  onTrust: (hook: HookMetadata) => void;
}) {
  const summaries = summarizeCodexHookEvents(entry?.hooks ?? []).filter(
    (summary) => summary.installed > 0,
  );
  const subtitle =
    selection?.source === "project"
      ? selection.projectRoot
      : selection == null
        ? null
        : "All projects";
  const needsReview = (entry?.hooks.filter(doesCodexHookNeedReview).length ?? 0) > 0;
  const TitleIcon = selection ? HOOK_SOURCE_ICONS[selection.source] : null;

  return (
    <NodexDialog
      open={selection != null && (loading || entry != null)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="large" className="max-h-[calc(100vh-6rem)] min-h-0">
        <NodexDialogFrame className="max-h-[calc(100vh-6rem)] min-h-0">
          <NodexDialogHeader>
            <NodexDialogTitle>
              <span className="flex min-w-0 items-center gap-2">
                {TitleIcon ? (
                  <span className="flex shrink-0 items-center justify-center">
                    <TitleIcon className="icon-sm text-token-text-secondary" />
                  </span>
                ) : null}
                <span className="min-w-0">{title}</span>
              </span>
            </NodexDialogTitle>
            {subtitle ? (
              <NodexDialogDescription className="break-all">{subtitle}</NodexDialogDescription>
            ) : null}
          </NodexDialogHeader>
          <NodexDialogBody className="min-h-0">
            <div className="vertical-scroll-fade-mask flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
              {loading ? (
                <div className="py-10 text-center text-sm text-token-text-secondary">
                  Loading hooks…
                </div>
              ) : null}
              {loadError ? (
                <div className="rounded-lg border border-token-border p-3">
                  <div className="text-sm text-token-text-primary">Could not load hooks</div>
                  <div className="mt-1 break-words text-sm text-token-text-secondary">
                    {loadError.message}
                  </div>
                </div>
              ) : null}
              {needsReview ? (
                <div className="flex gap-2 rounded-lg border border-token-editor-warning-foreground/30 bg-token-editor-warning-background/30 p-3 text-sm text-token-text-primary">
                  <TriangleAlert className="icon-xs shrink-0 text-token-editor-warning-foreground" />
                  Hooks can run outside of the sandbox so we ask you to review any recently
                  installed or modified hooks
                </div>
              ) : null}
              {entry ? <HooksIssues entry={entry} /> : null}
              {entry && summaries.length > 0 ? (
                <div className="divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border border-token-border">
                  {summaries.map((summary) => (
                    <div key={summary.eventName}>
                      <div className="flex items-center gap-3 p-3">
                        <HooksIcon className="icon-xs text-token-text-secondary" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-token-text-primary">
                            {HOOK_EVENT_LABELS[summary.eventName]}
                          </div>
                          <div className="text-sm text-token-text-secondary">
                            {HOOK_EVENT_DESCRIPTIONS[summary.eventName]}
                          </div>
                        </div>
                        {summary.needsReview > 0 ? (
                          <TriangleAlert className="icon-2xs text-token-editor-warning-foreground" />
                        ) : null}
                      </div>
                      <div className="border-t border-token-border px-3">
                        {sortCodexHooksForEvent(entry.hooks, summary.eventName).map(
                          (hook, index) => (
                            <HookRow
                              key={hook.key}
                              hook={hook}
                              index={index}
                              onToggle={onToggle}
                              onTrust={onTrust}
                            />
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export interface CodexHooksSettingsViewProps {
  entries: readonly HooksListEntry[] | null;
  hostId: string;
  path: string;
  projectRoots: readonly string[];
  projectRootLabels: Readonly<Record<string, string>>;
  loading: boolean;
  refreshing: boolean;
  loadError: Error | null;
  onPathChange: (path: string) => void;
  onRefresh: () => void;
  onToggle: (hook: HookMetadata, enabled: boolean) => void;
  onTrust: (hook: HookMetadata) => void;
}

export function CodexHooksSettingsView({
  entries,
  hostId,
  path,
  projectRoots,
  projectRootLabels,
  loading,
  refreshing,
  loadError,
  onPathChange,
  onRefresh,
  onToggle,
  onTrust,
}: CodexHooksSettingsViewProps) {
  const sections = useMemo(() => groupCodexHooksListEntries(entries ?? []), [entries]);
  const selection = parseCodexHooksSettingsSelection(path, projectRoots);
  const selectedEntry = resolveSelectedCodexHooksEntry(sections, selection);
  const selectedTitle = selection
    ? formatSelectionTitle(selection, selectedEntry, projectRootLabels)
    : null;
  const noRoots = projectRoots.length === 0;
  const isEmpty = !loading && !loadError && sections.length === 0;
  const selectSource = (nextSelection: CodexHooksSettingsSelection | null) => {
    onPathChange(
      replaceCodexHooksSettingsSelection(path, {
        hostId,
        selection: nextSelection,
      }),
    );
  };

  return (
    <NodexSettingsPageSurface
      title="Hooks"
      subtitle={
        <span className="whitespace-normal">
          Manage lifecycle hooks from config and enabled plugins.{" "}
          <a
            className="inline-flex text-token-text-link-foreground"
            href="https://developers.openai.com/codex/hooks"
            target="_blank"
            rel="noreferrer"
          >
            Learn more
          </a>
        </span>
      }
      action={
        <NodexTooltip tooltipContent="Reload hooks">
          <NodexButton
            variant="ghost"
            size="icon"
            aria-label="Reload hooks"
            disabled={noRoots || loading || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <ActivitySpinnerIcon className="icon-xs" icon={RefreshIcon} />
            ) : (
              <RefreshIcon className="icon-xs" />
            )}
          </NodexButton>
        </NodexTooltip>
      }
    >
      {noRoots || isEmpty ? (
        <div className="rounded-lg border border-token-border p-3">
          <div className="text-sm text-token-text-primary">No hooks found</div>
          <div className="mt-1 text-sm text-token-text-secondary">
            Configured hooks will appear here
          </div>
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-token-border p-3">
          <div className="text-sm text-token-text-primary">Could not load hooks</div>
          <div className="mt-1 break-words text-sm text-token-text-secondary">
            {loadError.message}
          </div>
        </div>
      ) : loading ? (
        <div className="py-10 text-center text-sm text-token-text-secondary">Loading hooks…</div>
      ) : (
        <HooksOverview
          sections={sections}
          projectRootLabels={projectRootLabels}
          onSelect={selectSource}
        />
      )}

      <HooksDetailDialog
        entry={selectedEntry}
        selection={selection}
        title={selectedTitle}
        loading={loading}
        loadError={loadError}
        onClose={() => selectSource(null)}
        onToggle={onToggle}
        onTrust={onTrust}
      />
    </NodexSettingsPageSurface>
  );
}

export function WorkbenchHooksSettingsPage({
  path,
  onPathChange,
  projects,
}: {
  path: string;
  onPathChange: (path: string) => void;
  projects: readonly Project[];
}) {
  const hostId = parseCodexHooksSettingsHostId(path) ?? DEFAULT_CODEX_HOST_ID;
  const { projectRoots, projectRootLabels } = useMemo(() => {
    const labels: Record<string, string> = {};
    const roots = normalizeCodexHooksCwds(
      projects.flatMap((project) =>
        project.sources.map((source) => {
          labels[source.root] ??= project.name;
          return source.root;
        }),
      ),
    );
    return { projectRoots: roots, projectRootLabels: labels };
  }, [projects]);
  const hooksQuery = useCodexHooksList({ hostId, cwds: projectRoots });
  const hooksMutation = useCodexHookStateMutation(hostId);
  const runMutation = (patch: Parameters<typeof hooksMutation.mutate>[0]) => {
    hooksMutation.mutate(patch, {
      onError: (error) => {
        toast.danger(error instanceof Error ? error.message : "Could not update hook");
      },
    });
  };

  return (
    <CodexHooksSettingsView
      entries={hooksQuery.data?.data ?? null}
      hostId={hostId}
      path={path}
      projectRoots={projectRoots}
      projectRootLabels={projectRootLabels}
      loading={projectRoots.length > 0 && hooksQuery.isPending}
      refreshing={hooksQuery.isFetching && !hooksQuery.isPending}
      loadError={hooksQuery.error instanceof Error ? hooksQuery.error : null}
      onPathChange={onPathChange}
      onRefresh={() => {
        void hooksQuery.refetch();
      }}
      onToggle={(hook, enabled) => runMutation({ key: hook.key, enabled })}
      onTrust={(hook) => runMutation({ key: hook.key, trustedHash: hook.currentHash })}
    />
  );
}
