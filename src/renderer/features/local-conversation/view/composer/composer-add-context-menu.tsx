import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
  type SVGProps,
} from "react";
import {
  CircleDotIcon,
  MessageSquare,
  SplitIcon,
  Sparkles,
} from "@/components/shared/icons/generic-icons";
import {
  GoalTargetIcon,
  FileIcon,
  SidePanelBrowserIcon,
  ComposerAddFilesIcon,
  ComposerAppshotIcon,
  ComposerPlanModeIcon,
  ComposerPluginsIcon,
  CheckmarkIcon,
  ConversationIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ProjectMarker } from "@/components/workbench/project-marker";
import {
  useCommandPaletteThreadItems,
  useCommandPaletteThreadSearch,
  useSelectedCommandPaletteChatResults,
} from "@/lib/command-palette-chat-search";
import { filterNewChatProjectSelectorOptions } from "@/lib/new-chat-project-selector";
import type {
  CodexComposerAppshotTarget,
  CodexComposerChatGptConversation,
  CodexComposerPlugin,
  CodexComposerSite,
  CodexComposerSkill,
  ProtocolAppInfo,
  WorkspaceFileSearchMatch,
} from "@/lib/types";
import { COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME } from "../shared/composer-footer-controls";
import type { NewChatProjectSelectorModel } from "../../thread-stage-types";
import { composerContextOperations } from "../../composer-context-operations";
import {
  buildComposerContextSuggestionSections,
  rankComposerContextSuggestionCandidates,
  shouldDismissComposerSuggestionMenu,
  type ComposerContextSuggestionCandidate,
} from "./composer-context-suggestions";
import {
  normalizeComposerAppMentionName,
  type ComposerPromptMentionInput,
} from "./composer-prompt-editor";
import type { ComposerSuggestionState } from "./composer-suggestion-state";
import { ComposerSuggestionRow, ComposerSuggestionSurface } from "./composer-suggestion-surface";

type ComposerContextSelection =
  | {
      readonly kind: "action";
      readonly closeMenu?: boolean;
      readonly run: () => void | Promise<void>;
    }
  | {
      readonly kind: "mention";
      readonly mention: ComposerPromptMentionInput;
    };

interface ComposerContextItemView {
  readonly candidate: ComposerContextSuggestionCandidate<ComposerContextSelection>;
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly plugin?: CodexComposerPlugin;
  readonly pluginName?: string;
  readonly appName?: string;
  readonly scopeLabel?: string;
}

export interface ComposerAddContextMenuHandle {
  submitHighlighted: (action: "complete-query" | "insert-mention") => boolean;
  moveHighlight: (direction: "next" | "previous") => boolean;
}

interface ComposerAddContextMenuProps {
  readonly suggestion: ComposerSuggestionState;
  readonly isHomeMenu?: boolean;
  readonly imagesOnly: boolean;
  readonly plugins: readonly CodexComposerPlugin[];
  readonly pluginsLoading?: boolean;
  readonly skills: readonly CodexComposerSkill[];
  readonly skillsLoading?: boolean;
  readonly apps: readonly ProtocolAppInfo[];
  readonly appsLoading?: boolean;
  readonly sites?: readonly CodexComposerSite[];
  readonly sitesAvailable?: boolean;
  readonly sitesLoading?: boolean;
  readonly chatGptConversations?: readonly CodexComposerChatGptConversation[];
  readonly chatGptConversationsAvailable?: boolean;
  readonly chatGptConversationsLoading?: boolean;
  readonly workspaceRoot: string | null;
  readonly pluginCwds: readonly string[];
  readonly projectId: string | null;
  readonly projectSelector: NewChatProjectSelectorModel | null;
  readonly goalAvailable: boolean;
  readonly planModeAvailable: boolean;
  readonly planModeActive: boolean;
  readonly onClose: () => void;
  readonly onDismiss: () => void;
  readonly onPickFiles: () => Promise<void>;
  readonly onActivateGoal: () => void;
  readonly onTogglePlanMode: () => void;
  readonly onCaptureAppshot: (target: CodexComposerAppshotTarget) => Promise<void>;
  readonly onProjectChange: (projectId: string | null) => void;
  readonly onStartNewChatWithPrompt?: (input: {
    projectId: string | null;
    prompt: string;
  }) => Promise<void>;
  readonly onCapabilitiesChanged?: () => Promise<void>;
  readonly onPrefillPrompt: (prompt: string) => void;
  readonly onInsertMention: (mention: ComposerPromptMentionInput) => void;
}

const EMPTY_COMPOSER_SITES: readonly CodexComposerSite[] = [];
const EMPTY_CHATGPT_CONVERSATIONS: readonly CodexComposerChatGptConversation[] = [];

