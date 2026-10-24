import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from "react";
import { parseCodexThreadImportReference } from "../../../shared/codex-thread-import-reference";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
  NativeConversationImportPreviewInput,
  NativeConversationImportPreviewResult,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ClaudeAgentSettings, Project, ProjectWindow } from "../../../shared/types";
import {
  nativeConversationImportLedger,
  nativeConversationImportedCopy,
  type NativeConversationImportLedger,
} from "../../lib/native-conversation-import-ledger";
import {
  latestNativeConversationCandidates,
  mergeNativeConversationCatalogs,
  nativeConversationCandidate,
  nativeConversationImportCwd,
  nativeConversationImportSelection,
  nativeConversationSourceKey,
  type NativeConversationCandidate,
  type NativeConversationCopy,
  type NativeConversationSource,
  type NativeConversationSourceCatalog,
} from "../../lib/native-conversation-import-model";
import {
  importNativeConversation,
  listNativeSessions,
  pickNativeConversationImportDirectory,
  previewNativeConversationImport,
  readNativeSessionProjects,
} from "../../lib/native-session-catalog";
import { AcpNativeConversationsSection } from "@/features/acp-agents/acp-native-conversations-section";
import { NodexButton } from "../ui/button";
import { NodexCompactFramedInput } from "../ui/input";
import { NodexSettingsPageSurface, NodexSettingsSection } from "../ui/settings";
import {
  ConversationImportDestinationPicker,
  ConversationImportFooter,
  ConversationImportRow,
  conversationSourceName,
  type ConversationImportDestinations,
  type ConversationImportRowState,
} from "./conversation-import-list";
import { readClaudeAgentSettings } from "./workbench-settings-overlay-deps";
import type {
  SettingsOpenThread,
  SettingsSectionPageProps,
} from "./workbench-settings-page-registry";

export interface ConversationImportRuntime {
  readonly profiles: () => Promise<ClaudeAgentSettings>;
  readonly projects: (after?: string | null) => Promise<ProjectWindow>;
  readonly list: (input: NativeSessionCatalogInput) => Promise<NativeSessionCatalogPage>;
  readonly preview: (
    input: NativeConversationImportPreviewInput,
  ) => Promise<NativeConversationImportPreviewResult>;
  readonly importConversation: (
    input: NativeConversationImportInput,
  ) => Promise<NativeConversationImportOutcome>;
  readonly pickDirectory: () => Promise<string | null>;
}

