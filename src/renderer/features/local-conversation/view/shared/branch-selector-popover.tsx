import { useCallback, useMemo, useState, type FormEvent, type ReactElement } from "react";
import {
  BranchStatusIcon,
  CheckmarkIcon,
  PlusIcon,
  ActivitySpinnerIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownMenu,
  NodexDropdownSearchInput,
  NodexDropdownSection,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
  type NodexDropdownContentWidth,
  type NodexDropdownMenuProps,
} from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface BranchSelectorPopoverState {
  currentBranch: string | null;
  defaultBranch?: string | null;
  branches: string[];
}

interface BranchSelectorPopoverProps {
  cwd: string | null;
  state: BranchSelectorPopoverState;
  busy: boolean;
  loading?: boolean;
  error?: boolean;
  onRefresh: () => Promise<void>;
  onCheckout: (branch: string) => Promise<boolean>;
  onCreate?: (branch: string) => Promise<boolean>;
  selectedBranch?: string | null;
  disabled?: boolean;
  triggerClassName?: string;
  renderTrigger?: (state: BranchSelectorTriggerRenderState) => ReactElement;
  side?: NodexDropdownMenuProps["side"];
  align?: NodexDropdownMenuProps["align"];
  sideOffset?: number;
  contentWidth?: NodexDropdownContentWidth;
  contentClassName?: string;
}

function filterBranches(branches: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return branches;
  return branches.filter((branch) => branch.toLowerCase().includes(normalizedQuery));
}

export type BranchSearchEnterAction =
  | { kind: "close" }
  | { kind: "checkout"; branch: string }
  | { kind: "none" };

export function resolveBranchSearchEnterAction({
  search,
  branches,
  currentBranch,
  disabled,
}: {
  search: string;
  branches: string[];
  currentBranch: string | null;
  disabled: boolean;
}): BranchSearchEnterAction {
  if (!search.trim()) return { kind: "close" };
  if (disabled) return { kind: "none" };

  const branch = branches.find((item) => item !== currentBranch) ?? branches[0] ?? null;
  if (!branch) return { kind: "none" };
  return { kind: "checkout", branch };
}

export type BranchCreateValidation = "empty" | "trailing-slash" | "exists" | null;

export function validateCreateBranchName(
  branchName: string,
  existingBranchNames: ReadonlySet<string>,
): BranchCreateValidation {
  const value = branchName.trim();
  if (!value) return "empty";
  if (value.endsWith("/")) return "trailing-slash";
  if (existingBranchNames.has(value)) return "exists";
  return null;
}

export interface BranchSelectorTriggerRenderState {
  triggerLabel: string;
  title: string;
  disabled: boolean;
}

