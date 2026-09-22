import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type {
  CodexApprovalRequest,
  CodexConversationLiveRequest,
  CodexConversationItem,
  CodexConversationServerRequest,
  CodexCanonicalServerRequest,
  CodexConversationTurn,
  CodexMcpServerElicitationRequest,
  CodexPermissionRequest,
  CodexPlanImplementationServerRequest,
  CodexPlanImplementationRequest,
  CodexUserInputRequest,
  NodexAgentAuthorizationRequest,
} from "./types";
import {
  buildCodexCanonicalPendingRequestBuckets,
  selectCanonicalInteractiveRequestForTurn,
} from "./codex-canonical-pending-request";
import { hasCodexFileChangeEntries } from "./codex-file-change";

export type CodexTurnScopedConversationRequest = Exclude<
  CodexConversationLiveRequest,
  { type: "mcpServerElicitation" }
>;

const EMPTY_LIVE_REQUESTS: CodexConversationLiveRequest[] = [];
const EMPTY_TURN_REQUESTS: CodexTurnScopedConversationRequest[] = [];
const EMPTY_TURN_REQUESTS_BY_TURN_ID = new Map<string, CodexTurnScopedConversationRequest[]>();

interface LatestPlanImplementationSelection {
  item: CodexConversationItem;
  turnId: string;
}

type BackgroundConversationRequest =
  | CodexApprovalRequest
  | CodexPermissionRequest
  | CodexMcpServerElicitationRequest
  | NodexAgentAuthorizationRequest;

interface DerivedConversationRequestSelection {
  planSelection: LatestPlanImplementationSelection | null;
  liveRequests: CodexConversationLiveRequest[];
  primaryRequest: CodexConversationLiveRequest | null;
  primaryBackgroundRequest: BackgroundConversationRequest | null;
  requestsByTurnId: Map<string, CodexTurnScopedConversationRequest[]>;
}

interface DerivedConversationRequestCacheEntry extends DerivedConversationRequestSelection {
  projectId: CodexConversationRequestContext["projectId"];
  threadId: CodexConversationRequestContext["threadId"];
  turnsRef: readonly CodexConversationTurn[];
  canonicalRequestsRef: readonly CodexCanonicalServerRequest[] | undefined;
  latestPlanItemRef: CodexConversationItem | null;
  latestPlanTurnId: string | null;
}

const derivedRequestSelectionsByServerRequestRef = new WeakMap<
  readonly CodexConversationServerRequest[],
  DerivedConversationRequestCacheEntry
>();

export function buildPlanImplementationRequestId(turnId: string): string {
  return `implement-plan:${turnId}`;
}

function isLivePlanImplementationItem(item: CodexConversationItem): boolean {
  return (
    item.semanticKind === "planImplementation" &&
    item.status !== "completed" &&
    (item.markdownText ?? "").trim().length > 0
  );
}

function selectLatestPlanImplementationItem(
  conversation: CodexConversationRequestContext,
): LatestPlanImplementationSelection | null {
  for (let turnIndex = conversation.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = conversation.turns[turnIndex];
    if (!turn || turn.turnId === null) continue;

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (!item || !isLivePlanImplementationItem(item)) {
        continue;
      }

      return {
        item,
        turnId: turn.turnId,
      };
    }
  }

  return null;
}

function findMatchingPlanImplementationRequest(
  conversation: CodexConversationRequestContext,
  turnId: string,
  itemId: string,
): CodexPlanImplementationServerRequest | null {
  return (
    conversation.requests.find(
      (request): request is CodexPlanImplementationServerRequest =>
        request.type === "implementPlan" && request.turnId === turnId && request.itemId === itemId,
    ) ?? null
  );
}

interface ProjectedPendingRequestBucket {
  approvalRequests: CodexApprovalRequest[];
  latestUserInputRequest: CodexUserInputRequest | null;
  latestMcpElicitationRequest: CodexMcpServerElicitationRequest | null;
  latestPermissionRequest: CodexPermissionRequest | null;
  latestNodexAgentAuthorization: NodexAgentAuthorizationRequest | null;
}

interface ProjectedPendingRequestBuckets {
  byTurnId: Map<string, ProjectedPendingRequestBucket>;
  latestTurnlessMcpElicitation: CodexMcpServerElicitationRequest | null;
}