const defaultRuntime: ConversationImportRuntime = {
  profiles: readClaudeAgentSettings,
  projects: readNativeSessionProjects,
  list: listNativeSessions,
  preview: previewNativeConversationImport,
  importConversation: importNativeConversation,
  pickDirectory: pickNativeConversationImportDirectory,
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Consecutive pages without importable rows read in one go, so recency order stays append-only. */
const EMPTY_PAGE_DRAIN_LIMIT = 10;

type ProjectNames = readonly Pick<Project, "id" | "name">[];

const NO_PROJECTS: ProjectNames = [];

export function ConversationImportSettingsPage({
  open,
  activeProjectId = null,
  projects: settingsProjects = NO_PROJECTS,
  onOpenThread,
  runtime = defaultRuntime,
  ledger = nativeConversationImportLedger,
}: Pick<SettingsSectionPageProps, "open" | "onOpenThread"> & {
  readonly activeProjectId?: string | null;
  /** The workbench's loaded Projects; names an active Project beyond this page's first window. */
  readonly projects?: ProjectNames;
  readonly runtime?: ConversationImportRuntime;
  readonly ledger?: NativeConversationImportLedger;
}) {
  const [profiles, setProfiles] = useState<ClaudeAgentSettings | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectWindow | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // One Project read at a time, so a page of more Projects never races a fresh first page.
  const projectsRead = useRef<Promise<void> | null>(null);
  // Each read stands alone: Claude profiles only add sources, Projects only add destinations.
  const readProfiles = (isCurrent: () => boolean = () => true) =>
    runtime.profiles().then(
      (next) => {
        if (!isCurrent()) return;
        setProfiles(next);
        setProfilesError(null);
      },
      (cause: unknown) => {
        if (isCurrent()) setProfilesError(errorMessage(cause));
      },
    );

  const readProjects = (after: string | null, isCurrent: () => boolean = () => true) => {
    if (projectsRead.current) return;
    projectsRead.current = runtime
      .projects(after)
      .then(
        (next) => {
          if (!isCurrent()) return;
          setProjects((current) =>
            current && after ? { ...next, items: [...current.items, ...next.items] } : next,
          );
          setProjectsError(null);
        },
        (cause: unknown) => {
          if (isCurrent()) setProjectsError(errorMessage(cause));
        },
      )
      .finally(() => {
        projectsRead.current = null;
        setLoadingProjects(false);
      });
  };

  const readMoreProjects = () => {
    if (projectsRead.current || (projects && !projects.nextCursor)) return;
    setLoadingProjects(true);
    readProjects(projects?.nextCursor ?? null);
  };

  const readSettings = useEffectEvent((isCurrent: () => boolean) => {
    void readProfiles(isCurrent);
    readProjects(null, isCurrent);
  });

  useEffect(() => {
    if (!open) return;
    let active = true;
    readSettings(() => active);
    return () => {
      active = false;
    };
  }, [open]);

  const claudeProfiles = profiles?.instances.filter((instance) => instance.enabled) ?? [];
  const sources: readonly NativeConversationSource[] = [
    { backendKind: "codex" },
    ...claudeProfiles.map((profile): NativeConversationSource => ({
      backendKind: "claude",
      instanceConfigId: profile.id,
      ...(claudeProfiles.length > 1 ? { profileName: profile.displayName } : {}),
    })),
  ];

  const loaded = projects?.items ?? [];
  const projectName = (projectId: string) =>
    (
      loaded.find((project) => project.id === projectId) ??
      settingsProjects.find((project) => project.id === projectId)
    )?.name ?? null;
  const destinationName = (projectId: string | null) =>
    projectId === null ? "Projectless" : (projectName(projectId) ?? "the chosen Project");

  const destinations = (selected: string | null): ConversationImportDestinations => ({
    options: [
      { projectId: null, label: "Projectless" },
      ...[...new Set([activeProjectId, selected])]
        .filter((id): id is string => !!id && !loaded.some((project) => project.id === id))
        .map((projectId) => ({
          projectId,
          label: projectName(projectId) ?? "Current Project",
        })),
      ...loaded.map((project) => ({ projectId: project.id, label: project.name })),
    ],
    hasMore: Boolean(projects?.nextCursor),
    loadingMore: loadingProjects,
    loadMore: readMoreProjects,
  });

  return (
    <NodexSettingsPageSurface title="Conversations">
      {profilesError ? (
        <ReadFailure
          label="Claude Code profiles"
          message={profilesError}
          onRetry={() => void readProfiles()}
        />
      ) : null}
      {projectsError ? (
        <ReadFailure
          label="Projects"
          message={projectsError}
          disabled={loadingProjects}
          onRetry={readMoreProjects}
        />
      ) : null}
      <ConversationImportSection
        open={open}
        runtime={runtime}
        ledger={ledger}
        sources={sources}
        // The active Project is the default even before, or without, the Project list naming it.
        defaultProjectId={activeProjectId}
        destinationName={destinationName}
        destinations={destinations}
        onOpenThread={onOpenThread}
      />
      <AcpNativeConversationsSection
        defaultProjectId={activeProjectId}
        destinations={destinations}
        onOpenThread={onOpenThread}
      />
    </NodexSettingsPageSurface>
  );
}

function ReadFailure({
  label,
  message,
  disabled = false,
  onRetry,
}: {
  label: string;
  message: string;
  disabled?: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-danger">
      <span role="alert" className="min-w-0 flex-1">
        {label}: {message}
      </span>
      <NodexButton size="sm" variant="ghost" disabled={disabled} onClick={onRetry}>
        Try again
      </NodexButton>
    </div>
  );
}

type Lookup =
  | { readonly kind: "idle" }
  | { readonly kind: "invalid" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "none" }
  | { readonly kind: "imported" }
  | { readonly kind: "several"; readonly count: number };

interface Browse {
  readonly catalogs: ReadonlyMap<string, NativeConversationSourceCatalog>;
  readonly loading: ReadonlySet<string>;
  readonly errors: ReadonlyMap<
    string,
    { readonly source: NativeConversationSource; readonly message: string }
  >;
}

interface ImportProgress {
  readonly done: number;
  readonly total: number;
}

interface ImportSummary {
  readonly imported: number;
  readonly failed: number;
}

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) => new Map(map).set(key, value);

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

