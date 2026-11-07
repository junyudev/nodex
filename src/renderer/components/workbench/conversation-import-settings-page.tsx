import { runWithCleanup } from "@/lib/run-with-cleanup";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { parseCodexThreadImportReference } from "../../../shared/codex-thread-import-reference";
import {
  abbreviateHomeDirectory,
  type LocalPathPresentationContext,
} from "../../../shared/local-path-presentation";
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
  filterNativeConversations,
  latestNativeConversationCandidates,
  mergeNativeConversationCatalogs,
  NO_NATIVE_CONVERSATION_FILTERS,
  nativeConversationCandidate,
  nativeConversationFiltersActive,
  nativeConversationFolderCounts,
  nativeConversationImportCwd,
  nativeConversationImportSelection,
  nativeConversationSourceKey,
  readNativeConversationCatalog,
  type NativeConversationCandidate,
  type NativeConversationCopy,
  type NativeConversationFilters,
  type NativeConversationSource,
  type NativeConversationSourceCatalog,
} from "../../lib/native-conversation-import-model";
import {
  importNativeConversation,
  listNativeSessions,
  pickNativeConversationImportDirectory,
  previewNativeConversationImport,
  readNativeSessionPathContext,
  readNativeSessionProjects,
} from "../../lib/native-session-catalog";
import { AcpNativeConversationsSection } from "@/features/acp-agents/acp-native-conversations-section";
import { ActivitySpinnerIcon, AgentProviderIcon, RefreshIcon } from "../shared/icons";
import { NodexButton, NodexIconButton } from "../ui/button";
import { PageSearchInput } from "../ui/page-search-input";
import { NodexSettingsPageSurface, NodexSettingsSection } from "../ui/settings";
import {
  ConversationImportDestinationPicker,
  ConversationImportFilterPicker,
  ConversationImportFooter,
  ConversationImportRow,
  ConversationImportRows,
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
  readonly pathContext: () => Promise<LocalPathPresentationContext>;
}

const defaultRuntime: ConversationImportRuntime = {
  profiles: readClaudeAgentSettings,
  projects: readNativeSessionProjects,
  list: listNativeSessions,
  preview: previewNativeConversationImport,
  importConversation: importNativeConversation,
  pickDirectory: pickNativeConversationImportDirectory,
  pathContext: readNativeSessionPathContext,
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

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
  const [pathContext, setPathContext] = useState<LocalPathPresentationContext | null>(null);

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
    // Only shortens how folders read; full paths stand in until it arrives, or if it never does.
    void runtime.pathContext().then(
      (next) => {
        if (isCurrent()) setPathContext(next);
      },
      () => {},
    );
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
    <NodexSettingsPageSurface
      title="Conversations"
      subtitle="Each import is a new chat with copied history and the same Agent. The original stays unchanged."
    >
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
        pathContext={pathContext}
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
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly candidates: readonly NativeConversationCandidate[] };

interface Browse {
  readonly catalogs: ReadonlyMap<string, NativeConversationSourceCatalog>;
  readonly loading: ReadonlySet<string>;
  readonly errors: ReadonlyMap<
    string,
    { readonly source: NativeConversationSource; readonly message: string }
  >;
}

const NOT_BROWSED: Browse = { catalogs: new Map(), loading: new Set(), errors: new Map() };

interface ImportProgress {
  readonly done: number;
  readonly total: number;
}

interface ImportSummary {
  readonly imported: number;
  readonly failed: number;
}

/** A filter picker's option standing for "don't narrow by this". */
const ALL = "all";

const NO_FOUND: readonly NativeConversationCandidate[] = [];

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) => new Map(map).set(key, value);

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

const withoutKey = <K,>(set: ReadonlySet<K>, key: K) => {
  const next = new Set(set);
  next.delete(key);
  return next;
};

const count = (value: number) => value.toLocaleString();

const conversations = (value: number) =>
  `${count(value)} ${plural(value, "conversation", "conversations")}`;

