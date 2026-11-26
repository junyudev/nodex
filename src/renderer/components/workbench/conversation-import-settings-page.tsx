import { AutomationImportSection, useAutomationImportCatalog } from "./automation-import-section";
import { listNativeAutomations } from "@/lib/native-automation-import";
import {
  nativeAutomationConversationKey,
  type NativeAutomationCatalogResult,
} from "../../../shared/native-automation-import";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { FolderPlacement } from "../../../shared/folder-placement";
import { readableIpcError } from "@/lib/ipc-error-message";
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
import type { Project, ProjectWindow } from "../../../shared/types";
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
  nativeSessionSource,
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
  previewNativeFolderPlacements,
  readNativeSessionPathContext,
  readNativeSessionProjects,
} from "../../lib/native-session-catalog";
import { AcpNativeConversationsSection } from "@/features/acp-agents/acp-native-conversations-section";
import { ActivitySpinnerIcon, AgentProviderIcon, RefreshIcon } from "../shared/icons";
import { NodexButton, NodexIconButton } from "../ui/button";
import { PageSearchInput } from "../ui/page-search-input";
import { NodexSettingsPageSurface, NodexSettingsSection } from "../ui/settings";
import {
  ConversationImportFilterPicker,
  ConversationImportFooter,
  ConversationImportRow,
  ConversationImportRows,
  conversationSourceLabel,
  type ConversationImportDestinations,
  type ConversationImportRowState,
} from "./conversation-import-list";
import { readAgentProfiles } from "@/lib/agent-profiles-runtime";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { claudeAgent } from "../../../shared/agents/claude";
import type { AgentProfile } from "../../../shared/agents/profiles";
import type {
  SettingsOpenThread,
  SettingsSectionPageProps,
} from "./workbench-settings-page-registry";

/** What a profile contributes here: whether it is on, and its name when several need telling apart. */
interface AgentProfiles {
  readonly instances: readonly Pick<AgentProfile, "id" | "displayName" | "enabled">[];
}

/** Agents whose enabled profiles read a history to import from. */
const PROFILE_AGENTS = [claudeAgent, antigravityAgent] as const;
type ProfileAgent = (typeof PROFILE_AGENTS)[number];
type ProfileDriver = ProfileAgent["driver"];

export interface ConversationImportRuntime {
  readonly listAutomations?: () => Promise<NativeAutomationCatalogResult>;
  readonly profiles: (driver: ProfileDriver) => Promise<AgentProfiles>;
  readonly projects: (after?: string | null) => Promise<ProjectWindow>;
  readonly list: (input: NativeSessionCatalogInput) => Promise<NativeSessionCatalogPage>;
  readonly preview: (
    input: NativeConversationImportPreviewInput,
  ) => Promise<NativeConversationImportPreviewResult>;
  readonly importConversation: (
    input: NativeConversationImportInput,
  ) => Promise<NativeConversationImportOutcome>;
  readonly previewPlacements: (folders: readonly string[]) => Promise<readonly FolderPlacement[]>;
  readonly pickDirectory: () => Promise<string | null>;
  readonly pathContext: () => Promise<LocalPathPresentationContext>;
}

const defaultRuntime: ConversationImportRuntime = {
  profiles: readAgentProfiles,
  listAutomations: listNativeAutomations,
  projects: readNativeSessionProjects,
  list: listNativeSessions,
  preview: previewNativeConversationImport,
  previewPlacements: previewNativeFolderPlacements,
  importConversation: importNativeConversation,
  pickDirectory: pickNativeConversationImportDirectory,
  pathContext: readNativeSessionPathContext,
};

const errorMessage = (cause: unknown) => readableIpcError(cause, String(cause));

type ProjectNames = readonly Pick<Project, "id" | "name">[];

const NO_PROJECTS: ProjectNames = [];

