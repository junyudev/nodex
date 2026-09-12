import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "../../shared/types";
import type { CodexConversationEntityDocument } from "../../shared/codex-conversation-entity-document";
import {
  projectCodexConversationThreadSettings,
  projectCodexConversationTurn,
} from "./CodexConversationSnapshotProjection";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";

const headerKeys = [
  "threadId",
  "forkedFromId",
  "ephemeral",
  "threadSource",
  "agentNickname",
  "threadName",
  "modelProvider",
  "cwd",
  "latestTokenUsageInfo",
  "createdAt",
  "updatedAt",
  "recencyAt",
  "statusType",
  "statusActiveFlags",
  "threadRuntimeStatus",
  "latestCollaborationMode",
  "latestThreadSettings",
  "threadGoal",
  "completedThreadGoal",
  "threadGoalResumeConfirmation",
  "resumeState",
] as const satisfies readonly (keyof CodexConversationSnapshot)[];
type HeaderKey = (typeof headerKeys)[number];
type Header = Pick<CodexConversationSnapshot, HeaderKey>;
type PresentationContext = Omit<
  CodexConversationSnapshot,
  HeaderKey | "canonicalState" | "canonicalRequests" | "hasUnreadTurn" | "turns"
>;
const omitted = new Set<string>([
  ...headerKeys,
  "canonicalState",
  "canonicalRequests",
  "hasUnreadTurn",
  "turns",
]);

const header = (state: CodexCanonicalConversationState): Header => {
  const settings = projectCodexConversationThreadSettings(state);
  const status = parseThreadStatus(state.threadRuntimeStatus);
  return {
    threadId: state.id,
    forkedFromId: state.forkedFromId,
    ephemeral: state.ephemeral,
    threadSource: state.threadSource,
    agentNickname: state.agentNickname,
    threadName: state.title,
    modelProvider: state.modelProvider,
    cwd: state.cwd,
    latestTokenUsageInfo: state.latestTokenUsageInfo ?? null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    recencyAt: state.recencyAt,
    ...status,
    latestCollaborationMode: settings?.collaborationMode ?? state.latestCollaborationMode,
    latestThreadSettings: settings,
    threadGoal: state.threadGoal ?? null,
    completedThreadGoal: state.completedThreadGoal ?? null,
    threadGoalResumeConfirmation: state.threadGoalResumeConfirmation ?? null,
    resumeState: state.resumeState,
  };
};

const turnKey = (turn: CodexCanonicalTurnState, index: number): string =>
  turn.entityKey ?? turn.turnId ?? `local:${index}`;

/** A disposable view cache. Canonical content is read from the Entity document, never stored here. */
export class CodexConversationPresentation {
  private readonly views = new WeakMap<CodexCanonicalTurnState, CodexConversationTurn>();
  private previousTurns = new Map<string, CodexCanonicalTurnState>();
  private previousViews = new Map<string, CodexConversationTurn>();
  private cachedDocument: CodexConversationEntityDocument | null = null;
  private cachedValue: CodexConversationSnapshot | null = null;

  constructor(
    private readonly context: PresentationContext | null = null,
    private readonly unmaterializedHeader: Header | null = null,
  ) {}

  fork(): CodexConversationPresentation {
    const next = new CodexConversationPresentation(this.context, this.unmaterializedHeader);
    next.previousTurns = new Map(this.previousTurns);
    next.previousViews = new Map(this.previousViews);
    next.cachedDocument = this.cachedDocument;
    next.cachedValue = this.cachedValue;
    for (const [key, turn] of next.previousTurns) {
      const view = next.previousViews.get(key);
      if (view) next.views.set(turn, view);
    }
    return next;
  }

  withSnapshot(
    snapshot: CodexConversationSnapshot | null,
    document: CodexConversationEntityDocument,
  ): CodexConversationPresentation {
    if (!snapshot) return new CodexConversationPresentation();
    const context = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => !omitted.has(key)),
    ) as PresentationContext;
    const fallback =
      document.canonicalState === null
        ? (Object.fromEntries(headerKeys.map((key) => [key, snapshot[key]])) as Header)
        : null;
    const next = new CodexConversationPresentation(context, fallback);
    residentConversationTurns(snapshot.canonicalState).forEach((turn, index) => {
      const view = snapshot.turns[index];
      if (!view) return;
      next.views.set(turn, view);
      next.previousTurns.set(turnKey(turn, index), turn);
      next.previousViews.set(turnKey(turn, index), view);
    });
    return next;
  }

  read(document: CodexConversationEntityDocument): CodexConversationSnapshot | null {
    if (!this.context) return null;
    if (document === this.cachedDocument) return this.cachedValue;
    const canonical = document.canonicalState;
    const metadata = canonical ? header(canonical) : this.unmaterializedHeader;
    if (!metadata) return null;
    const nextTurns = new Map<string, CodexCanonicalTurnState>();
    const nextViews = new Map<string, CodexConversationTurn>();
    const turns =
      canonical ? residentConversationTurns(canonical).map((turn, index) => {
        const key = turnKey(turn, index);
        const view =
          this.views.get(turn) ??
          projectCodexConversationTurn({
            threadId: canonical.id,
            turnIndex: index,
            beforeTurn: this.previousTurns.get(key) ?? null,
            afterTurn: turn,
            current: this.previousViews.get(key) ?? null,
            observedAtMs: canonical.updatedAt,
          });
        this.views.set(turn, view);
        nextTurns.set(key, turn);
        nextViews.set(key, view);
        return view;
      }) : [];
    this.previousTurns = nextTurns;
    this.previousViews = nextViews;
    this.cachedDocument = document;
    this.cachedValue = {
      ...this.context,
      ...metadata,
      canonicalState: canonical,
      canonicalRequests: [...document.requests],
      hasUnreadTurn: document.hasUnreadTurn,
      turns,
    };
    return this.cachedValue;
  }
}