function getOrCreateProjectedPendingRequestBucket(
  buckets: Map<string, ProjectedPendingRequestBucket>,
  turnId: string,
): ProjectedPendingRequestBucket {
  const existing = buckets.get(turnId);
  if (existing) return existing;
  const bucket: ProjectedPendingRequestBucket = {
    approvalRequests: [],
    latestUserInputRequest: null,
    latestMcpElicitationRequest: null,
    latestPermissionRequest: null,
    latestNodexAgentAuthorization: null,
  };
  buckets.set(turnId, bucket);
  return bucket;
}

function buildProjectedPendingRequestBuckets(
  requests: readonly CodexConversationServerRequest[],
): ProjectedPendingRequestBuckets {
  const byTurnId = new Map<string, ProjectedPendingRequestBucket>();
  let latestTurnlessMcpElicitation: CodexMcpServerElicitationRequest | null = null;

  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (!request || request.type === "implementPlan") continue;
    if (request.type === "mcpServerElicitation" && request.turnId.trim().length === 0) {
      latestTurnlessMcpElicitation ??= request;
      continue;
    }

    const bucket = getOrCreateProjectedPendingRequestBucket(byTurnId, request.turnId);
    switch (request.type) {
      case "approval":
        bucket.approvalRequests.push(request);
        break;
      case "userInput":
        bucket.latestUserInputRequest ??= request;
        break;
      case "mcpServerElicitation":
        bucket.latestMcpElicitationRequest ??= request;
        break;
      case "permissionRequest":
        bucket.latestPermissionRequest ??= request;
        break;
      case "nodexAgentAuthorization":
        bucket.latestNodexAgentAuthorization ??= request;
        break;
    }
  }

  return { byTurnId, latestTurnlessMcpElicitation };
}

function isValidApprovalForTurn(
  request: CodexApprovalRequest,
  turn: CodexConversationTurn,
): boolean {
  if (request.kind === "command") return true;
  const item = [...turn.items].reverse().find((candidate) => candidate.itemId === request.itemId);
  if (!item?.fileChange) return false;
  return (
    hasCodexFileChangeEntries(item.fileChange.changes) ||
    (item.fileChange.visualizationActivities?.length ?? 0) > 0
  );
}

function selectApprovalOrPermissionForTurn(
  turn: CodexConversationTurn,
  bucket: ProjectedPendingRequestBucket | undefined,
): CodexApprovalRequest | CodexPermissionRequest | NodexAgentAuthorizationRequest | null {
  if (!bucket) return null;
  return (
    bucket.approvalRequests.find((request) => isValidApprovalForTurn(request, turn)) ??
    bucket.latestNodexAgentAuthorization ??
    bucket.latestPermissionRequest
  );
}

function selectSyntheticUserInputForTurn(
  conversation: CodexConversationRequestContext,
  turn: CodexConversationTurn,
): CodexUserInputRequest | null {
  if (turn.turnId === null) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (!item || (item.kind !== "userInputResponse" && item.semanticKind !== "userInputResponse")) {
      continue;
    }
    const rawCompleted =
      typeof item.rawItem === "object" &&
      item.rawItem !== null &&
      "completed" in item.rawItem &&
      item.rawItem.completed === true;
    if (item.status === "completed" || rawCompleted) continue;
    if (item.requestId === undefined || !item.userInputQuestions) continue;
    return {
      type: "userInput",
      requestId: item.requestId,
      projectId: conversation.projectId,
      threadId: conversation.threadId,
      turnId: turn.turnId,
      itemId: item.itemId,
      questions: item.userInputQuestions.map((question) => ({
        ...question,
        isOther: false,
      })),
      isBlocking: true,
      createdAt: item.createdAt,
    };
  }
  return null;
}

function freezeTurnRequestMap(
  requests: CodexConversationLiveRequest[],
): Map<string, CodexTurnScopedConversationRequest[]> {
  if (requests.length === 0) {
    return EMPTY_TURN_REQUESTS_BY_TURN_ID;
  }

  const requestsByTurnId = new Map<string, CodexTurnScopedConversationRequest[]>();
  for (const request of requests) {
    if (request.type === "mcpServerElicitation") {
      continue;
    }

    const current = requestsByTurnId.get(request.turnId);
    if (!current) {
      requestsByTurnId.set(request.turnId, [request]);
      continue;
    }

    current.push(request);
  }

  for (const [turnId, turnRequests] of requestsByTurnId.entries()) {
    requestsByTurnId.set(turnId, turnRequests.length === 0 ? EMPTY_TURN_REQUESTS : turnRequests);
  }

  return requestsByTurnId;
}