export function BranchSelectorPopover({
  cwd,
  state,
  busy,
  loading = false,
  error = false,
  onRefresh,
  onCheckout,
  onCreate,
  selectedBranch,
  disabled = false,
  triggerClassName,
  renderTrigger,
  side = "top",
  align = "start",
  sideOffset,
  contentWidth = "panel",
  contentClassName,
}: BranchSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");

  const filteredBranches = useMemo(
    () => filterBranches(state.branches, search),
    [search, state.branches],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        void onRefresh();
        return;
      }

      setSearch("");
    },
    [onRefresh],
  );

  const handleBranchSelect = useCallback(
    async (branch: string) => {
      const didCheckout = await onCheckout(branch);
      if (!didCheckout) return;
      setOpen(false);
    },
    [onCheckout],
  );

  const existingBranchNames = useMemo(
    () =>
      new Set([
        ...state.branches,
        ...(state.currentBranch ? [state.currentBranch] : []),
        ...(state.defaultBranch ? [state.defaultBranch] : []),
      ]),
    [state.branches, state.currentBranch, state.defaultBranch],
  );
  const createBranchValue = createBranchName.trim();
  const createBranchValidation = validateCreateBranchName(createBranchName, existingBranchNames);
  const createBranchCanSubmit = Boolean(onCreate && createBranchValidation === null && !busy);

  const handleOpenCreateDialog = useCallback(() => {
    if (!onCreate) return;
    setCreateBranchName(search.trim());
    setOpen(false);
    setCreateDialogOpen(true);
  }, [onCreate, search]);

  const handleCreateSubmit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!createBranchCanSubmit || !onCreate) return;

      const didCreate = await onCreate(createBranchValue);
      if (!didCreate) return;
      setCreateDialogOpen(false);
      setCreateBranchName("");
    },
    [createBranchCanSubmit, createBranchValue, onCreate],
  );

  const activeSelectedBranch = selectedBranch?.trim() || null;
  const currentBranch = activeSelectedBranch ?? state.currentBranch;
  const triggerLabel = currentBranch ?? state.defaultBranch ?? "No branch";
  const isDisabled = disabled || !cwd || busy;
  const hasRepositoryState =
    state.currentBranch !== null || state.branches.length > 0 || Boolean(state.defaultBranch);
  const emptyBranchMessage = !cwd ? "Working directory unavailable" : "No branches found";
  const canCreateBranch = Boolean(
    onCreate && cwd && !busy && hasRepositoryState && !loading && !error,
  );
  const triggerTitle = cwd ? "Switch branch" : "Working directory unavailable";
  const triggerButton = renderTrigger ? (
    renderTrigger({
      triggerLabel,
      title: triggerTitle,
      disabled: isDisabled,
    })
  ) : (
    <NodexDropdownButtonTrigger
      aria-label="Switch branch"
      disabled={isDisabled}
      size="sm"
      chrome="transparent"
      shape="pill"
      muted
      className={cn("px-1.5", triggerClassName)}
    >
      <span className="inline-flex min-w-0 items-center gap-1">
        <BranchStatusIcon className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate text-sm">{triggerLabel}</span>
      </span>
    </NodexDropdownButtonTrigger>
  );

  return (
    <>
      <NodexDropdownMenu
        open={open}
        onOpenChange={handleOpenChange}
        disabled={isDisabled}
        side={side}
        align={align}
        sideOffset={sideOffset}
        triggerButton={triggerButton}
        triggerNativeButton={!renderTrigger}
        triggerTooltipContent={renderTrigger ? undefined : triggerTitle}
        contentWidth={contentWidth}
        contentClassName={contentClassName}
      >
        <div className="flex w-full flex-col gap-1.5 overflow-hidden">
          <NodexDropdownSearchInput
            autoFocus={false}
            placeholder="Search branches"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;

              event.preventDefault();
              const action = resolveBranchSearchEnterAction({
                search,
                branches: filteredBranches,
                currentBranch,
                disabled: busy || loading || error,
              });

              if (action.kind === "close") {
                setOpen(false);
                return;
              }

              if (action.kind !== "checkout") return;
              void handleBranchSelect(action.branch);
            }}
          />

          <NodexDropdownScrollBranchList
            filteredBranches={filteredBranches}
            currentBranch={currentBranch}
            busy={busy}
            loading={loading && state.branches.length === 0}
            error={error}
            emptyBranchMessage={emptyBranchMessage}
            onRetry={onRefresh}
            onBranchSelect={handleBranchSelect}
          />
        </div>

        {onCreate ? (
          <>
            <NodexDropdownSeparator />
            <NodexDropdownItem
              disabled={!canCreateBranch}
              onSelect={handleOpenCreateDialog}
              leftSlot={<PlusIcon className="size-4 shrink-0" />}
            >
              Create and checkout new branch…
            </NodexDropdownItem>
          </>
        ) : null}
      </NodexDropdownMenu>

      <NodexDialog
        open={createDialogOpen}
        onOpenChange={(nextOpen) => {
          setCreateDialogOpen(nextOpen);
          if (!nextOpen) setCreateBranchName("");
        }}
      >
        <NodexDialogContent size="compact" showCloseButton={false}>
          <NodexDialogForm onSubmit={(event) => void handleCreateSubmit(event)}>
            <NodexDialogHeader>
              <NodexDialogTitle>Create and checkout branch</NodexDialogTitle>
              <NodexDialogDescription>
                Create a new branch from the current checkout and switch to it.
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogBody className="gap-2">
              <Input
                autoFocus
                aria-label="Branch name"
                placeholder="new-branch"
                value={createBranchName}
                onChange={(event) => setCreateBranchName(event.currentTarget.value)}
              />
              {createBranchValidation === "trailing-slash" ? (
                <p className="text-xs text-token-charts-red">Branch name cannot end with “/”.</p>
              ) : createBranchValidation === "exists" ? (
                <p className="text-xs text-token-charts-red">Branch already exists.</p>
              ) : null}
            </NodexDialogBody>
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setCreateDialogOpen(false)}>
                Close
              </NodexDialogAction>
              <NodexDialogAction tone="primary" type="submit" disabled={!createBranchCanSubmit}>
                Create and checkout
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogForm>
        </NodexDialogContent>
      </NodexDialog>
    </>
  );
}

function NodexDropdownScrollBranchList({
  filteredBranches,
  currentBranch,
  busy,
  loading,
  error,
  emptyBranchMessage,
  onRetry,
  onBranchSelect,
}: {
  filteredBranches: string[];
  currentBranch: string | null;
  busy: boolean;
  loading: boolean;
  error: boolean;
  emptyBranchMessage: string;
  onRetry: () => Promise<void>;
  onBranchSelect: (branch: string) => Promise<void>;
}) {
  return (
    <div className="vertical-scroll-fade-mask flex h-[200px] flex-col gap-1.5 overflow-y-auto">
      <NodexDropdownSectionLabel>Branches</NodexDropdownSectionLabel>
      {loading ? (
        <NodexDropdownItem disabled leftSlot={<ActivitySpinnerIcon className="icon-xxs" />}>
          Loading branches…
        </NodexDropdownItem>
      ) : error ? (
        <NodexDropdownSection className="flex flex-col gap-1">
          <NodexDropdownSectionLabel>Unable to load branches</NodexDropdownSectionLabel>
          <NodexDropdownItem onSelect={() => void onRetry()}>Retry</NodexDropdownItem>
        </NodexDropdownSection>
      ) : filteredBranches.length === 0 ? (
        <NodexDropdownMessage compact>{emptyBranchMessage}</NodexDropdownMessage>
      ) : (
        <NodexDropdownSection className="flex flex-col">
          {filteredBranches.map((branch) => (
            <NodexDropdownItem
              key={branch}
              disabled={busy}
              onSelect={() => {
                void onBranchSelect(branch);
              }}
              leftSlot={<BranchStatusIcon className="size-3.5 shrink-0" />}
              rightSlot={branch === currentBranch ? <CheckmarkIcon className="shrink-0" /> : null}
              tooltipText={branch}
              tooltipSide="top"
              tooltipAlign="start"
            >
              {branch}
            </NodexDropdownItem>
          ))}
        </NodexDropdownSection>
      )}
    </div>
  );
}