export function ConversationImportSettingsPage({
  open,
  activeProjectId = null,
  projects: settingsProjects = NO_PROJECTS,
  onOpenThread,
  onOpenAutomations,
  runtime = defaultRuntime,
  ledger = nativeConversationImportLedger,
}: Pick<SettingsSectionPageProps, "open" | "onOpenThread" | "onOpenAutomations"> & {
  readonly activeProjectId?: string | null;
  /** The workbench's loaded Projects; names an active Project beyond this page's first window. */
  readonly projects?: ProjectNames;
  readonly runtime?: ConversationImportRuntime;
  readonly ledger?: NativeConversationImportLedger;
}) {
  const intl = useIntl();
  const automations = useAutomationImportCatalog(open, runtime.listAutomations);
  const cronConversationKeys = new Set(automations.catalog?.cronConversationKeys);
  const [profiles, setProfiles] = useState<Partial<Record<ProfileDriver, AgentProfiles>>>({});
  const [profileErrors, setProfileErrors] = useState<Partial<Record<ProfileDriver, string>>>({});
  const [projects, setProjects] = useState<ProjectWindow | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [pathContext, setPathContext] = useState<LocalPathPresentationContext | null>(null);

  // One Project read at a time, so a page of more Projects never races a fresh first page.
  const projectsRead = useRef<Promise<void> | null>(null);
  // Each read stands alone: profiles only add sources, Projects only add destinations.
  const readProfiles = ({ driver }: ProfileAgent, isCurrent: () => boolean = () => true) =>
    runtime.profiles(driver).then(
      (next) => {
        if (!isCurrent()) return;
        setProfiles((current) => ({ ...current, [driver]: next }));
        setProfileErrors((current) => ({ ...current, [driver]: undefined }));
      },
      (cause: unknown) => {
        if (isCurrent())
          setProfileErrors((current) => ({ ...current, [driver]: errorMessage(cause) }));
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
    for (const agent of PROFILE_AGENTS) void readProfiles(agent, isCurrent);
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

  const enabledProfiles = ({ driver }: ProfileAgent) =>
    profiles[driver]?.instances.filter((instance) => instance.enabled) ?? [];
  // Each profile reads its own source; several of one Agent are told apart by name.
  const profileSources = (
    { capabilities }: ProfileAgent,
    reading: AgentProfiles["instances"],
    named: boolean,
  ) =>
    reading.map((profile): NativeConversationSource => ({
      backendKind: capabilities.nativeHistory,
      instanceConfigId: profile.id,
      ...(named ? { profileName: profile.displayName } : {}),
    }));
  const claudeProfiles = enabledProfiles(claudeAgent);
  // Antigravity keeps one history on this computer; the first enabled profile reads and continues it.
  const antigravityProfiles = enabledProfiles(antigravityAgent);
  const sources: readonly NativeConversationSource[] = [
    { backendKind: "codex" },
    ...profileSources(claudeAgent, claudeProfiles, claudeProfiles.length > 1),
    ...profileSources(
      antigravityAgent,
      antigravityProfiles.slice(0, 1),
      antigravityProfiles.length > 1,
    ),
  ];

  const loaded = projects?.items ?? [];
  const projectName = (projectId: string) =>
    (
      loaded.find((project) => project.id === projectId) ??
      settingsProjects.find((project) => project.id === projectId)
    )?.name ?? null;
  const destinations = (selected: string | null): ConversationImportDestinations => ({
    options: [
      {
        projectId: null,
        label: intl.formatMessage(settingsMessages.conversationImportProjectless),
      },
      ...[...new Set([activeProjectId, selected])]
        .filter((id): id is string => !!id && !loaded.some((project) => project.id === id))
        .map((projectId) => ({
          projectId,
          label:
            projectName(projectId) ??
            intl.formatMessage({
              id: "settings.conversationImport.currentProject",
              defaultMessage: "Current Project",
            }),
        })),
      ...loaded.map((project) => ({ projectId: project.id, label: project.name })),
    ],
    hasMore: Boolean(projects?.nextCursor),
    loadingMore: loadingProjects,
    loadMore: readMoreProjects,
  });

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage(settingsMessages.importTitle)}
      subtitle={intl.formatMessage({
        id: "settings.conversationImport.lead",
        defaultMessage:
          "Bring in chats and scheduled tasks from your agents. Each lands in the project for its folder, and the originals stay unchanged.",
      })}
    >
      {PROFILE_AGENTS.map((agent) => {
        const message = profileErrors[agent.driver];
        return message ? (
          <ReadFailure
            key={agent.driver}
            label={intl.formatMessage(
              {
                id: "settings.conversationImport.agentProfiles",
                defaultMessage: "{agent} profiles",
              },
              { agent: agent.label },
            )}
            message={message}
            onRetry={() => void readProfiles(agent)}
          />
        ) : null;
      })}
      {projectsError ? (
        <ReadFailure
          label={intl.formatMessage({
            id: "settings.conversationImport.projects",
            defaultMessage: "Projects",
          })}
          message={projectsError}
          disabled={loadingProjects}
          onRetry={readMoreProjects}
        />
      ) : null}
      <AutomationImportSection
        rows={automations.catalog?.rows ?? []}
        failed={automations.failed}
        refresh={automations.refresh}
        onOpen={onOpenAutomations}
      />
      <ConversationImportSection
        open={open}
        runtime={runtime}
        ledger={ledger}
        sources={sources}
        pathContext={pathContext}
        onOpenThread={onOpenThread}
        cronConversationKeys={cronConversationKeys}
        loadingAutomations={automations.loading}
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
  const intl = useIntl();
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-danger">
      <span role="alert" className="min-w-0 flex-1">
        {label}: {message}
      </span>
      <NodexButton size="sm" variant="ghost" disabled={disabled} onClick={onRetry}>
        {intl.formatMessage({
          id: "settings.conversationImport.tryAgain",
          defaultMessage: "Try again",
        })}
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

function ConversationImportSection({
  open,
  runtime,
  ledger,
  sources,
  pathContext,
  onOpenThread,
  cronConversationKeys,
  loadingAutomations,
}: {
  open: boolean;
  runtime: ConversationImportRuntime;
  ledger: NativeConversationImportLedger;
  sources: readonly NativeConversationSource[];
  pathContext: LocalPathPresentationContext | null;
  onOpenThread?: SettingsOpenThread;
  cronConversationKeys: ReadonlySet<string>;
  loadingAutomations: boolean;
}) {
  const intl = useIntl();
  const count = (value: number) => intl.formatNumber(value);
  const conversations = (value: number) =>
    intl.formatMessage(
      {
        id: "settings.conversationImport.conversationCount",
        defaultMessage: "{count, plural, one {# conversation} other {# conversations}}",
      },
      { count: value },
    );
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
  ])
    .filter(
      (row) =>
        !loadingAutomations &&
        !cronConversationKeys.has(
          nativeAutomationConversationKey(
            row.source.backendKind,
            row.nativeHome,
            row.nativeSessionId,
          ),
        ),
    )
    .map(present);
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
  const cwdFor = (row: NativeConversationCandidate) =>
    nativeConversationImportCwd(row, replacements);
  const folders = [
    ...new Set(
      rows.flatMap((row) => {
        const cwd = !row.imported && !pendingFor(row.key) && cwdFor(row);
        return cwd ? [cwd] : [];
      }),
    ),
  ].sort();
  const placements = useQuery({
    queryKey: ["native-conversation-import", "placement", folders],
    queryFn: async () => {
      const results = await runtime.previewPlacements(folders);
      return new Map(folders.map((cwd, index) => [cwd, results[index]]));
    },
    enabled: open && folders.length > 0,
    placeholderData: keepPreviousData,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const placementFor = (row: NativeConversationCandidate) =>
    placements.data?.get(cwdFor(row) ?? "");
  const newImports = selected.filter((row) => !pendingFor(row.key));
  const needingFolder = newImports.filter(
    (row) => !cwdFor(row) || placementFor(row)?.kind === "missing",
  );
  const awaitingPlacement = newImports.some((row) => cwdFor(row) && !placementFor(row));
  const newProjectCount = new Set(
    newImports.flatMap((row) => {
      const placement = placementFor(row);
      return placement?.kind === "new-project" ? [placement.projectId] : [];
    }),
  ).size;
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
      label: conversationSourceLabel(source),
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
    {
      value: ALL,
      label: intl.formatMessage({
        id: "settings.conversationImport.allStatuses",
        defaultMessage: "All statuses",
      }),
      detail: count(statusRows.length),
    },
    {
      value: "not_imported",
      label: intl.formatMessage(settingsMessages.conversationImportNotImported),
      detail: count(statusRows.filter((row) => !row.imported).length),
    },
    {
      value: "imported",
      label: intl.formatMessage({
        id: "settings.conversationImport.imported",
        defaultMessage: "Imported",
      }),
      detail: count(statusRows.filter((row) => row.imported).length),
    },
    ...(selection.size > 0 || filters.status === "selected"
      ? [
          {
            value: "selected",
            label: intl.formatMessage({
              id: "settings.conversationImport.selected",
              defaultMessage: "Selected",
            }),
            detail: count(selection.size),
          },
        ]
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
              nativeSessionSource(match),
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
            runtime.list({ ...nativeSessionSource(source), ...(cursor ? { cursor } : {}) }),
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
    if (locked || selected.length === 0 || needingFolder.length > 0 || awaitingPlacement) return;
    // An unfinished import keeps its accepted folder, including when a fresh preview changes.
    const targets = selected.map((row) => ({
      row,
      selection: nativeConversationImportSelection(
        row,
        pendingFor(row.key)?.request.cwd ?? cwdFor(row)!,
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
        setRowStates((current) =>
          withEntry(current, row.key, { kind: "failed", message: settlement.message }),
        );
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    setSummary({ imported, failed: targets.length - imported });
    // A Project created by this batch can now own other listed folders.
    if (folders.length > 0) void placements.refetch();
    // One conversation is opened right away, but only for someone still looking at this page.
    if (targets.length === 1 && lastCopy && visit.current === ownVisit)
      await openCopy(lastCopy.key, lastCopy.copy);
  };

  const importLabel = importing
    ? intl.formatMessage({
        id: "settings.conversationImport.importing",
        defaultMessage: "Importing…",
      })
    : selected.length === 1 && onOpenThread
      ? intl.formatMessage(settingsMessages.conversationImportImportAndOpen)
      : selected.length > 1
        ? intl.formatMessage(
            { id: "settings.conversationImport.import", defaultMessage: "Import {value}" },
            { value: count(selected.length) },
          )
        : intl.formatMessage(settingsMessages.conversationImportImport2);

  const footerStatus = progress
    ? progress.total > 1
      ? intl.formatMessage(
          {
            id: "settings.conversationImport.importingOf",
            defaultMessage: "Importing {value} of {total}…",
          },
          {
            value: count(Math.min(progress.done + 1, progress.total)),
            total: count(progress.total),
          },
        )
      : intl.formatMessage({
          id: "settings.conversationImport.importing",
          defaultMessage: "Importing…",
        })
    : summary
      ? summary.failed > 0
        ? intl.formatMessage(
            {
              id: "settings.conversationImport.importedFailed",
              defaultMessage: "{value} imported · {total} failed",
            },
            { value: count(summary.imported), total: count(summary.failed) },
          )
        : intl.formatMessage(
            { id: "settings.conversationImport.imported2", defaultMessage: "Imported {value}" },
            { value: conversations(summary.imported) },
          )
      : selected.length > 0
        ? [
            intl.formatMessage(
              {
                id: "settings.conversationImport.selectedCount",
                defaultMessage: "{count, number} selected",
              },
              { count: selected.length },
            ),
            needingFolder.length > 0
              ? intl.formatMessage(
                  {
                    id: "settings.conversationImport.needsFolderCount",
                    defaultMessage:
                      "{count, plural, one {# needs a folder} other {# need a folder}}",
                  },
                  { count: needingFolder.length },
                )
              : null,
            newProjectCount > 0
              ? intl.formatMessage(
                  {
                    id: "settings.conversationImport.projectsToCreate",
                    defaultMessage:
                      "{count, plural, one {creates # project} other {creates # projects}}",
                  },
                  { count: newProjectCount },
                )
              : null,
            selectedOutOfView > 0
              ? intl.formatMessage(
                  {
                    id: "settings.conversationImport.notShownCount",
                    defaultMessage: "{count, number} not shown",
                  },
                  { count: selectedOutOfView },
                )
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : reference
          ? conversations(visible.length)
          : filtersActive
            ? intl.formatMessage(
                { id: "settings.conversationImport.of", defaultMessage: "{value} of {total}" },
                { value: count(visible.length), total: conversations(rows.length) },
              )
            : conversations(rows.length);

  // A list with no rows says why, in place of the rows.
  const listNotice = reference ? (
    lookup.kind === "failed" ? (
      <ConversationImportNotice>
        <span role="alert" className="text-danger">
          {lookup.message}
        </span>
        <NodexButton size="xs" variant="ghost" onClick={() => void lookUp(query)}>
          {intl.formatMessage({
            id: "settings.conversationImport.tryAgain",
            defaultMessage: "Try again",
          })}
        </NodexButton>
      </ConversationImportNotice>
    ) : lookup.kind === "none" ? (
      <ConversationImportNotice>
        <span role="status">
          {intl.formatMessage({
            id: "settings.conversationImport.noCodexOrClaudeCodeConversation",
            defaultMessage: "No Codex or Claude Code conversation has this ID.",
          })}
        </span>
      </ConversationImportNotice>
    ) : lookup.kind === "loading" ? (
      <ConversationImportNotice>
        <span role="status">
          {intl.formatMessage({
            id: "settings.conversationImport.lookingUpConversation",
            defaultMessage: "Looking up conversation…",
          })}
        </span>
      </ConversationImportNotice>
    ) : null
  ) : visible.length > 0 ? null : reading ? (
    <ConversationImportNotice>
      <span role="status">
        {intl.formatMessage({
          id: "settings.conversationImport.loading",
          defaultMessage: "Loading…",
        })}
      </span>
    </ConversationImportNotice>
  ) : filtersActive ? (
    <ConversationImportNotice>
      <span>
        {intl.formatMessage({
          id: "settings.conversationImport.noConversationsMatch",
          defaultMessage: "No conversations match.",
        })}
      </span>
      <NodexButton size="xs" variant="ghost" onClick={clearFilters}>
        {intl.formatMessage({
          id: "settings.conversationImport.clearFilters",
          defaultMessage: "Clear filters",
        })}
      </NodexButton>
    </ConversationImportNotice>
  ) : browse.errors.size === 0 ? (
    <ConversationImportNotice>
      <span>
        {intl.formatMessage({
          id: "settings.conversationImport.noConversationsFound",
          defaultMessage: "No conversations found.",
        })}
      </span>
    </ConversationImportNotice>
  ) : null;

  return (
    <NodexSettingsSection
      title={intl.formatMessage({
        id: "settings.conversationImport.chats",
        defaultMessage: "Chats",
      })}
      cardClassName="h-[min(44rem,max(22rem,calc(100dvh-13rem)))]"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
        <PageSearchInput
          id={searchId}
          label={intl.formatMessage({
            id: "settings.conversationImport.searchConversationsOrPasteALink",
            defaultMessage: "Search conversations or paste a link or ID",
          })}
          placeholder={intl.formatMessage({
            id: "settings.conversationImport.searchOrPasteALinkOr",
            defaultMessage: "Search, or paste a link or ID",
          })}
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
              <span
                role="img"
                aria-label={intl.formatMessage({
                  id: "settings.conversationImport.readingConversations",
                  defaultMessage: "Reading conversations",
                })}
                className="inline-flex"
              >
                <ActivitySpinnerIcon className="icon-2xs text-token-text-tertiary" />
              </span>
            ) : null
          }
        />
        {sources.length > 1 ? (
          <ConversationImportFilterPicker
            label={intl.formatMessage({
              id: "settings.conversationImport.agent",
              defaultMessage: "Agent",
            })}
            allValue={ALL}
            value={narrowing.sourceKey ?? ALL}
            valueLabel={
              sourceOptions.find((option) => option.value === narrowing.sourceKey)?.label ?? null
            }
            options={[
              {
                value: ALL,
                label: intl.formatMessage({
                  id: "settings.conversationImport.allAgents",
                  defaultMessage: "All agents",
                }),
                detail: count(sourceRows.length),
              },
              ...sourceOptions,
            ]}
            onValueChange={(next) => narrow({ sourceKey: next === ALL ? null : next })}
          />
        ) : null}
        <ConversationImportFilterPicker
          label={intl.formatMessage({
            id: "settings.conversationImport.folder",
            defaultMessage: "Folder",
          })}
          allValue={ALL}
          search
          value={narrowing.cwd ?? ALL}
          valueLabel={narrowing.cwd ? folderName(narrowing.cwd) : null}
          options={[
            {
              value: ALL,
              label: intl.formatMessage({
                id: "settings.conversationImport.allFolders",
                defaultMessage: "All folders",
              }),
              detail: count(folderRows.length),
            },
            ...folderOptions,
          ]}
          onValueChange={(next) => narrow({ cwd: next === ALL ? null : next })}
        />
        <ConversationImportFilterPicker
          label={intl.formatMessage({
            id: "settings.conversationImport.status",
            defaultMessage: "Status",
          })}
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
          ariaLabel={intl.formatMessage({
            id: "settings.conversationImport.refreshConversations",
            defaultMessage: "Refresh conversations",
          })}
          disabled={reading || importing}
          onClick={() => {
            browseAll();
            if (folders.length > 0) void placements.refetch();
          }}
        />
      </div>

      {placements.isError ? (
        <div className="px-4">
          <ReadFailure
            label={intl.formatMessage({
              id: "settings.conversationImport.placements",
              defaultMessage: "Chat placement",
            })}
            message={errorMessage(placements.error)}
            onRetry={() => void placements.refetch()}
          />
        </div>
      ) : null}
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
                cwd={placementFor(row)?.kind === "missing" ? null : cwdFor(row)}
                placement={pending ? null : (placementFor(row) ?? null)}
                pending={
                  pending
                    ? {
                        cwd: pending.request.cwd,
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
                {conversationSourceLabel(source)}: {message}
              </span>
              <NodexButton
                size="xs"
                variant="ghost"
                disabled={importing}
                onClick={() => retrySource(source)}
              >
                {intl.formatMessage({
                  id: "settings.conversationImport.tryAgain",
                  defaultMessage: "Try again",
                })}
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
                {intl.formatMessage({
                  id: "settings.conversationImport.clear",
                  defaultMessage: "Clear",
                })}
              </NodexButton>
            ) : null}
          </>
        }
      >
        <NodexButton
          size="sm"
          variant="primary"
          disabled={
            locked || selected.length === 0 || needingFolder.length > 0 || awaitingPlacement
          }
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