function isSafeBrandColor(value: string | null): value is string {
  return Boolean(value && /^#[\da-f]{3,8}$/iu.test(value));
}

function normalizeSafeIconUrl(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,/iu.test(normalized)) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "app:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ComposerCapabilityIcon({
  iconUrl,
  iconUrlDark,
  brandColor,
  fallback,
}: {
  readonly iconUrl: string | null;
  readonly iconUrlDark: string | null;
  readonly brandColor: string | null;
  readonly fallback: ReactNode;
}) {
  const safeIconUrl = normalizeSafeIconUrl(iconUrl);
  const safeDarkIconUrl = normalizeSafeIconUrl(iconUrlDark);
  const safeBrandColor = isSafeBrandColor(brandColor) ? brandColor : undefined;

  if (!safeIconUrl) {
    return (
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center text-token-foreground/80"
        style={safeBrandColor ? { color: safeBrandColor } : undefined}
      >
        {fallback}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="relative flex size-4 shrink-0 items-center justify-center overflow-hidden"
    >
      {safeDarkIconUrl && safeDarkIconUrl !== safeIconUrl ? (
        <img
          src={safeDarkIconUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="hidden size-4 object-contain dark:block"
        />
      ) : null}
      <img
        src={safeIconUrl}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className={cn(
          "size-4 object-contain",
          safeDarkIconUrl && safeDarkIconUrl !== safeIconUrl ? "dark:hidden" : null,
        )}
      />
    </span>
  );
}

function useComposerAppshotTarget(enabled: boolean): {
  readonly loading: boolean;
  readonly target: CodexComposerAppshotTarget | null;
} {
  const [state, setState] = useState<{
    readonly loading: boolean;
    readonly target: CodexComposerAppshotTarget | null;
  }>({ loading: enabled, target: null });

  useEffect(() => {
    let current = true;
    if (!enabled) {
      setState({ loading: false, target: null });
      return () => {
        current = false;
      };
    }

    setState((previous) => ({ ...previous, loading: true }));
    void composerContextOperations
      .readAppshotTarget()
      .then((result) => {
        if (!current) return;
        setState({
          loading: false,
          target: result.available ? result.target : null,
        });
      })
      .catch(() => {
        if (!current) return;
        setState({ loading: false, target: null });
      });

    return () => {
      current = false;
    };
  }, [enabled]);

  return state;
}

function ComposerAppshotTargetIcon({ target }: { readonly target: CodexComposerAppshotTarget }) {
  const iconUrl = normalizeSafeIconUrl(target.iconSmallDataUrl);
  if (!iconUrl) {
    return <ComposerAppshotIcon className="size-4 shrink-0" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="size-4 shrink-0 object-contain"
    />
  );
}

function ComposerSitesProjectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M22 19.2727C22 20.779 20.779 22 19.2727 22H14.7273C13.221 22 12 20.779 12 19.2727V12H19.2727C20.779 12 22 13.221 22 14.7273V19.2727Z"
        fill="#68C4FF"
      />
      <path
        d="M20 2C21.1046 2 22 2.89543 22 4V7C22 8.10457 21.1046 9 20 9H17C15.8954 9 15 8.10457 15 7V4C15 2.89543 15.8954 2 17 2H20Z"
        fill="#0C79D8"
      />
      <path
        d="M7 15C8.10457 15 9 15.8954 9 17V20C9 21.1046 8.10457 22 7 22H4C2.89543 22 2 21.1046 2 20V17C2 15.8954 2.89543 15 4 15H7Z"
        fill="#0C79D8"
      />
      <path
        d="M12 12H4.72727C3.22104 12 2 10.779 2 9.27273V4.72727C2 3.22104 3.22104 2 4.72727 2H9.27273C10.779 2 12 3.22104 12 4.72727V12Z"
        fill="#2E9EFF"
      />
    </svg>
  );
}

function getComposerSkillScopeLabel(input: {
  readonly scope: string;
  readonly skillPath: string;
  readonly workspaceRoot: string | null;
}): string {
  const { scope, skillPath, workspaceRoot } = input;
  switch (scope) {
    case "system":
      return "System";
    case "repo":
      if (workspaceRoot && skillPath.startsWith(workspaceRoot.replace(/[\\/]+$/u, ""))) {
        return workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Team";
      }
      return "Team";
    case "user":
      return "Personal";
    case "admin":
      return "Admin installed";
    default:
      return scope;
  }
}

function buildComposerAppItem(app: ProtocolAppInfo): ComposerContextItemView {
  return {
    candidate: {
      id: `app:${app.id}`,
      section: "Apps",
      label: app.name,
      description: app.description,
      searchTerms: [app.id, app.description ?? "", ...app.pluginDisplayNames],
      value: {
        kind: "mention",
        mention: {
          kind: "app",
          name: normalizeComposerAppMentionName(app.name),
          displayName: app.name,
          path: `app://${app.id}`,
          description: app.description,
          iconUrl: app.logoUrl,
          iconUrlDark: app.logoUrlDark,
        },
      },
    },
    icon: (
      <ComposerCapabilityIcon
        iconUrl={app.logoUrl}
        iconUrlDark={app.logoUrlDark}
        brandColor={null}
        fallback={<ComposerPluginsIcon className="size-3.5" />}
      />
    ),
    active: false,
    appName: app.name,
    scopeLabel: "App",
  };
}