function deriveConversationRequestSelection(
  conversation: CodexConversationRequestContext,
): DerivedConversationRequestSelection {
  const latestPlanSelection = selectLatestPlanImplementationItem(conversation);
  const planRequest = latestPlanSelection
    ? buildPlanImplementationRequest(conversation, latestPlanSelection)
    : null;

  const projectedPendingBuckets = buildProjectedPendingRequestBuckets(conversation.requests);
  const canonicalPendingBuckets = buildCodexCanonicalPendingRequestBuckets(conversation);

  const liveRequests: CodexConversationLiveRequest[] = [];
  let primaryBackgroundRequest: BackgroundConversationRequest | null = null;
  for (let turnIndex = conversation.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = conversation.turns[turnIndex];
    if (!turn || turn.turnId === null) continue;

    const projectedBucket = projectedPendingBuckets.byTurnId.get(turn.turnId);
    const userInput = projectedBucket?.latestUserInputRequest ?? null;
    const canonicalInteractiveRequest = selectCanonicalInteractiveRequestForTurn(
      canonicalPendingBuckets.get(turn.turnId),
    );
    if (canonicalInteractiveRequest) {
      liveRequests.push(canonicalInteractiveRequest);
    } else if (userInput) {
      liveRequests.push(userInput);
    } else {
      const syntheticUserInput = selectSyntheticUserInputForTurn(conversation, turn);
      if (syntheticUserInput) liveRequests.push(syntheticUserInput);
    }

    const approvalOrPermission = selectApprovalOrPermissionForTurn(turn, projectedBucket);
    if (approvalOrPermission) {
      primaryBackgroundRequest ??= approvalOrPermission;
      liveRequests.push(approvalOrPermission);
    }

    const mcpElicitation = projectedBucket?.latestMcpElicitationRequest;
    if (mcpElicitation) {
      primaryBackgroundRequest ??= mcpElicitation;
      liveRequests.push(mcpElicitation);
    }

    if (planRequest && planRequest.turnId === turn.turnId) {
      liveRequests.push(planRequest);
    }
  }
  const turnlessMcpElicitation = projectedPendingBuckets.latestTurnlessMcpElicitation;
  if (turnlessMcpElicitation) {
    primaryBackgroundRequest ??= turnlessMcpElicitation;
    liveRequests.push(turnlessMcpElicitation);
  }

  return {
    planSelection: latestPlanSelection,
    liveRequests: liveRequests.length === 0 ? EMPTY_LIVE_REQUESTS : liveRequests,
    primaryRequest: liveRequests[0] ?? null,
    primaryBackgroundRequest,
    requestsByTurnId: freezeTurnRequestMap(liveRequests),
  };
}

function resolveDerivedConversationRequestSelection(
  conversation: CodexConversationRequestContext,
): DerivedConversationRequestSelection {
  const latestPlanSelection = selectLatestPlanImplementationItem(conversation);
  const latestPlanItemRef = latestPlanSelection?.item ?? null;
  const latestPlanTurnId = latestPlanSelection?.turnId ?? null;
  const cached = derivedRequestSelectionsByServerRequestRef.get(conversation.requests);
  if (
    cached?.turnsRef === conversation.turns &&
    cached.projectId === conversation.projectId &&
    cached.threadId === conversation.threadId &&
    cached.canonicalRequestsRef === conversation.canonicalRequests &&
    cached.latestPlanItemRef === latestPlanItemRef &&
    cached.latestPlanTurnId === latestPlanTurnId
  ) {
    return cached;
  }

  const derived = deriveConversationRequestSelection(conversation);
  const entry: DerivedConversationRequestCacheEntry = {
    ...derived,
    projectId: conversation.projectId,
    threadId: conversation.threadId,
    turnsRef: conversation.turns,
    canonicalRequestsRef: conversation.canonicalRequests,
    latestPlanItemRef,
    latestPlanTurnId,
  };
  derivedRequestSelectionsByServerRequestRef.set(conversation.requests, entry);
  return entry;
}