function ConversationImportSection({
  open,
  runtime,
  ledger,
  sources,
  pathContext,
  defaultProjectId,
  destinationName,
  destinations,
  onOpenThread,
}: {
  open: boolean;
  runtime: ConversationImportRuntime;
  ledger: NativeConversationImportLedger;
  sources: readonly NativeConversationSource[];
  pathContext: LocalPathPresentationContext | null;
  defaultProjectId: string | null;
  destinationName: (projectId: string | null) => string;
  destinations: (selected: string | null) => ConversationImportDestinations;
  onOpenThread?: SettingsOpenThread;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  // Typing stays immediate while a long history filters behind it.
  const deferredQuery = useDeferredValue(query);
  const [narrowing, setNarrowing] = useState<Omit<NativeConversationFilters, "query">>(
    NO_NATIVE_CONVERSATION_FILTERS,
  );
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  const [browse, setBrowse] = useState<Browse>(NOT_BROWSED);
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
  // Each visible stay of this page; closing Settings ends it.
  const visit = useRef(0);

  /** A pasted link or ID names one conversation exactly, wherever it is and whatever is filtered. */
  const reference = parseCodexThreadImportReference(query);
  const found = lookup.kind === "found" ? lookup.candidates : NO_FOUND;

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
    sources.flatMap((source) => {
      const key = nativeConversationSourceKey(source);
      const catalog = browse.catalogs.get(key);
      if (!catalog) return [];
      // A source that stopped reading must not hold back the older rows of the others.
      return browse.errors.has(key) ? { ...catalog, nextCursor: null } : catalog;
    }),
  );
  const pendingFor = (key: string) => {
    const entry = entries.get(key);
    return entry && entry.status !== "imported" ? entry : null;
  };
  const listedKeys = new Set(merged.map((row) => row.key));
  // Selected conversations and unfinished imports exist even when no current read lists them, so
  // an accepted request can always be finished.
  const rows = latestNativeConversationCandidates([
    ...found,
    ...[
      ...[...entries.values()].flatMap((entry) =>
        entry.status === "imported" ? [] : [entry.candidate],
      ),
      ...selection.values(),
    ].filter((row) => !listedKeys.has(row.key)),
    ...merged,
    // Placed by the entries above; a selected row's own observation can still be the newest.
    ...selection.values(),
  ]).map(present);
  const isSelected = (key: string) => selection.has(key);
  const isSelectable = (row: NativeConversationCandidate) =>
    !row.imported && pendingFor(row.key)?.status !== "sending";
  const isUnsettled = (row: NativeConversationCandidate) =>
    pendingFor(row.key)?.status === "unsettled";

  // Emptying the selection leaves nothing for the Selected view to show.
  const filters: NativeConversationFilters = {
    ...narrowing,
    query: deferredQuery,
    status: narrowing.status === "selected" && selection.size === 0 ? ALL : narrowing.status,
  };
  const foundKeys = new Set(found.map((row) => row.key));
  const matching = filterNativeConversations(rows, filters, isSelected);
  // What an unfinished import needs from the person stays in sight whatever is being searched.
  const visible = reference
    ? rows.filter((row) => foundKeys.has(row.key))
    : [...rows.filter(isUnsettled), ...matching.filter((row) => !isUnsettled(row))];
  const filtersActive = nativeConversationFiltersActive(filters);
  const visibleKeys = new Set(visible.map((row) => row.key));

  const selected = rows.filter((row) => isSelectable(row) && selection.has(row.key));
  const selectedOutOfView = selected.filter((row) => !visibleKeys.has(row.key)).length;
  const needingFolder = selected.filter(
    (row) => !pendingFor(row.key) && !nativeConversationImportCwd(row, replacements),
  );
  const visibleSelectable = visible.filter(isSelectable);
  const visibleSelected = visibleSelectable.filter((row) => selection.has(row.key)).length;
  const reading = browse.loading.size > 0;

  // Each picker counts what it would show given every other filter, so no choice comes up empty.
  const forPicker = (dimension: Partial<NativeConversationFilters>) =>
    filterNativeConversations(rows, { ...filters, ...dimension }, isSelected);
  const statusRows = forPicker({ status: ALL });
  const sourceRows = forPicker({ sourceKey: null });
  const folderRows = forPicker({ cwd: null });
  const folderCounts = nativeConversationFolderCounts(folderRows);
  const sourceOptions = sources.flatMap((source) => {
    const value = nativeConversationSourceKey(source);
    const held = sourceRows.filter((row) => nativeConversationSourceKey(row.source) === value);
    // A profile sharing another's history home lists nothing of its own.
    if (held.length === 0 && narrowing.sourceKey !== value) return [];
    return {
      value,
      label: source.profileName
        ? `${conversationSourceName(source)} · ${source.profileName}`
        : conversationSourceName(source),
      leftSlot: <AgentProviderIcon kind={source.backendKind} className="size-3.5" />,
      detail: count(held.length),
    };
  });
  const folderOptions = [
    ...(narrowing.cwd && !folderCounts.some((folder) => folder.cwd === narrowing.cwd)
      ? [{ cwd: narrowing.cwd, count: 0 }]
      : []),
    ...folderCounts,
  ].map((folder) => ({
    value: folder.cwd,
    label: abbreviateHomeDirectory(folder.cwd, pathContext),
    searchText: folder.cwd,
    detail: count(folder.count),
  }));
  const statusOptions = [
    { value: ALL, label: "All statuses", detail: count(statusRows.length) },
    {
      value: "not_imported",
      label: "Not imported",
      detail: count(statusRows.filter((row) => !row.imported).length),
    },
    {
      value: "imported",
      label: "Imported",
      detail: count(statusRows.filter((row) => row.imported).length),
    },
    ...(selection.size > 0 || filters.status === "selected"
      ? [{ value: "selected", label: "Selected", detail: count(selection.size) }]
      : []),
  ];

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
    return runWithCleanup(
      async () => {
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
        setLookup({ kind: "found", candidates });
        const [only] = candidates;
        if (
          candidates.length === 1 &&
          !nativeConversationImportedCopy(only!, entries.get(only!.key))
        )
          changeSelection((next) => next.set(only!.key, only!));
      },
      {
        onError: (cause) => {
          if (lookupGeneration.current === ownGeneration)
            setLookup({ kind: "failed", message: errorMessage(cause) });
        },
      },
    );
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setSummary(null);
    if (parseCodexThreadImportReference(value)) {
      void lookUp(value);
      return;
    }
    lookupGeneration.current += 1;
    setLookup({ kind: "idle" });
  };

  const narrow = (change: Partial<Omit<NativeConversationFilters, "query">>) => {
    setNarrowing((current) => ({ ...current, ...change }));
    setSummary(null);
  };

  const clearFilters = () => {
    setNarrowing(NO_NATIVE_CONVERSATION_FILTERS);
    changeQuery("");
  };

  const toggleSelectedView = () => {
    setNarrowing({
      ...NO_NATIVE_CONVERSATION_FILTERS,
      status: filters.status === "selected" ? ALL : "selected",
    });
    changeQuery("");
  };

  /**
   * Reads a source to its end. A first read shows rows as they arrive; rereading a listed source
   * keeps its rows until the new read replaces them whole, so refreshing never empties the list.
   * Resuming continues a read that failed partway.
   */
  const readSource = async (
    source: NativeConversationSource,
    generation: number,
    resume: NativeConversationSourceCatalog | null = null,
  ) => {
    const key = nativeConversationSourceKey(source);
    const progressive = resume !== null || !browse.catalogs.has(key);
    const publish = (catalog: NativeConversationSourceCatalog, finished: boolean) =>
      setBrowse((current) => ({
        ...current,
        catalogs: withEntry(current.catalogs, key, catalog),
        loading: finished ? withoutKey(current.loading, key) : current.loading,
      }));
    setBrowse((current) => ({
      ...current,
      loading: new Set(current.loading).add(key),
      errors: withoutEntry(current.errors, key),
    }));
    return runWithCleanup(
      async () => {
        const catalog = await readNativeConversationCatalog({
          source,
          resume,
          list: (cursor) =>
            runtime.list({
              backendKind: source.backendKind,
              ...(source.instanceConfigId ? { instanceConfigId: source.instanceConfigId } : {}),
              ...(cursor ? { cursor } : {}),
            }),
          now: ledger.now,
          isCurrent: () => browseGeneration.current === generation,
          onProgress: (next) => {
            if (progressive) publish(next, false);
          },
        });
        if (catalog) publish(catalog, true);
      },
      {
        onError: (cause) => {
          if (browseGeneration.current !== generation) return;
          const message = errorMessage(cause);
          setBrowse((current) => ({
            ...current,
            loading: withoutKey(current.loading, key),
            errors: withEntry(current.errors, key, { source, message }),
          }));
        },
      },
    );
  };

  const requestSources = () => {
    for (const source of sources) {
      const key = nativeConversationSourceKey(source);
      if (requestedSources.current.has(key)) continue;
      requestedSources.current.add(key);
      void readSource(source, browseGeneration.current);
    }
  };

  const browseAll = () => {
    browseGeneration.current += 1;
    requestedSources.current = new Set();
    requestSources();
  };

  const retrySource = (source: NativeConversationSource) => {
    const catalog = browse.catalogs.get(nativeConversationSourceKey(source));
    void readSource(source, browseGeneration.current, catalog?.nextCursor ? catalog : null);
  };

  // Every visit reads afresh; leaving stops reading, and a read underway is not worth finishing.
  const startBrowse = useEffectEvent(() => browseAll());
  const stopBrowse = useEffectEvent(() => {
    browseGeneration.current += 1;
    requestedSources.current = new Set();
    setBrowse((current) => ({ ...current, loading: new Set() }));
  });
  useEffect(() => {
    if (!open) return;
    startBrowse();
    return () => {
      visit.current += 1;
      stopBrowse();
    };
  }, [open]);

  // Profiles that finish loading after the page opened join the read already underway.
  const requestLateSources = useEffectEvent((_sourceKeys: string) => requestSources());
  const sourceKeys = sources.map(nativeConversationSourceKey).join("\n");
  useEffect(() => {
    if (open) requestLateSources(sourceKeys);
  }, [open, sourceKeys]);

  const chooseFolder = async (row: NativeConversationCandidate) => {
    if (locked) return;
    setChoosingFolder(true);
    return runWithCleanup(
      async () => {
        const picked = await runtime.pickDirectory();
        if (!picked) return;
        setReplacements((current) => withEntry(current, row.cwd, picked));
        setRowStates((current) => withoutEntry(current, row.key));
        setSummary(null);
      },
      {
        onError: (cause) => {
          setRowStates((current) =>
            withEntry(current, row.key, { kind: "failed", message: errorMessage(cause) }),
          );
        },
        cleanup: () => {
          setChoosingFolder(false);
        },
      },
    );
  };

  const openCopy = async (key: string, copy: NativeConversationCopy) => {
    if (!onOpenThread) return;
    setRowStates((current) => withEntry(current, key, { kind: "opening" }));
    return runWithCleanup(
      async () => {
        await onOpenThread(copy.threadId, { runtimeSessionId: copy.sessionId });
        setRowStates((current) => withoutEntry(current, key));
      },
      {
        onError: (cause) => {
          const message = errorMessage(cause);
          setRowStates((current) => withEntry(current, key, { kind: "failed", message }));
        },
      },
    );
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
    for (const entry of targets.entries()) {
      const [index, { row, selection: target }] = entry;
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

  const importLabel = importing
    ? "Importing…"
    : selected.length === 1 && onOpenThread
      ? "Import and open"
      : selected.length > 1
        ? `Import ${count(selected.length)}`
        : "Import";

  const footerStatus = progress
    ? progress.total > 1
      ? `Importing ${count(Math.min(progress.done + 1, progress.total))} of ${count(progress.total)}…`
      : "Importing…"
    : summary
      ? summary.failed > 0
        ? `${count(summary.imported)} imported · ${count(summary.failed)} failed`
        : `Imported ${conversations(summary.imported)}`
      : selected.length > 0
        ? [
            `${count(selected.length)} selected`,
            needingFolder.length > 0
              ? `${count(needingFolder.length)} ${plural(needingFolder.length, "needs a folder", "need a folder")}`
              : null,
            selectedOutOfView > 0 ? `${count(selectedOutOfView)} not shown` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : reference
          ? conversations(visible.length)
          : filtersActive
            ? `${count(visible.length)} of ${conversations(rows.length)}`
            : conversations(rows.length);

  // A list with no rows says why, in place of the rows.
  const listNotice = reference ? (
    lookup.kind === "failed" ? (
      <ConversationImportNotice>
        <span role="alert" className="text-danger">
          {lookup.message}
        </span>
        <NodexButton size="xs" variant="ghost" onClick={() => void lookUp(query)}>
          Try again
        </NodexButton>
      </ConversationImportNotice>
    ) : lookup.kind === "none" ? (
      <ConversationImportNotice>
        <span role="status">No Codex or Claude Code conversation has this ID.</span>
      </ConversationImportNotice>
    ) : lookup.kind === "loading" ? (
      <ConversationImportNotice>
        <span role="status">Looking up conversation…</span>
      </ConversationImportNotice>
    ) : null
  ) : visible.length > 0 ? null : reading ? (
    <ConversationImportNotice>
      <span role="status">Loading…</span>
    </ConversationImportNotice>
  ) : filtersActive ? (
    <ConversationImportNotice>
      <span>No conversations match.</span>
      <NodexButton size="xs" variant="ghost" onClick={clearFilters}>
        Clear filters
      </NodexButton>
    </ConversationImportNotice>
  ) : browse.errors.size === 0 ? (
    <ConversationImportNotice>
      <span>No conversations found.</span>
    </ConversationImportNotice>
  ) : null;

  return (
    <NodexSettingsSection
      title="Import"
      cardClassName="h-[min(44rem,max(22rem,calc(100dvh-13rem)))]"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
        <PageSearchInput
          id={searchId}
          label="Search conversations or paste a link or ID"
          placeholder="Search, or paste a link or ID"
          className="h-7 min-w-56 flex-1"
          searchQuery={query}
          onSearchQueryChange={changeQuery}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (reference && lookup.kind !== "loading") void lookUp(query);
          }}
          trailingControl={
            reading ? (
              <span role="img" aria-label="Reading conversations" className="inline-flex">
                <ActivitySpinnerIcon className="icon-2xs text-token-text-tertiary" />
              </span>
            ) : null
          }
        />
        {sources.length > 1 ? (
          <ConversationImportFilterPicker
            label="Agent"
            allValue={ALL}
            value={narrowing.sourceKey ?? ALL}
            valueLabel={
              sourceOptions.find((option) => option.value === narrowing.sourceKey)?.label ?? null
            }
            options={[
              { value: ALL, label: "All agents", detail: count(sourceRows.length) },
              ...sourceOptions,
            ]}
            onValueChange={(next) => narrow({ sourceKey: next === ALL ? null : next })}
          />
        ) : null}
        <ConversationImportFilterPicker
          label="Folder"
          allValue={ALL}
          search
          value={narrowing.cwd ?? ALL}
          valueLabel={narrowing.cwd ? folderName(narrowing.cwd) : null}
          options={[
            { value: ALL, label: "All folders", detail: count(folderRows.length) },
            ...folderOptions,
          ]}
          onValueChange={(next) => narrow({ cwd: next === ALL ? null : next })}
        />
        <ConversationImportFilterPicker
          label="Status"
          allValue={ALL}
          value={filters.status}
          valueLabel={
            statusOptions.find((option) => option.value === filters.status)?.label ?? null
          }
          options={statusOptions}
          onValueChange={(next) => narrow({ status: next as NativeConversationFilters["status"] })}
        />
        <NodexIconButton
          size="sm"
          icon={RefreshIcon}
          ariaLabel="Refresh conversations"
          disabled={reading || importing}
          onClick={browseAll}
        />
      </div>

      <div className="relative min-h-0 flex-1">
        <ConversationImportRows
          key={JSON.stringify([reference, filters])}
          rows={visible}
          renderRow={(row) => {
            const pending = pendingFor(row.key);
            return (
              <ConversationImportRow
                key={row.key}
                candidate={row}
                query={reference ? "" : deferredQuery}
                pathContext={pathContext}
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
                state={
                  pending?.status === "sending" ? { kind: "importing" } : rowStates.get(row.key)
                }
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
          }}
        >
          {[...browse.errors.values()].map(({ source, message }) => (
            <div
              key={nativeConversationSourceKey(source)}
              className="flex min-w-0 items-center gap-2 px-4 py-1.5 text-xs text-danger"
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
                disabled={importing}
                onClick={() => retrySource(source)}
              >
                Try again
              </NodexButton>
            </div>
          ))}
          {listNotice}
        </ConversationImportRows>
      </div>

      <ConversationImportFooter
        selectAll={{
          checked: visibleSelectable.length > 0 && visibleSelected === visibleSelectable.length,
          indeterminate: visibleSelected > 0 && visibleSelected < visibleSelectable.length,
          disabled: locked || visibleSelectable.length === 0,
          onCheckedChange: () =>
            changeSelection((next) => {
              const clearing = visibleSelected === visibleSelectable.length;
              for (const row of visibleSelectable) {
                if (clearing) next.delete(row.key);
                else next.set(row.key, row);
              }
            }),
        }}
        summary={
          <>
            <div role="status" className="min-w-0 truncate">
              {selected.length > 0 && !progress && !summary ? (
                <button
                  type="button"
                  aria-pressed={filters.status === "selected"}
                  className="max-w-full cursor-interaction truncate rounded-sm hover:text-token-text-primary aria-pressed:text-token-text-primary"
                  onClick={toggleSelectedView}
                >
                  {footerStatus}
                </button>
              ) : (
                footerStatus
              )}
            </div>
            {selected.length > 0 && !locked ? (
              <NodexButton
                size="xs"
                variant="ghost"
                className="shrink-0 text-token-text-secondary"
                onClick={() =>
                  changeSelection((next) => {
                    next.clear();
                  })
                }
              >
                Clear
              </NodexButton>
            ) : null}
          </>
        }
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
    </NodexSettingsSection>
  );
}

/** The last folder name is what a person recognizes; the full path stays one hover away. */
const folderName = (cwd: string) => cwd.split(/[\\/]/u).findLast(Boolean) ?? cwd;

function ConversationImportNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm text-token-text-secondary">
      {children}
    </div>
  );
}