function buildComposerSkillItem(
  skill: CodexComposerSkill,
  workspaceRoot: string | null,
): ComposerContextItemView {
  return {
    candidate: {
      id: `skill:${skill.path}`,
      section: "Skills",
      label: skill.displayName,
      description: skill.description,
      searchTerms: [skill.name, skill.path, skill.scope, skill.description],
      value: {
        kind: "mention",
        mention: {
          kind: "skill",
          name: skill.name,
          displayName: skill.displayName,
          path: skill.path,
          description: skill.description,
          iconUrl: skill.iconUrl,
          brandColor: skill.brandColor,
        },
      },
    },
    icon: (
      <ComposerCapabilityIcon
        iconUrl={skill.iconUrl}
        iconUrlDark={null}
        brandColor={skill.brandColor}
        fallback={<Sparkles className="size-3.5" />}
      />
    ),
    active: false,
    scopeLabel: getComposerSkillScopeLabel({
      scope: skill.scope,
      skillPath: skill.path,
      workspaceRoot,
    }),
  };
}

function resolveComposerSiteTitle(site: CodexComposerSite): string {
  return site.title.trim() || site.slug.trim() || site.id;
}

export function formatComposerSiteDetail(currentLiveUrl: string | null, slug: string): string {
  if (!currentLiveUrl) return slug;
  try {
    const url = new URL(currentLiveUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  } catch {
    return slug;
  }
}

function buildComposerSiteItem(site: CodexComposerSite): ComposerContextItemView {
  const title = resolveComposerSiteTitle(site);
  return {
    candidate: {
      id: `site:${site.id}`,
      section: "Sites",
      label: title,
      description: formatComposerSiteDetail(site.currentLiveUrl, site.slug),
      searchTerms: [site.slug],
      value: {
        kind: "mention",
        mention: {
          kind: "site",
          name: title,
          displayName: title,
          path: site.path,
          description: site.slug,
        },
      },
    },
    icon: <ComposerSitesProjectIcon className="size-4 shrink-0" />,
    active: false,
  };
}

function buildComposerChatGptConversationItem(
  conversation: CodexComposerChatGptConversation,
): ComposerContextItemView {
  const title = conversation.title.trim() || "Untitled conversation";
  return {
    candidate: {
      id: `chatgpt-conversation:${conversation.conversationId}`,
      section: "ChatGPT conversations",
      label: title,
      description: "ChatGPT conversation",
      searchTerms: [title],
      sourceRanked: true,
      value: {
        kind: "mention",
        mention: {
          kind: "chatgpt-conversation",
          name: title,
          displayName: title,
          conversationId: conversation.conversationId,
          path: conversation.path,
          description: "ChatGPT conversation",
        },
      },
    },
    icon: <ConversationIcon className="size-4 shrink-0" />,
    active: false,
  };
}

function ComposerContextRow({
  item,
  highlighted,
  showScopeLabel = false,
  onHighlight,
  onSelect,
}: {
  readonly item: ComposerContextItemView;
  readonly highlighted: boolean;
  readonly showScopeLabel?: boolean;
  readonly onHighlight: () => void;
  readonly onSelect: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <ComposerSuggestionRow
      ref={rowRef}
      highlighted={highlighted}
      data-add-context-row={item.candidate.id}
      data-add-context-plugin={item.pluginName}
      data-add-context-app={item.appName}
      onHighlight={onHighlight}
      onClick={onSelect}
    >
      <span className="flex w-full items-center gap-2">
        {item.icon}
        <span
          className={cn(
            "truncate",
            item.candidate.description ? "flex-shrink-0" : "min-w-0 flex-1",
          )}
        >
          {item.candidate.label}
        </span>
        {item.candidate.description ? (
          <span className="min-w-0 flex-1 truncate text-token-description-foreground">
            {item.candidate.description}
          </span>
        ) : null}
        {showScopeLabel && item.scopeLabel ? (
          <span className="ml-auto shrink-0 text-token-description-foreground">
            {item.scopeLabel}
          </span>
        ) : null}
        {item.active ? (
          <CheckmarkIcon
            data-state="checked"
            className="icon-xs ml-auto shrink-0 text-token-text-link-foreground"
          />
        ) : null}
      </span>
    </ComposerSuggestionRow>
  );
}

function useComposerMenuNavigation(input: {
  readonly items: readonly ComposerContextItemView[];
  readonly onSelect: (item: ComposerContextItemView) => void;
  readonly ref: ForwardedRef<ComposerAddContextMenuHandle>;
}) {
  const { items, onSelect, ref } = input;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    setHighlightedId((current) =>
      current && items.some((item) => item.candidate.id === current)
        ? current
        : (items[0]?.candidate.id ?? null),
    );
  }, [items]);

  useImperativeHandle(
    ref,
    () => ({
      submitHighlighted: () => {
        const selected = items.find((item) => item.candidate.id === highlightedId) ?? items[0];
        if (!selected) return false;
        onSelect(selected);
        return true;
      },
      moveHighlight: (direction) => {
        if (items.length === 0) return false;
        const currentIndex = items.findIndex((item) => item.candidate.id === highlightedId);
        const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
        const offset = direction === "next" ? 1 : -1;
        const nextIndex = (normalizedIndex + offset + items.length) % items.length;
        setHighlightedId(items[nextIndex]?.candidate.id ?? null);
        return true;
      },
    }),
    [highlightedId, items, onSelect],
  );

  return {
    highlightedId,
    setHighlightedId,
  };
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/u, "");
  const normalizedRelativePath = relativePath.replace(/^[\\/]+/u, "");
  return `${normalizedRoot}/${normalizedRelativePath}`;
}

function useComposerWorkspaceFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly workspaceRoot: string | null;
}): {
  readonly loading: boolean;
  readonly matches: readonly WorkspaceFileSearchMatch[];
} {
  const [batch, setBatch] = useState<{
    readonly query: string;
    readonly matches: readonly WorkspaceFileSearchMatch[];
    readonly loading: boolean;
  }>({ query: "", matches: [], loading: false });

  useEffect(() => {
    const query = input.query.trim();
    const workspaceRoot = input.workspaceRoot?.trim() ?? "";
    if (!input.enabled || !query || !workspaceRoot) {
      setBatch((current) =>
        current.query === "" && current.matches.length === 0 && !current.loading
          ? current
          : { query: "", matches: [], loading: false },
      );
      return;
    }

    let cancelled = false;
    setBatch({ query, matches: [], loading: true });
    void composerContextOperations
      .searchWorkspaceFiles({
        workspaceRoot,
        query,
        maxResults: 24,
      })
      .then((result) => {
        if (cancelled) return;
        setBatch({ query, matches: result.matches, loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        setBatch({ query, matches: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [input.enabled, input.query, input.workspaceRoot]);

  return batch.query === input.query.trim()
    ? { matches: batch.matches, loading: batch.loading }
    : { matches: [], loading: false };
}

const CHATGPT_CONVERSATION_SEARCH_DEBOUNCE_MS = 100;
const CHATGPT_CONVERSATION_SEARCH_STALE_MS = 60_000;
const chatGptConversationSearchCache = new Map<
  string,
  {
    readonly expiresAt: number;
    readonly conversations: readonly CodexComposerChatGptConversation[];
  }
>();

function useComposerChatGptConversationSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly recentConversations: readonly CodexComposerChatGptConversation[];
  readonly recentLoading: boolean;
}): {
  readonly loading: boolean;
  readonly conversations: readonly CodexComposerChatGptConversation[];
} {
  const normalizedQuery = input.query.trim();
  const [batch, setBatch] = useState<{
    readonly query: string;
    readonly conversations: readonly CodexComposerChatGptConversation[];
    readonly loading: boolean;
  }>({ query: "", conversations: [], loading: false });

  useEffect(() => {
    if (!input.enabled || !normalizedQuery) {
      setBatch((current) =>
        current.query === "" && !current.loading
          ? current
          : { query: "", conversations: [], loading: false },
      );
      return;
    }

    const cached = chatGptConversationSearchCache.get(normalizedQuery);
    if (cached && cached.expiresAt > Date.now()) {
      setBatch({
        query: normalizedQuery,
        conversations: cached.conversations,
        loading: false,
      });
      return;
    }
    if (cached) chatGptConversationSearchCache.delete(normalizedQuery);

    let cancelled = false;
    setBatch({
      query: normalizedQuery,
      conversations: [],
      loading: true,
    });
    const timeout = window.setTimeout(() => {
      void composerContextOperations
        .searchChatGptConversations(normalizedQuery)
        .then((result) => {
          if (cancelled) return;
          const conversations = result.available ? result.conversations : [];
          chatGptConversationSearchCache.set(normalizedQuery, {
            expiresAt: Date.now() + CHATGPT_CONVERSATION_SEARCH_STALE_MS,
            conversations,
          });
          setBatch({
            query: normalizedQuery,
            conversations,
            loading: false,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setBatch({
            query: normalizedQuery,
            conversations: [],
            loading: false,
          });
        });
    }, CHATGPT_CONVERSATION_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [input.enabled, normalizedQuery]);

  if (!normalizedQuery) {
    return {
      conversations: input.recentConversations,
      loading: input.recentLoading,
    };
  }
  if (!input.enabled) return { conversations: [], loading: false };
  if (batch.query !== normalizedQuery) {
    return { conversations: [], loading: true };
  }
  return {
    conversations: batch.conversations,
    loading: batch.loading,
  };
}

export const ComposerAddContextMenu = forwardRef<
  ComposerAddContextMenuHandle,
  ComposerAddContextMenuProps
>(function ComposerAddContextMenu(props, ref) {
  if (!props.suggestion.active) return null;
  if (props.suggestion.kind === "skill-mention") {
    return <ComposerSkillMentionMenuContent {...props} ref={ref} />;
  }
  if (props.suggestion.kind !== "at-mention") return null;
  return <ComposerAddContextMenuContent {...props} ref={ref} />;
});

const ComposerAddContextMenuContent = forwardRef<
  ComposerAddContextMenuHandle,
  ComposerAddContextMenuProps
>(function ComposerAddContextMenuContent(props, ref) {
  const [panel, setPanel] = useState<"root" | "project">("root");

  if (panel === "project" && props.projectSelector) {
    return <ComposerProjectMenuContent {...props} ref={ref} />;
  }

  return (
    <ComposerAddContextRootMenuContent
      {...props}
      ref={ref}
      onOpenProject={() => setPanel("project")}
    />
  );
});

interface ComposerAddContextRootMenuContentProps extends ComposerAddContextMenuProps {
  readonly onOpenProject: () => void;
}

const ComposerAddContextRootMenuContent = forwardRef<
  ComposerAddContextMenuHandle,
  ComposerAddContextRootMenuContentProps
>(function ComposerAddContextRootMenuContent(
  {
    suggestion,
    isHomeMenu = false,
    imagesOnly,
    plugins,
    pluginsLoading = false,
    skills,
    skillsLoading = false,
    apps,
    appsLoading = false,
    sites = EMPTY_COMPOSER_SITES,
    sitesAvailable = false,
    sitesLoading = false,
    chatGptConversations = EMPTY_CHATGPT_CONVERSATIONS,
    chatGptConversationsAvailable = false,
    chatGptConversationsLoading = false,
    workspaceRoot,
    pluginCwds,
    projectId,
    projectSelector,
    goalAvailable,
    planModeAvailable,
    planModeActive,
    onClose,
    onDismiss,
    onPickFiles,
    onActivateGoal,
    onTogglePlanMode,
    onCaptureAppshot,
    onOpenProject,
    onStartNewChatWithPrompt,
    onCapabilitiesChanged,
    onPrefillPrompt,
    onInsertMention,
  },
  ref,
) {
  const open = true;
  const query = suggestion.query;
  const normalizedQuery = query.trim();
  const appshot = useComposerAppshotTarget(open);
  const appshotTarget = appshot.target;
  const fileSearch = useComposerWorkspaceFileSearch({
    enabled: open && normalizedQuery.length > 0,
    query,
    workspaceRoot,
  });
  const chatGptConversationSearch = useComposerChatGptConversationSearch({
    enabled: open && chatGptConversationsAvailable,
    query,
    recentConversations: chatGptConversations,
    recentLoading: chatGptConversationsLoading,
  });
  const threadItems = useCommandPaletteThreadItems({
    enabled: open && normalizedQuery.length > 0,
    activeProjectId: projectId,
    refreshKey: 0,
  });
  const threadSearch = useCommandPaletteThreadSearch({
    enabled: open && normalizedQuery.length > 0,
    query,
    limit: 24,
    minQueryLength: 1,
  });
  const selectedThreads = useSelectedCommandPaletteChatResults({
    query,
    threads: threadItems.threads,
    threadSearchBatch: threadSearch,
    threadLimit: 24,
    preferActiveProject: true,
    activeProjectId: projectId ?? undefined,
  });
  const activatePlugin = useCallback(
    async (plugin: CodexComposerPlugin): Promise<boolean> => {
      if (plugin.installed && plugin.enabled) return true;
      try {
        await composerContextOperations.activatePlugin(plugin.id, pluginCwds);
        await onCapabilitiesChanged?.();
        return true;
      } catch (error) {
        toast.danger("Could not activate plugin", {
          description:
            error instanceof Error ? error.message : `Failed to activate ${plugin.displayName}`,
        });
        return false;
      }
    },
    [onCapabilitiesChanged, pluginCwds],
  );

  const items = useMemo<ComposerContextItemView[]>(() => {
    const recordSkillPlugin = plugins.find((plugin) => plugin.name === "record-and-replay") ?? null;
    const addItems: ComposerContextItemView[] = [
      {
        candidate: {
          id: "picker",
          section: "Add",
          label: imagesOnly ? "Photos" : "Files and folders",
          description: null,
          searchTerms: ["attach", "upload", "photo", "folder"],
          value: { kind: "action", run: onPickFiles },
        },
        icon: <ComposerAddFilesIcon className="size-4 shrink-0" />,
        active: false,
      },
      ...(appshotTarget
        ? [
            {
              candidate: {
                id: "appshot",
                section: "Add" as const,
                label: `Attach ${appshotTarget.appName}`,
                description: null,
                searchTerms: [
                  "attach current app",
                  "appshot",
                  appshotTarget.appName,
                  appshotTarget.bundleIdentifier,
                  appshotTarget.windowTitle ?? "",
                ],
                value: {
                  kind: "action" as const,
                  run: () => onCaptureAppshot(appshotTarget),
                },
              },
              icon: <ComposerAppshotTargetIcon target={appshotTarget} />,
              active: false,
            },
          ]
        : []),
      ...(projectSelector
        ? [
            {
              candidate: {
                id: "project",
                section: "Add" as const,
                label: "Work in a project",
                description: "Choose project for new chats",
                searchTerms: ["project", "workspace"],
                value: {
                  kind: "action" as const,
                  closeMenu: false,
                  run: onOpenProject,
                },
              },
              icon: <SplitIcon className="size-4 shrink-0" />,
              active: false,
            },
          ]
        : []),
      ...(goalAvailable
        ? [
            {
              candidate: {
                id: "goal",
                section: "Add" as const,
                label: "Goal",
                description: "Set a goal to keep pursuing",
                searchTerms: ["objective", "keep pursuing"],
                value: { kind: "action" as const, run: onActivateGoal },
              },
              icon: <GoalTargetIcon className="size-4 shrink-0" />,
              active: false,
            },
          ]
        : []),
      ...(planModeAvailable
        ? [
            {
              candidate: {
                id: "plan-mode",
                section: "Add" as const,
                label: "Plan mode",
                description: planModeActive ? "Turn plan mode off" : "Turn plan mode on",
                searchTerms: ["plan"],
                value: { kind: "action" as const, run: onTogglePlanMode },
              },
              icon: <ComposerPlanModeIcon className="size-4 shrink-0" />,
              active: planModeActive,
            },
          ]
        : []),
      ...(recordSkillPlugin
        ? [
            {
              candidate: {
                id: "record-skill",
                section: "Add" as const,
                label: "Record a skill",
                description: null,
                searchTerms: ["record workflow replay skill"],
                value: {
                  kind: "action" as const,
                  run: async () => {
                    if (!(await activatePlugin(recordSkillPlugin))) return;
                    const promptLink = `[@${recordSkillPlugin.displayName}](${recordSkillPlugin.path})`;
                    const prompt = recordSkillPlugin.defaultPrompt
                      ? `${promptLink} ${recordSkillPlugin.defaultPrompt}`
                      : `${promptLink} `;
                    if (onStartNewChatWithPrompt) {
                      await onStartNewChatWithPrompt({
                        projectId,
                        prompt,
                      });
                      return;
                    }
                    onPrefillPrompt(prompt);
                  },
                },
              },
              icon: <CircleDotIcon className="size-4 shrink-0" />,
              active: false,
            },
          ]
        : []),
    ];

    const pluginItems = plugins
      .filter((plugin) => plugin.name !== "record-and-replay")
      .map((plugin): ComposerContextItemView => ({
        candidate: {
          id: `plugin:${plugin.path}`,
          section: "Plugins",
          label: plugin.displayName,
          description: plugin.description,
          searchTerms: [plugin.name, plugin.id, plugin.path, plugin.description ?? ""],
          value: {
            kind: "mention",
            mention: {
              kind: "plugin",
              name: plugin.name,
              displayName: plugin.displayName,
              path: plugin.path,
              description: plugin.description,
              iconUrl: plugin.iconUrl,
              iconUrlDark: plugin.iconUrlDark,
              brandColor: plugin.brandColor,
            },
          },
        },
        icon: (
          <ComposerCapabilityIcon
            iconUrl={plugin.iconUrl}
            iconUrlDark={plugin.iconUrlDark}
            brandColor={plugin.brandColor}
            fallback={
              plugin.id.startsWith("browser@") ? (
                <SidePanelBrowserIcon className="size-3.5" />
              ) : (
                <ComposerPluginsIcon className="size-3.5" />
              )
            }
          />
        ),
        active: false,
        plugin,
        pluginName: plugin.displayName,
      }));
    const appItems = apps
      .filter((app) => app.isAccessible && app.isEnabled)
      .map(buildComposerAppItem);
    const siteItems = sitesAvailable ? sites.map(buildComposerSiteItem) : [];
    const chatGptConversationItems = chatGptConversationsAvailable
      ? chatGptConversationSearch.conversations.map(buildComposerChatGptConversationItem)
      : [];
    const skillItems = normalizedQuery
      ? skills.map((skill) => buildComposerSkillItem(skill, workspaceRoot))
      : [];
    const threadSuggestions = normalizedQuery
      ? selectedThreads.map((thread): ComposerContextItemView => ({
          candidate: {
            id: `thread:${thread.threadId}`,
            section: "Chats",
            label: thread.title,
            description: thread.preview || thread.projectName || null,
            searchTerms: [
              thread.threadId,
              thread.preview,
              thread.projectName ?? "",
              thread.cwd ?? "",
            ],
            sourceRanked: true,
            value: {
              kind: "mention",
              mention: {
                kind: "agent",
                name: thread.title,
                displayName: thread.title,
                path: `thread://${thread.threadId}`,
                description: thread.preview,
              },
            },
          },
          icon: <MessageSquare className="size-4 shrink-0" />,
          active: false,
        }))
      : [];
    const fileSuggestions = fileSearch.matches.map((file): ComposerContextItemView => ({
      candidate: {
        id: `file:${file.path}`,
        section: "Files and chats",
        label: file.path.split(/[\\/]/u).at(-1) ?? file.path,
        description: file.path,
        searchTerms: [file.path],
        sourceRanked: true,
        value: {
          kind: "mention",
          mention: {
            kind: "file",
            name: file.path.split(/[\\/]/u).at(-1) ?? file.path,
            path: file.path,
            fsPath: workspaceRoot ? joinWorkspacePath(workspaceRoot, file.path) : file.path,
            description: file.path,
          },
        },
      },
      icon: <FileIcon className="size-4 shrink-0" />,
      active: false,
    }));
    return [
      ...addItems,
      ...pluginItems,
      ...appItems,
      ...siteItems,
      ...chatGptConversationItems,
      ...skillItems,
      ...threadSuggestions,
      ...fileSuggestions,
    ];
  }, [
    apps,
    activatePlugin,
    chatGptConversationSearch.conversations,
    chatGptConversationsAvailable,
    fileSearch.matches,
    goalAvailable,
    imagesOnly,
    appshotTarget,
    onActivateGoal,
    onCaptureAppshot,
    onPickFiles,
    onPrefillPrompt,
    onOpenProject,
    onStartNewChatWithPrompt,
    onTogglePlanMode,
    planModeActive,
    planModeAvailable,
    plugins,
    projectId,
    projectSelector,
    normalizedQuery,
    selectedThreads,
    sites,
    sitesAvailable,
    skills,
    workspaceRoot,
  ]);
  const sections = useMemo(
    () =>
      buildComposerContextSuggestionSections({
        candidates: items.map((item) => item.candidate),
        query,
        loadingSectionMessages: {
          ...(sitesLoading ? { Sites: "Loading sites…" } : {}),
          ...(chatGptConversationSearch.loading
            ? {
                "ChatGPT conversations": "Loading ChatGPT conversations…",
              }
            : {}),
        },
      }),
    [chatGptConversationSearch.loading, items, query, sitesLoading],
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.candidate.id, item] as const)),
    [items],
  );
  const visibleItems = useMemo(
    () =>
      sections.flatMap((section) =>
        section.items
          .map((candidate) => itemById.get(candidate.id))
          .filter((item): item is ComposerContextItemView => Boolean(item)),
      ),
    [itemById, sections],
  );
  const selectItem = useCallback(
    (item: ComposerContextItemView): void => {
      const selection = item.candidate.value;
      if (selection.kind === "mention") {
        if (item.plugin) {
          void activatePlugin(item.plugin);
        }
        onInsertMention(selection.mention);
        return;
      }
      if (selection.closeMenu !== false) {
        onClose();
      }
      void selection.run();
    },
    [activatePlugin, onClose, onInsertMention],
  );
  const { highlightedId, setHighlightedId } = useComposerMenuNavigation({
    items: visibleItems,
    onSelect: selectItem,
    ref,
  });
  const searching =
    normalizedQuery.length > 0 &&
    (fileSearch.loading ||
      threadItems.loading ||
      threadSearch.loading ||
      pluginsLoading ||
      skillsLoading ||
      appsLoading ||
      sitesLoading ||
      chatGptConversationSearch.loading ||
      appshot.loading);

  useEffect(() => {
    if (
      !shouldDismissComposerSuggestionMenu({
        loading: searching,
        query,
        resultCount: visibleItems.length,
      })
    )
      return;
    onDismiss();
  }, [onDismiss, query, searching, visibleItems.length]);

  if (!open) return null;

  return (
    <ComposerSuggestionSurface
      kind="add-context"
      isHomeMenu={isHomeMenu}
      ariaLabel={imagesOnly ? "Add photos and more" : "Add files and more"}
    >
      <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
        {sections.map((section, sectionIndex) => (
          <section key={section.id} className="flex flex-col">
            {section.label ? (
              <div
                className={cn(
                  "text-token-description-foreground sticky top-0 z-10 bg-token-dropdown-background/95 px-row-x py-1 text-sm backdrop-blur-sm",
                  sectionIndex > 0 && "pt-2",
                )}
              >
                {section.label}
              </div>
            ) : null}
            {section.items.map((candidate) => {
              const item = itemById.get(candidate.id);
              if (!item) return null;
              return (
                <ComposerContextRow
                  key={candidate.id}
                  item={item}
                  highlighted={candidate.id === highlightedId}
                  showScopeLabel={candidate.section === "Skills"}
                  onHighlight={() => setHighlightedId(candidate.id)}
                  onSelect={() => selectItem(item)}
                />
              );
            })}
            {section.emptyMessage ? (
              <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
                {searching ? "Searching…" : section.emptyMessage}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </ComposerSuggestionSurface>
  );
});

const ComposerProjectMenuContent = forwardRef<
  ComposerAddContextMenuHandle,
  ComposerAddContextMenuProps
>(function ComposerProjectMenuContent(
  { suggestion, isHomeMenu = false, projectSelector, onClose, onProjectChange },
  ref,
) {
  const query = suggestion.query.trim();
  const projects = useMemo(
    () => filterNewChatProjectSelectorOptions(projectSelector?.projects ?? [], query),
    [projectSelector?.projects, query],
  );
  const items = useMemo<ComposerContextItemView[]>(() => {
    if (!projectSelector) return [];
    const noneMatches =
      !query ||
      "none".includes(query.toLocaleLowerCase()) ||
      "don't work in a project".includes(query.toLocaleLowerCase());
    return [
      ...(noneMatches
        ? [
            {
              candidate: {
                id: "project:none",
                section: "Add" as const,
                label: "None",
                description: "Don't work in a project",
                searchTerms: ["projectless"],
                value: {
                  kind: "action" as const,
                  run: () => onProjectChange(null),
                },
              },
              icon: <MessageSquare className="size-4 shrink-0" />,
              active: projectSelector.selectedProjectId === null,
            },
          ]
        : []),
      ...projects.map((project): ComposerContextItemView => ({
        candidate: {
          id: `project:${project.id}`,
          section: "Add",
          label: project.label,
          description: project.primaryWorkspaceRoot ?? project.description,
          searchTerms: [project.id, project.searchText],
          value: {
            kind: "action",
            run: () => onProjectChange(project.id),
          },
        },
        icon: <ProjectMarker appearance={project.appearance} className="size-4" />,
        active: project.id === projectSelector.selectedProjectId,
      })),
    ];
  }, [onProjectChange, projectSelector, projects, query]);
  const selectItem = useCallback(
    (item: ComposerContextItemView): void => {
      const selection = item.candidate.value;
      if (selection.kind !== "action") return;
      onClose();
      void selection.run();
    },
    [onClose],
  );
  const { highlightedId, setHighlightedId } = useComposerMenuNavigation({
    items,
    onSelect: selectItem,
    ref,
  });

  return (
    <ComposerSuggestionSurface
      kind="add-context"
      isHomeMenu={isHomeMenu}
      ariaLabel="Work in a project"
    >
      <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
        {items.map((item) => (
          <ComposerContextRow
            key={item.candidate.id}
            item={item}
            highlighted={item.candidate.id === highlightedId}
            onHighlight={() => setHighlightedId(item.candidate.id)}
            onSelect={() => selectItem(item)}
          />
        ))}
        {items.length === 0 ? (
          <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
            No projects found
          </div>
        ) : null}
      </div>
    </ComposerSuggestionSurface>
  );
});

const ComposerSkillMentionMenuContent = forwardRef<
  ComposerAddContextMenuHandle,
  ComposerAddContextMenuProps
>(function ComposerSkillMentionMenuContent(
  {
    suggestion,
    isHomeMenu = false,
    skills,
    skillsLoading = false,
    apps,
    appsLoading = false,
    workspaceRoot,
    onDismiss,
    onInsertMention,
  },
  ref,
) {
  const items = useMemo<ComposerContextItemView[]>(
    () => [
      ...[...skills]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((skill) => buildComposerSkillItem(skill, workspaceRoot)),
      ...apps.filter((app) => app.isAccessible && app.isEnabled).map(buildComposerAppItem),
    ],
    [apps, skills, workspaceRoot],
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.candidate.id, item] as const)),
    [items],
  );
  const visibleItems = useMemo(
    () =>
      rankComposerContextSuggestionCandidates({
        candidates: items.map((item) => {
          const selection = item.candidate.value;
          const mention = selection.kind === "mention" ? selection.mention : null;
          return {
            ...item.candidate,
            description: null,
            searchTerms: mention
              ? [mention.name, mention.displayName ?? "", mention.path]
              : item.candidate.searchTerms,
          };
        }),
        query: suggestion.query,
        useProviderPriority: false,
        tieBreakByLabel: true,
      })
        .map((candidate) => itemById.get(candidate.id))
        .filter((item): item is ComposerContextItemView => item !== undefined),
    [itemById, items, suggestion.query],
  );
  const selectItem = useCallback(
    (item: ComposerContextItemView) => {
      const selection = item.candidate.value;
      if (selection.kind !== "mention") return;
      onInsertMention(selection.mention);
    },
    [onInsertMention],
  );
  const { highlightedId, setHighlightedId } = useComposerMenuNavigation({
    items: visibleItems,
    onSelect: selectItem,
    ref,
  });
  const loading = visibleItems.length === 0 && (skillsLoading || appsLoading);

  useEffect(() => {
    if (
      !shouldDismissComposerSuggestionMenu({
        loading,
        query: suggestion.query,
        resultCount: visibleItems.length,
      })
    )
      return;
    onDismiss();
  }, [loading, onDismiss, suggestion.query, visibleItems.length]);

  return (
    <ComposerSuggestionSurface
      kind="skill-mention"
      isHomeMenu={isHomeMenu}
      ariaLabel="Skills and apps"
      maxHeightClassName="max-h-[240px]"
      className="electron:text-base"
    >
      <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
        {visibleItems.map((item) => (
          <ComposerContextRow
            key={item.candidate.id}
            item={item}
            highlighted={item.candidate.id === highlightedId}
            showScopeLabel
            onHighlight={() => setHighlightedId(item.candidate.id)}
            onSelect={() => selectItem(item)}
          />
        ))}
        {visibleItems.length === 0 ? (
          <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
            {loading ? "Loading skills and apps…" : "No skills or apps found"}
          </div>
        ) : null}
      </div>
    </ComposerSuggestionSurface>
  );
});

export function ComposerAddContextTrigger({
  open,
  imagesOnly,
  disabled,
  onToggle,
}: {
  readonly open: boolean;
  readonly imagesOnly: boolean;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
}) {
  const label = imagesOnly ? "Add photos and more" : "Add files and more";

  return (
    <NodexTooltip tooltipContent={label}>
      <button
        type="button"
        data-add-context-trigger="true"
        data-state={open ? "open" : "closed"}
        className={COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME}
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onToggle}
      >
        <PlusIcon className="icon-sm" />
      </button>
    </NodexTooltip>
  );
}