export function areConversationLiveRequestsEqual(
  left: CodexConversationLiveRequest | null,
  right: CodexConversationLiveRequest | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.type !== right.type) {
    return false;
  }

  if (
    left.requestId !== right.requestId ||
    left.threadId !== right.threadId ||
    left.turnId !== right.turnId ||
    left.itemId !== right.itemId ||
    left.createdAt !== right.createdAt
  ) {
    return false;
  }

  switch (left.type) {
    case "approval":
      return (
        right.type === "approval" &&
        left.kind === right.kind &&
        left.command === right.command &&
        left.reason === right.reason &&
        left.cwd === right.cwd
      );
    case "userInput":
      if (right.type !== "userInput") return false;
      return (
        left.questions === right.questions &&
        left.isBlocking === right.isBlocking &&
        left.isOnboardingDynamicInput === right.isOnboardingDynamicInput &&
        left.autoResolutionMs === right.autoResolutionMs
      );
    case "optionPicker":
      return (
        right.type === "optionPicker" &&
        left.question === right.question &&
        left.options === right.options &&
        left.allowMultiple === right.allowMultiple &&
        left.submitLabel === right.submitLabel &&
        left.skipLabel === right.skipLabel
      );
    case "setupCodexStep":
      return right.type === "setupCodexStep" && left.step === right.step;
    case "mcpServerElicitation":
      return (
        right.type === "mcpServerElicitation" &&
        left.kind === right.kind &&
        left.mode === right.mode &&
        left.serverName === right.serverName &&
        left.message === right.message
      );
    case "permissionRequest":
      return (
        right.type === "permissionRequest" &&
        left.reason === right.reason &&
        left.completed === right.completed &&
        left.permissions === right.permissions &&
        left.response === right.response
      );
    case "nodexAgentAuthorization":
      return (
        right.type === "nodexAgentAuthorization" &&
        left.tool === right.tool &&
        left.effect === right.effect &&
        left.preview === right.preview
      );
    case "implementPlan":
      if (right.type !== "implementPlan") return false;
      return left.planContent === right.planContent;
  }
}

export function selectPlanImplementationRequest(
  conversation: CodexConversationRequestContext | null,
): CodexPlanImplementationRequest | null {
  if (!conversation) return null;

  const selected = resolveDerivedConversationRequestSelection(conversation).planSelection;
  if (!selected) return null;

  return buildPlanImplementationRequest(conversation, selected);
}

function buildPlanImplementationRequest(
  conversation: CodexConversationRequestContext,
  selected: LatestPlanImplementationSelection,
): CodexPlanImplementationRequest {
  const request = findMatchingPlanImplementationRequest(
    conversation,
    selected.turnId,
    selected.item.itemId,
  );
  const createdAt = request?.createdAt ?? selected.item.createdAt;

  return {
    type: "implementPlan",
    requestId: request?.requestId ?? buildPlanImplementationRequestId(selected.turnId),
    projectId: request?.projectId ?? conversation.projectId,
    threadId: conversation.threadId,
    turnId: selected.turnId,
    itemId: selected.item.itemId,
    planContent: (selected.item.markdownText ?? "").trim(),
    createdAt,
  };
}

export function selectConversationLiveRequests(
  conversation: CodexConversationRequestContext | null,
): CodexConversationLiveRequest[] {
  if (!conversation) return EMPTY_LIVE_REQUESTS;
  return resolveDerivedConversationRequestSelection(conversation).liveRequests;
}

export function selectPrimaryConversationRequest(
  conversation: CodexConversationRequestContext | null,
): CodexConversationLiveRequest | null {
  if (!conversation) return null;
  return resolveDerivedConversationRequestSelection(conversation).primaryRequest;
}

export function selectPrimaryBackgroundConversationRequest(
  conversation: CodexConversationRequestContext | null,
): BackgroundConversationRequest | null {
  if (!conversation) return null;
  return resolveDerivedConversationRequestSelection(conversation).primaryBackgroundRequest;
}

export function selectConversationTurnRequestsByTurnId(
  conversation: CodexConversationRequestContext | null,
): Map<string, CodexTurnScopedConversationRequest[]> {
  if (!conversation) return EMPTY_TURN_REQUESTS_BY_TURN_ID;
  return resolveDerivedConversationRequestSelection(conversation).requestsByTurnId;
}

export function selectTurnScopedConversationRequests(
  requestsByTurnId: ReadonlyMap<string, CodexTurnScopedConversationRequest[]>,
  turnId: string,
): CodexTurnScopedConversationRequest[] {
  return requestsByTurnId.get(turnId) ?? EMPTY_TURN_REQUESTS;
}

export function isBlockingConversationRequest(request: CodexConversationLiveRequest): boolean {
  return (
    request.type === "approval" ||
    (request.type === "userInput" && request.isBlocking) ||
    request.type === "optionPicker" ||
    request.type === "setupCodexStep" ||
    request.type === "mcpServerElicitation" ||
    request.type === "permissionRequest" ||
    request.type === "nodexAgentAuthorization"
  );
}
