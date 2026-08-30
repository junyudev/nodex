import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RefreshIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  managedWorktreeSettingsService,
  type ManagedWorktreesSettingsService,
} from "@/lib/managed-worktree-runtime";
import type {
  ManagedWorktreeRecord,
  ManagedWorktreeSettings,
  CodexExecutionHostSettings,
  UpdateManagedWorktreeSettingsInput,
} from "@/lib/types";

export type { ManagedWorktreesSettingsService } from "@/lib/managed-worktree-runtime";

const DEFAULT_SETTINGS: ManagedWorktreeSettings = {
  worktreeRoot: null,
  autoDeleteEnabled: true,
  autoDeleteLimit: 15,
};

export interface ManagedWorktreesSettingControlProps {
  readonly open: boolean;
  readonly service?: ManagedWorktreesSettingsService;
  readonly onOpenThread?: (threadId: string) => void | Promise<void>;
}

interface WorktreeGroup {
  readonly key: string;
  readonly repositoryPath: string;
  readonly records: readonly ManagedWorktreeRecord[];
}

function groupManagedWorktrees(records: readonly ManagedWorktreeRecord[]): WorktreeGroup[] {
  const groups = new Map<
    string,
    {
      repositoryPath: string;
      records: ManagedWorktreeRecord[];
    }
  >();

  for (const record of records) {
    const repositoryPath = record.repositoryPath ?? "Other worktrees";
    const key = `${record.hostId}\0${repositoryPath}`;
    const group = groups.get(key) ?? { repositoryPath, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((left, right) => {
      const leftHasConversation = left.records.some((record) => record.conversations.length > 0);
      const rightHasConversation = right.records.some((record) => record.conversations.length > 0);
      if (leftHasConversation !== rightHasConversation) {
        return leftHasConversation ? -1 : 1;
      }
      return left.repositoryPath.localeCompare(right.repositoryPath);
    });
}

function RefreshWorktreesButton({
  loading,
  onRefresh,
}: {
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <NodexTooltip tooltipContent="Refresh worktrees" side="top">
      <span className="inline-flex shrink-0">
        <NodexButton
          aria-label="Refresh worktrees"
          disabled={loading}
          size="icon-sm"
          variant="ghost"
          onClick={onRefresh}
        >
          <RefreshIcon className="icon-xs" />
        </NodexButton>
      </span>
    </NodexTooltip>
  );
}

function WorktreeCardHeader({
  action,
  title,
}: {
  readonly action?: ReactNode;
  readonly title: string;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
      <NodexTooltip tooltipContent={title} side="top">
        <h2 className="min-w-0 truncate text-sm font-medium text-token-text-primary">{title}</h2>
      </NodexTooltip>
      {action}
    </div>
  );
}

function WorktreeInventoryRow({
  deleting,
  onDelete,
  onOpenThread,
  record,
}: {
  readonly deleting: boolean;
  readonly onDelete: () => void;
  readonly onOpenThread?: (threadId: string) => void | Promise<void>;
  readonly record: ManagedWorktreeRecord;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-token-text-primary">Worktree</div>
          <NodexTooltip tooltipContent={record.path} side="top">
            <div className="mt-1 truncate text-xs text-token-text-secondary">{record.path}</div>
          </NodexTooltip>
        </div>
        <NodexButton
          aria-label={`Delete worktree ${record.path}`}
          aria-busy={deleting}
          className="shrink-0 rounded-xl bg-token-charts-red/10 text-token-charts-red enabled:hover:bg-token-charts-red/20 enabled:active:bg-token-charts-red/30"
          disabled={deleting}
          size="sm"
          variant="ghost"
          onClick={onDelete}
        >
          Delete
        </NodexButton>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-token-text-secondary">Conversations</div>
        {record.conversations.length === 0 ? (
          <div className="text-xs text-token-text-secondary">
            No conversations linked to this worktree.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {record.conversations.map((conversation) => (
              <button
                key={conversation.threadId}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-row-x py-row-y text-start text-sm text-token-text-primary hover:bg-token-list-hover-background hover:text-token-text-primary/80 focus-visible:outline-1 focus-visible:outline-offset-[-2px]"
                type="button"
                onClick={() => void onOpenThread?.(conversation.threadId)}
              >
                <span className="truncate">
                  {conversation.sessionTitle?.trim() ||
                    conversation.threadName?.trim() ||
                    "Untitled conversation"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ManagedWorktreesSettingControl({
  open,
  service = managedWorktreeSettingsService,
  onOpenThread,
}: ManagedWorktreesSettingControlProps) {
  const [settings, setSettings] = useState<ManagedWorktreeSettings | null>(null);
  const [executionHosts, setExecutionHosts] = useState<CodexExecutionHostSettings>({
    sshHosts: [],
  });
  const [selectedHostId, setSelectedHostId] = useState("local");
  const [rootDraft, setRootDraft] = useState("");
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [records, setRecords] = useState<ManagedWorktreeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingSetting, setSavingSetting] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const disableDialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextSettings, nextHosts, nextRecords] = await Promise.all([
        service.getSettings(),
        service.getExecutionHosts(),
        service.list(selectedHostId),
      ]);
      setSettings(nextSettings);
      setExecutionHosts(nextHosts);
      const selectedRemote = nextHosts.sshHosts.find((host) => host.id === selectedHostId);
      setRootDraft(selectedRemote?.managedRoot ?? nextSettings.worktreeRoot ?? "");
      setLimitDraft(null);
      setRecords(nextRecords);
    } catch {
      setLoadError("Something went wrong while loading worktrees.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [selectedHostId, service]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const save = useCallback(
    async (
      patch: UpdateManagedWorktreeSettingsInput,
      successMessage?: string,
    ): Promise<boolean> => {
      if (savingSetting) return false;
      setSavingSetting(true);
      try {
        const next = await service.updateSettings(patch);
        setSettings(next);
        setRootDraft(next.worktreeRoot ?? "");
        setLimitDraft(null);
        if (patch.worktreeRoot !== undefined) await load();
        if (successMessage) toast.success(successMessage);
        return true;
      } catch {
        toast.danger(
          patch.autoDeleteLimit !== undefined
            ? "Failed to save auto-delete limit"
            : patch.autoDeleteEnabled !== undefined
              ? "Failed to save automatic deletion setting"
              : "Failed to save worktree root",
        );
        return false;
      } finally {
        setSavingSetting(false);
      }
    },
    [load, savingSetting, service],
  );

  const resolvedSettings = settings ?? DEFAULT_SETTINGS;
  const selectedRemoteHost = executionHosts.sshHosts.find((host) => host.id === selectedHostId);
  const selectedHostIsLocal = selectedHostId === "local";
  const hostOptions = [
    { value: "local", label: "Local" },
    ...executionHosts.sshHosts
      .filter((host) => host.enabled)
      .map((host) => ({ value: host.id, label: host.displayName })),
  ];
  const groupedRecords = useMemo(() => groupManagedWorktrees(records), [records]);
  const controlsDisabled = !selectedHostIsLocal || savingSetting || (loading && settings === null);

  const saveRoot = useCallback(() => {
    if (controlsDisabled) return;
    const nextRoot = rootDraft.trim() || null;
    if (nextRoot === resolvedSettings.worktreeRoot) return;
    void save({ worktreeRoot: nextRoot });
  }, [controlsDisabled, resolvedSettings.worktreeRoot, rootDraft, save]);

  const saveLimit = useCallback(() => {
    if (controlsDisabled || limitDraft === null) return;
    const normalized = limitDraft.trim();
    const parsed = Number.parseInt(normalized, 10);
    if (normalized.length === 0 || Number.isNaN(parsed)) {
      setLimitDraft(null);
      return;
    }
    const nextLimit = Math.max(1, Math.trunc(parsed));
    setLimitDraft(null);
    if (nextLimit === resolvedSettings.autoDeleteLimit) return;
    void save({ autoDeleteLimit: nextLimit }, "Saved auto-delete limit");
  }, [controlsDisabled, limitDraft, resolvedSettings.autoDeleteLimit, save]);

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <NodexSettingsSection>
        <NodexSettingsRow
          label="Execution host"
          description="Inventory is scoped to one host and its current managed root"
        >
          <NodexOptionPicker
            value={selectedHostId}
            options={hostOptions}
            search="none"
            onValueChange={(hostId) => {
              setSelectedHostId(hostId);
              setRecords([]);
            }}
            triggerButton={
              <NodexDropdownButtonTrigger aria-label="Execution host" className="w-56" size="sm">
                {hostOptions.find((host) => host.value === selectedHostId)?.label ?? "Local"}
              </NodexDropdownButtonTrigger>
            }
          />
        </NodexSettingsRow>
        <NodexSettingsRow
          label="Worktree root"
          description={
            selectedRemoteHost
              ? "Remote roots are managed with this execution host's SSH configuration"
              : "Directory where Nodex creates managed worktrees; leave blank to use the default location"
          }
        >
          <input
            aria-label="Worktree root"
            className="w-56 rounded-md border border-token-input-border bg-token-input-background px-2.5 py-1.5 text-base text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
            disabled={controlsDisabled}
            placeholder="Default"
            value={rootDraft}
            onBlur={saveRoot}
            onChange={(event) => setRootDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "s" || (!event.metaKey && !event.ctrlKey)) return;
              event.preventDefault();
              saveRoot();
            }}
          />
        </NodexSettingsRow>

        <NodexSettingsRow
          label="Automatically delete old worktrees"
          description="Recommended for most users. Turn this off only if you want to manage old worktrees and disk usage yourself."
        >
          <NodexSwitch
            ariaLabel="Automatically delete old worktrees"
            checked={resolvedSettings.autoDeleteEnabled}
            disabled={controlsDisabled}
            onCheckedChange={(enabled) => {
              if (!enabled) {
                disableDialogReturnFocusRef.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setConfirmDisable(true);
                return;
              }
              void save({ autoDeleteEnabled: true }, "Automatic deletion enabled");
            }}
          />
        </NodexSettingsRow>

        <NodexSettingsRow
          label="Auto-delete limit"
          description={
            resolvedSettings.autoDeleteEnabled
              ? "Number of managed worktrees to keep before older ones are pruned automatically. Nodex snapshots worktrees before deleting, so pruned worktrees should always be restorable."
              : "Automatic deletion is disabled. Nodex will not prune old worktrees automatically. Re-enable it to use this saved limit again."
          }
        >
          <div className="ms-6">
            <input
              aria-label="Auto-delete limit"
              className="w-24 rounded-md border border-token-input-border bg-token-input-background px-2.5 py-1.5 text-base text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
              disabled={controlsDisabled || !resolvedSettings.autoDeleteEnabled}
              inputMode="numeric"
              min={1}
              step={1}
              type="number"
              value={limitDraft ?? String(resolvedSettings.autoDeleteLimit)}
              onBlur={saveLimit}
              onChange={(event) => {
                const nextValue = event.target.value;
                setLimitDraft(
                  nextValue === String(resolvedSettings.autoDeleteLimit) ? null : nextValue,
                );
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                saveLimit();
              }}
            />
          </div>
        </NodexSettingsRow>
      </NodexSettingsSection>

      {loading && settings === null ? (
        <div className="semantic-text-secondary text-sm" role="status">
          Fetching worktree details…
        </div>
      ) : loadError ? (
        <NodexSettingsSection>
          <WorktreeCardHeader
            title="Unable to load worktrees"
            action={<RefreshWorktreesButton loading={loading} onRefresh={() => void load()} />}
          />
          <div className="p-3 text-sm text-danger">{loadError}</div>
        </NodexSettingsSection>
      ) : groupedRecords.length === 0 ? (
        <NodexSettingsSection>
          <WorktreeCardHeader
            title="No worktrees yet"
            action={<RefreshWorktreesButton loading={loading} onRefresh={() => void load()} />}
          />
          <div className="semantic-text-secondary p-3 text-sm">
            Worktrees created by Nodex will appear here
          </div>
        </NodexSettingsSection>
      ) : (
        groupedRecords.map((group, groupIndex) => (
          <section key={group.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-h-toolbar items-center justify-between gap-4 pb-1.5">
              <div className="font-medium text-token-text-primary text-base">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <NodexTooltip tooltipContent={group.repositoryPath} side="top">
                    <h2 className="min-w-0 truncate text-sm text-token-text-primary">
                      {group.repositoryPath}
                    </h2>
                  </NodexTooltip>
                </div>
              </div>
              {groupIndex === 0 ? (
                <RefreshWorktreesButton loading={loading} onRefresh={() => void load()} />
              ) : null}
            </div>
            <NodexSettingsSection>
              {group.records.map((record) => {
                const key = `${record.hostId}\0${record.path}`;
                return (
                  <WorktreeInventoryRow
                    key={key}
                    deleting={deletingKey === key}
                    record={record}
                    onOpenThread={onOpenThread}
                    onDelete={() => {
                      if (deletingKey !== null) return;
                      setDeletingKey(key);
                      void service
                        .delete(record.hostId, record.path)
                        .then(() => {
                          setRecords((current) =>
                            current.filter(
                              (item) => item.hostId !== record.hostId || item.path !== record.path,
                            ),
                          );
                        })
                        .catch(() => toast.danger("Failed to delete worktree"))
                        .finally(() => setDeletingKey(null));
                    }}
                  />
                );
              })}
            </NodexSettingsSection>
          </section>
        ))
      )}

      <NodexDialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <NodexDialogContent
          size="compact"
          showCloseButton={false}
          finalFocus={() => {
            disableDialogReturnFocusRef.current?.focus();
            return false;
          }}
        >
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>Disable automatic worktree deletion?</NodexDialogTitle>
            </NodexDialogHeader>
            <NodexDialogDescription>
              We highly recommend keeping automatic deletion on so old worktrees do not build up and
              use unnecessary disk space. If you prefer to manage old worktrees yourself, you can
              turn this off and Nodex will stop deleting them automatically.
            </NodexDialogDescription>
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setConfirmDisable(false)}>
                Keep automatic deletion
              </NodexDialogAction>
              <NodexDialogAction
                disabled={savingSetting}
                tone="danger"
                onClick={() => {
                  void save({ autoDeleteEnabled: false }, "Automatic deletion disabled").then(
                    (saved) => {
                      if (saved) setConfirmDisable(false);
                    },
                  );
                }}
              >
                Disable automatic deletion
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </div>
  );
}