function ConversationImportSection({
  open,
  runtime,
  ledger,
  sources,
  defaultProjectId,
  destinationName,
  destinations,
  onOpenThread,
}: {
  open: boolean;
  runtime: ConversationImportRuntime;
  ledger: NativeConversationImportLedger;
  sources: readonly NativeConversationSource[];
  defaultProjectId: string | null;
  destinationName: (projectId: string | null) => string;
  destinations: (selected: string | null) => ConversationImportDestinations;
  onOpenThread?: SettingsOpenThread;
}) {
  const hintId = useId();
  const [reference, setReference] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  // Conversations found by link or ID stay listed above browsed ones.
  const [found, setFound] = useState<readonly NativeConversationCandidate[]>([]);
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [selection, setSelection] = useState<ReadonlyMap<string, NativeConversationCandidate>>(
    new Map(),
  );
  const [replacements, setReplacements] = useState<ReadonlyMap<string, string>>(new Map());
  // Accepted requests, in-flight submissions and settled copies outlive this page in the ledger.
  const entries = useSyncExternalStore(ledger.subscribe, ledger.snapshot);
  const [rowStates, setRowStates] = useState<ReadonlyMap<string, ConversationImportRowState>>(
    new Map(),
  );
  const [projectChoice, setProjectChoice] = useState<string | null | undefined>(undefined);
  const projectId = projectChoice === undefined ? defaultProjectId : projectChoice;
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const importing = progress !== null;
  const locked = importing || choosingFolder;
  const lookupGeneration = useRef(0);
  const browseGeneration = useRef(0);
  // Sources already read by the current browse; profiles that load later join it.
  const requestedSources = useRef(new Set<string>());
  const pasted = useRef(false);
  // Each visible stay of this page; closing Settings ends it.
  const visit = useRef(0);

  useEffect(() => {
    if (!open) return;
    return () => {
      visit.current += 1;
      lookupGeneration.current += 1;
      setLookup((current) => (current.kind === "loading" ? { kind: "idle" } : current));
    };
  }, [open]);

  // Rendered with the sources known now, so a profile that loads after a lookup is still named.
  const present = (row: NativeConversationCandidate): NativeConversationCandidate => {
    const { backendKind, instanceConfigId } = row.source;
    const source = sources.find(
      (candidate) =>
        candidate.backendKind === backendKind && candidate.instanceConfigId === instanceConfigId,
    );
    return {
      ...row,
      ...(source ? { source } : {}),
      imported: nativeConversationImportedCopy(row, entries.get(row.key)),
    };
  };

  const merged = mergeNativeConversationCatalogs(
    sources.flatMap((source) => browse?.catalogs.get(nativeConversationSourceKey(source)) ?? []),
  );
  const listed = [...found, ...merged.candidates];
  const pendingFor = (key: string) => {
    const entry = entries.get(key);
    return entry && entry.status !== "imported" ? entry : null;
  };
  // Selected conversations and unfinished imports stay in view even when no current read lists
  // them, so an accepted request can always be finished.
  const rows = latestNativeConversationCandidates([
    ...[
      ...[...entries.values()].flatMap((entry) =>
        entry.status === "imported" ? [] : [entry.candidate],
      ),
      ...selection.values(),
    ].filter((row) => !listed.some((candidate) => candidate.key === row.key)),
    ...listed,
  ]).map(present);
  const selectable = rows.filter(
    (row) => !row.imported && pendingFor(row.key)?.status !== "sending",
  );
  const selected = selectable.filter((row) => selection.has(row.key));
  const needingFolder = selected.filter(
    (row) => !pendingFor(row.key) && !nativeConversationImportCwd(row, replacements),
  );
  const browsing = browse !== null && browse.loading.size > 0;

  const changeSelection = (change: (current: Map<string, NativeConversationCandidate>) => void) => {
    setSelection((current) => {
      const next = new Map(current);
      change(next);
      return next;
    });
    setSummary(null);
  };

  const lookUp = async (value: string) => {
    const ownGeneration = ++lookupGeneration.current;
    setLookup({ kind: "loading" });
    const observedAt = ledger.now();
    try {
      const { matches } = await runtime.preview({ reference: value.trim() });
      if (lookupGeneration.current !== ownGeneration) return;
      const candidates = latestNativeConversationCandidates(
        matches.map((match) =>
          nativeConversationCandidate(
            {
              backendKind: match.backendKind,
              ...(match.instanceConfigId ? { instanceConfigId: match.instanceConfigId } : {}),
            },
            match.nativeHome,
            match,
            observedAt,
          ),
        ),
      );
      if (candidates.length === 0) {
        setLookup({ kind: "none" });
        return;
      }
      setFound((current) => latestNativeConversationCandidates([...candidates, ...current]));
      setReference("");
      const [only] = candidates;
      if (candidates.length > 1) setLookup({ kind: "several", count: candidates.length });
      else if (nativeConversationImportedCopy(only!, entries.get(only!.key)))
        setLookup({ kind: "imported" });
      else {
        setLookup({ kind: "idle" });
        changeSelection((next) => next.set(only!.key, only!));
      }
    } catch (cause) {
      if (lookupGeneration.current === ownGeneration)
        setLookup({ kind: "failed", message: errorMessage(cause) });
    }
  };

  const changeReference = (value: string) => {
    const wasPasted = pasted.current;
    pasted.current = false;
    setReference(value);
    if (parseCodexThreadImportReference(value)) {
      void lookUp(value);
      return;
    }
    lookupGeneration.current += 1;
    setLookup(wasPasted && value.trim() ? { kind: "invalid" } : { kind: "idle" });
  };

  const submitReference = () => {
    if (!parseCodexThreadImportReference(reference)) {
      if (reference.trim()) setLookup({ kind: "invalid" });
      return;
    }
    if (lookup.kind !== "loading") void lookUp(reference);
  };

  const loadSource = async (
    source: NativeConversationSource,
    cursor: string | null,
    generation: number,
  ) => {
    const key = nativeConversationSourceKey(source);
    const read = (after: string | null) =>
      runtime.list({
        backendKind: source.backendKind,
        ...(source.instanceConfigId ? { instanceConfigId: source.instanceConfigId } : {}),
        ...(after ? { cursor: after } : {}),
      });
    setBrowse(
      (current) =>
        current && {
          ...current,
          loading: new Set(current.loading).add(key),
          errors: withoutEntry(current.errors, key),
        },
    );
    const observedAt = ledger.now();
    try {
      let page = await read(cursor);
      for (
        let drained = 0;
        page.entries.length === 0 && page.nextCursor && drained < EMPTY_PAGE_DRAIN_LIMIT;
        drained += 1
      ) {
        if (browseGeneration.current !== generation) return;
        page = await read(page.nextCursor);
      }
      if (browseGeneration.current !== generation) return;
      const candidates = page.entries.map((entry) =>
        nativeConversationCandidate(source, page.nativeHome, entry, observedAt),
      );
      setBrowse((current) => {
        if (!current) return current;
        const previous = cursor ? current.catalogs.get(key) : undefined;
        const loading = new Set(current.loading);
        loading.delete(key);
        return {
          ...current,
          loading,
          catalogs: withEntry(current.catalogs, key, {
            source,
            nativeHome: page.nativeHome,
            nextCursor: page.nextCursor,
            candidates:
              previous?.nativeHome === page.nativeHome
                ? [...previous.candidates, ...candidates]
                : candidates,
          }),
        };
      });
    } catch (cause) {
      if (browseGeneration.current !== generation) return;
      setBrowse((current) => {
        if (!current) return current;
        const loading = new Set(current.loading);
        loading.delete(key);
        return {
          ...current,
          loading,
          errors: withEntry(current.errors, key, { source, message: errorMessage(cause) }),
        };
      });
    }
  };

  const requestSources = () => {
    for (const source of sources) {
      const key = nativeConversationSourceKey(source);
      if (requestedSources.current.has(key)) continue;
      requestedSources.current.add(key);
      void loadSource(source, null, browseGeneration.current);
    }
  };

  const browseAll = () => {
    browseGeneration.current += 1;
    requestedSources.current = new Set();
    setBrowse({ catalogs: new Map(), loading: new Set(), errors: new Map() });
    requestSources();
  };

  // Profiles that finish loading after Browse join the browse already shown.
  const requestLateSources = useEffectEvent((_sourceKeys: string) => requestSources());
  const sourceKeys = sources.map(nativeConversationSourceKey).join("\n");
  const browsed = browse !== null;
  useEffect(() => {
    if (browsed) requestLateSources(sourceKeys);
  }, [browsed, sourceKeys]);

  const retrySource = (source: NativeConversationSource) => {
    const catalog = browse?.catalogs.get(nativeConversationSourceKey(source));
    void loadSource(source, catalog?.nextCursor ?? null, browseGeneration.current);
  };

  const chooseFolder = async (row: NativeConversationCandidate) => {
    if (locked) return;
    setChoosingFolder(true);
    try {
      const picked = await runtime.pickDirectory();
      if (!picked) return;
      setReplacements((current) => withEntry(current, row.cwd, picked));
      setRowStates((current) => withoutEntry(current, row.key));
      setSummary(null);
    } catch (cause) {
      setRowStates((current) =>
        withEntry(current, row.key, { kind: "failed", message: errorMessage(cause) }),
      );
    } finally {
      setChoosingFolder(false);
    }
  };

  const openCopy = async (key: string, copy: NativeConversationCopy) => {
    if (!onOpenThread) return;
    setRowStates((current) => withEntry(current, key, { kind: "opening" }));
    try {
      await onOpenThread(copy.threadId, { runtimeSessionId: copy.sessionId });
      setRowStates((current) => withoutEntry(current, key));
    } catch (cause) {
      setRowStates((current) =>
        withEntry(current, key, { kind: "failed", message: errorMessage(cause) }),
      );
    }
  };

  const importSelected = async () => {
    if (locked || selected.length === 0 || needingFolder.length > 0) return;
    // New imports take the current controls; an unfinished one is finished with its own request.
    const targets = selected.map((row) => ({
      row,
      selection: nativeConversationImportSelection(
        row,
        projectId,
        nativeConversationImportCwd(row, replacements) ?? pendingFor(row.key)!.request.cwd,
      ),
    }));
    const ownVisit = visit.current;
    setSummary(null);
    setProgress({ done: 0, total: targets.length });
    let lastCopy: { key: string; copy: NativeConversationCopy } | null = null;
    let imported = 0;
    for (const [index, { row, selection: target }] of targets.entries()) {
      setRowStates((current) => withoutEntry(current, row.key));
      const settlement = await ledger.submit(row, target, runtime.importConversation);
      if (settlement.kind === "imported") {
        lastCopy = { key: row.key, copy: settlement.copy };
        imported += 1;
        setSelection((current) => withoutEntry(current, row.key));
      } else if (settlement.kind === "not_admitted") {
        // Nothing was created, so the folder or destination may be changed before trying anew.
        setRowStates((current) =>
          withEntry(current, row.key, { kind: "failed", message: settlement.message }),
        );
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    setSummary({ imported, failed: targets.length - imported });
    // One conversation is opened right away, but only for someone still looking at this page.
    if (targets.length === 1 && lastCopy && visit.current === ownVisit)
      await openCopy(lastCopy.key, lastCopy.copy);
  };

  const hint =
    lookup.kind === "invalid" ? (
      <p role="alert" id={hintId} className="text-xs text-danger">
        Paste a codex://threads link or a conversation ID.
      </p>
    ) : lookup.kind === "loading" ? (
      <p role="status" id={hintId} className="text-xs text-token-text-secondary">
        Looking up conversation…
      </p>
    ) : lookup.kind === "failed" ? (
      <p id={hintId} className="flex min-w-0 items-center gap-2 text-xs text-danger">
        <span role="alert" className="min-w-0">
          {lookup.message}
        </span>
        <NodexButton size="xs" variant="ghost" onClick={submitReference}>
          Try again
        </NodexButton>
      </p>
    ) : lookup.kind === "none" ? (
      <p role="status" id={hintId} className="text-xs text-token-text-secondary">
        No Codex or Claude Code conversation has this ID.
      </p>
    ) : lookup.kind === "imported" ? (
      <p role="status" id={hintId} className="text-xs text-token-text-secondary">
        Already imported. Open the existing chat below.
      </p>
    ) : lookup.kind === "several" ? (
      <p role="status" id={hintId} className="text-xs text-token-text-secondary">
        Found in {lookup.count} places. Select the one to import.
      </p>
    ) : (
      <p id={hintId} className="text-xs text-token-description-foreground">
        Each import is a new chat with copied history and the same Agent. The original stays
        unchanged.
      </p>
    );

  const importLabel = importing
    ? "Importing…"
    : selected.length === 1 && onOpenThread
      ? "Import and open"
      : selected.length > 1
        ? `Import ${selected.length}`
        : "Import";

  const footerSummary = progress
    ? progress.total > 1
      ? `Importing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
      : "Importing…"
    : summary
      ? summary.failed > 0
        ? `${summary.imported} imported · ${summary.failed} failed`
        : `Imported ${summary.imported} ${plural(summary.imported, "conversation", "conversations")}`
      : selected.length === 0
        ? "Select conversations to import"
        : needingFolder.length > 0
          ? `${selected.length} selected · ${needingFolder.length} ${plural(needingFolder.length, "needs a folder", "need a folder")}`
          : `${selected.length} selected`;

  return (
    <NodexSettingsSection title="Import" cardClassName="overflow-visible">
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <div className="flex items-center gap-2">
          <NodexCompactFramedInput
            aria-label="Conversation link or ID"
            aria-describedby={hintId}
            placeholder="Paste a Codex link or conversation ID"
            spellCheck={false}
            autoComplete="off"
            className="h-8 flex-1 px-2.5"
            readOnly={importing}
            value={reference}
            onPaste={() => {
              pasted.current = true;
            }}
            onChange={(event) => changeReference(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submitReference();
            }}
          />
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={browsing || importing}
            onClick={browseAll}
          >
            {browsing && merged.candidates.length === 0
              ? "Loading…"
              : browse
                ? "Refresh"
                : "Browse"}
          </NodexButton>
        </div>
        {hint}
      </div>

      {rows.map((row) => {
        const pending = pendingFor(row.key);
        return (
          <ConversationImportRow
            key={row.key}
            candidate={row}
            selected={selection.has(row.key)}
            cwd={nativeConversationImportCwd(row, replacements)}
            pending={
              pending
                ? {
                    cwd: pending.request.cwd,
                    destination: destinationName(pending.request.projectId),
                    unsettled: pending.status === "unsettled" ? pending.message : null,
                  }
                : null
            }
            state={pending?.status === "sending" ? { kind: "importing" } : rowStates.get(row.key)}
            locked={locked || pending?.status === "sending"}
            canOpen={Boolean(onOpenThread)}
            onToggle={() =>
              changeSelection((next) => {
                if (!next.delete(row.key)) next.set(row.key, row);
              })
            }
            onChooseFolder={() => void chooseFolder(row)}
            onOpen={() => row.imported && void openCopy(row.key, row.imported)}
          />
        );
      })}

      {browse && !browsing && rows.length === 0 && browse.errors.size === 0 ? (
        <div className="px-4 py-3 text-sm text-token-text-secondary">No conversations found.</div>
      ) : null}

      {merged.next ? (
        <div className="px-2 py-1.5">
          <NodexButton
            size="sm"
            variant="ghost"
            className="text-token-text-secondary"
            disabled={browsing || importing}
            onClick={() =>
              merged.next &&
              void loadSource(merged.next.source, merged.next.nextCursor, browseGeneration.current)
            }
          >
            {browsing ? "Loading…" : "Show more"}
          </NodexButton>
        </div>
      ) : null}

      {[...(browse?.errors.values() ?? [])].map(({ source, message }) => (
        <div
          key={nativeConversationSourceKey(source)}
          className="flex min-w-0 items-center gap-2 px-4 py-2 text-xs text-danger"
        >
          <span role="alert" className="min-w-0 flex-1">
            {source.profileName
              ? `${conversationSourceName(source)} · ${source.profileName}`
              : conversationSourceName(source)}
            : {message}
          </span>
          <NodexButton
            size="xs"
            variant="ghost"
            disabled={browsing || importing}
            onClick={() => retrySource(source)}
          >
            Try again
          </NodexButton>
        </div>
      ))}

      {rows.length > 0 ? (
        <ConversationImportFooter
          selectAll={{
            checked: selectable.length > 0 && selected.length === selectable.length,
            disabled: locked || selectable.length === 0,
            onCheckedChange: () =>
              changeSelection((next) => {
                if (selected.length === selectable.length) next.clear();
                else for (const row of selectable) next.set(row.key, row);
              }),
          }}
          summary={footerSummary}
        >
          <span className="text-xs text-token-description-foreground">Destination</span>
          <ConversationImportDestinationPicker
            destinations={destinations(projectId)}
            value={projectId}
            onValueChange={(next) => {
              setProjectChoice(next);
              setSummary(null);
            }}
            disabled={locked}
          />
          <NodexButton
            size="sm"
            variant="primary"
            disabled={locked || selected.length === 0 || needingFolder.length > 0}
            onClick={() => void importSelected()}
          >
            {importLabel}
          </NodexButton>
        </ConversationImportFooter>
      ) : null}
    </NodexSettingsSection>
  );
}
