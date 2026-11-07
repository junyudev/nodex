import type { ListMcpServerStatusResponse } from "@nodex/codex-app-server-protocol/v2/ListMcpServerStatusResponse";
import type { CodexConversationReplayFixture } from "../codex-conversation-replay";
import type { CodexCanonicalServerRequest } from "../codex-conversation-state";

export const AGENT_ACTIVITY_V2_FIXTURE_SCHEMA_VERSION = 1 as const;

export type AgentActivityV2RawSourceReference =
  | {
    readonly kind: "thread-item";
    readonly id: string;
  }
  | {
    readonly kind: "server-request";
    readonly id: string | number;
    readonly usage: "pending-request-projection" | "state-synthetic-cause";
  }
  | {
    readonly kind: "turn-context";
    readonly turnId: string;
  };

export interface AgentActivityV2ProjectionContext {
  readonly turnId: string;
  readonly isBackgroundSubagentsEnabled: boolean;
  readonly preserveServerUserMessages: boolean;
  readonly mcpServerStatuses: ListMcpServerStatusResponse | null;
}

export interface AgentActivityV2ProjectedItemExpectation {
  readonly projectedItemIndex: number;
  /** Exact projected leaf discriminator, intentionally not a predeclared classifier union. */
  readonly itemType: string;
  readonly sourceReferences: readonly [
    AgentActivityV2RawSourceReference,
    ...AgentActivityV2RawSourceReference[],
  ];
}

export type AgentActivityV2Classification =
  | "filtered"
  | "hidden"
  | "groupable"
  | "standalone";

export type AgentActivityV2IdentityField =
  | "id"
  | "callId"
  | "requestId"
  | "handoffId"
  | "fallback";

export interface AgentActivityV2IdentityExpectation {
  readonly field: AgentActivityV2IdentityField;
  readonly value: string;
}

export interface AgentActivityV2IdentityCandidatesExpectation {
  readonly id?: string | number | null;
  readonly callId?: string | number | null;
  readonly requestId?: string | number | null;
  readonly handoffId?: string | number | null;
}

export type AgentActivityV2SourceOriginExpectation =
  | {
    readonly kind: "projected";
    /** First projected item is the carrier; later indexes record attached source items. */
    readonly projectedItemIndexes: readonly [number, ...number[]];
  }
  | {
    readonly kind: "derived";
    readonly sourceReferences: readonly [
      AgentActivityV2RawSourceReference,
      ...AgentActivityV2RawSourceReference[],
    ];
  };

export interface AgentActivityV2SourceItemExpectation {
  /** Index in the exact activity-source array passed to the v2 classifier. */
  readonly activitySourceIndex: number;
  readonly origin: AgentActivityV2SourceOriginExpectation;
  readonly itemType: string;
  readonly classification: AgentActivityV2Classification;
  readonly identityCandidates: AgentActivityV2IdentityCandidatesExpectation;
  /** Null for rows removed before grouping; visible rows record `hm`'s selected identity. */
  readonly identity: AgentActivityV2IdentityExpectation | null;
}

export type AgentActivityV2UnitExpectation =
  | {
    readonly kind: "group";
    readonly key: string;
    /** Fixture-only membership references; production group items do not retain indexes. */
    readonly activitySourceIndexes: readonly [number, ...number[]];
  }
  | {
    readonly kind: "standalone";
    readonly key: string;
    /** Fixture-only membership reference; the production unit contains only its activity item. */
    readonly activitySourceIndex: number;
  };

export interface AgentActivityV2ProjectionExpectation {
  readonly projectedItems: readonly AgentActivityV2ProjectedItemExpectation[];
  readonly activitySourceItems: readonly AgentActivityV2SourceItemExpectation[];
  readonly units: readonly AgentActivityV2UnitExpectation[];
}

export interface AgentActivityV2ProjectionFixture {
  readonly schemaVersion: typeof AGENT_ACTIVITY_V2_FIXTURE_SCHEMA_VERSION;
  readonly replay: CodexConversationReplayFixture;
  readonly projectionContext: AgentActivityV2ProjectionContext;
  readonly expected: AgentActivityV2ProjectionExpectation;
}

interface ReplaySourceIds {
  readonly threadItemIds: ReadonlySet<string>;
  readonly pendingServerRequestIds: ReadonlySet<string>;
  readonly stateSyntheticCauseRequestIds: ReadonlySet<string>;
}

function requestIdKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isPendingProjectionRequest(
  request: CodexCanonicalServerRequest,
  threadId: string,
  turnId: string,
): boolean {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/tool/requestUserInput":
    case "item/permissions/requestApproval":
      return request.params.threadId === threadId && request.params.turnId === turnId;
    case "mcpServer/elicitation/request":
    case "item/tool/call":
    case "item/tool/requestOptionPicker":
    case "item/plan/requestImplementation":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "currentTime/read":
    case "applyPatchApproval":
    case "execCommandApproval":
      return false;
  }
}

function isStateSyntheticCauseRequest(
  request: CodexCanonicalServerRequest,
  threadId: string,
  turnId: string,
): boolean {
  switch (request.method) {
    case "item/tool/requestUserInput":
    case "item/permissions/requestApproval":
      return request.params.threadId === threadId && request.params.turnId === turnId;
    case "mcpServer/elicitation/request":
      return request.params.threadId === threadId && request.params.turnId === turnId;
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/tool/call":
    case "item/tool/requestOptionPicker":
    case "item/plan/requestImplementation":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "currentTime/read":
    case "applyPatchApproval":
    case "execCommandApproval":
      return false;
  }
}

function collectReplaySourceIds(
  fixture: AgentActivityV2ProjectionFixture,
): ReplaySourceIds {
  const threadItemIds = new Set<string>();
  const pendingServerRequestIds = new Set<string>();
  const stateSyntheticCauseRequestIds = new Set<string>();
  const { turnId } = fixture.projectionContext;
  const turn = fixture.replay.initialThread?.turns.find((candidate) => candidate.id === turnId);

  for (const item of turn?.items ?? []) {
    threadItemIds.add(item.id);
  }

  for (const event of fixture.replay.events) {
    if (event.type === "request") {
      const key = requestIdKey(event.request.id);
      if (isPendingProjectionRequest(event.request, fixture.replay.threadId, turnId)) {
        pendingServerRequestIds.add(key);
      }
      if (isStateSyntheticCauseRequest(event.request, fixture.replay.threadId, turnId)) {
        stateSyntheticCauseRequestIds.add(key);
      }
      continue;
    }

    const { notification } = event;
    if (
      notification.method === "serverRequest/resolved"
      && notification.params.threadId === fixture.replay.threadId
    ) {
      pendingServerRequestIds.delete(requestIdKey(notification.params.requestId));
      continue;
    }

    if (
      (notification.method === "item/started" || notification.method === "item/completed")
      && notification.params.threadId === fixture.replay.threadId
      && notification.params.turnId === turnId
    ) {
      threadItemIds.add(notification.params.item.id);
    }
  }

  return {
    threadItemIds,
    pendingServerRequestIds,
    stateSyntheticCauseRequestIds,
  };
}

function validateDenseIndexes<T>(
  rows: readonly T[],
  getIndex: (row: T) => number,
  label: string,
  errors: string[],
): void {
  rows.forEach((row, position) => {
    const index = getIndex(row);
    if (Number.isInteger(index) && index === position) {
      return;
    }

    errors.push(`${label} must be dense and ordered: expected ${position}, received ${index}`);
  });
}

function validateIndexReferences(
  indexes: readonly number[],
  upperBound: number,
  label: string,
  errors: string[],
): void {
  if (indexes.length === 0) {
    errors.push(`${label} must contain at least one index`);
    return;
  }

  let previous = -1;
  indexes.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= upperBound) {
      errors.push(`${label} contains out-of-range index ${index}`);
      return;
    }

    if (index <= previous) {
      errors.push(`${label} must contain unique indexes in source order`);
      return;
    }

    previous = index;
  });
}

function validateRawSourceReferences(
  fixture: AgentActivityV2ProjectionFixture,
  references: readonly AgentActivityV2RawSourceReference[],
  label: string,
  sourceIds: ReplaySourceIds,
  errors: string[],
): void {
  for (const reference of references) {
    if (reference.kind === "thread-item") {
      if (!sourceIds.threadItemIds.has(reference.id)) {
        errors.push(`${label} references unknown thread item ${reference.id}`);
      }
      continue;
    }

    if (reference.kind === "server-request") {
      const availableIds = reference.usage === "pending-request-projection"
        ? sourceIds.pendingServerRequestIds
        : sourceIds.stateSyntheticCauseRequestIds;
      if (!availableIds.has(requestIdKey(reference.id))) {
        errors.push(
          `${label} references unavailable ${reference.usage} server request ${String(reference.id)}`,
        );
      }
      continue;
    }

    if (reference.turnId !== fixture.projectionContext.turnId) {
      errors.push(`${label} references foreign turn context ${reference.turnId}`);
    }
  }
}

function validateProjectionSources(
  fixture: AgentActivityV2ProjectionFixture,
  sourceIds: ReplaySourceIds,
  errors: string[],
): void {
  fixture.expected.projectedItems.forEach((item) => {
    if (item.itemType.length === 0) {
      errors.push(`projected item ${item.projectedItemIndex} has an empty item type`);
    }

    validateRawSourceReferences(
      fixture,
      item.sourceReferences,
      `projected item ${item.projectedItemIndex}`,
      sourceIds,
      errors,
    );
  });
}

function isInvisibleClassification(
  classification: AgentActivityV2Classification,
): boolean {
  return classification === "filtered" || classification === "hidden";
}

const IDENTITY_FIELDS = ["id", "callId", "requestId", "handoffId"] as const;

function selectIdentity(
  sourceItem: AgentActivityV2SourceItemExpectation,
): AgentActivityV2IdentityExpectation {
  for (const field of IDENTITY_FIELDS) {
    const candidate = sourceItem.identityCandidates[field];
    if (typeof candidate === "string") {
      return {
        field,
        value: candidate,
      };
    }
  }

  return {
    field: "fallback",
    value: `${sourceItem.itemType}:${sourceItem.activitySourceIndex}`,
  };
}

function identitiesMatch(
  left: AgentActivityV2IdentityExpectation,
  right: AgentActivityV2IdentityExpectation,
): boolean {
  return left.field === right.field && left.value === right.value;
}

function validateSourceItems(
  fixture: AgentActivityV2ProjectionFixture,
  sourceIds: ReplaySourceIds,
  errors: string[],
): void {
  const projectedItemCount = fixture.expected.projectedItems.length;
  const referencedProjectedIndexes = new Set<number>();

  fixture.expected.activitySourceItems.forEach((sourceItem) => {
    const { activitySourceIndex, classification, identity, itemType, origin } = sourceItem;
    if (origin.kind === "projected") {
      validateIndexReferences(
        origin.projectedItemIndexes,
        projectedItemCount,
        `activity source ${activitySourceIndex} projected references`,
        errors,
      );

      const carrierIndex = origin.projectedItemIndexes[0];
      const carrierType = fixture.expected.projectedItems[carrierIndex]?.itemType;
      if (carrierType !== undefined && carrierType !== itemType) {
        errors.push(
          `activity source ${activitySourceIndex} type ${itemType} does not match carrier projected type ${carrierType}`,
        );
      }

      for (const projectedIndex of origin.projectedItemIndexes) {
        if (referencedProjectedIndexes.has(projectedIndex)) {
          errors.push(`projected item ${projectedIndex} feeds more than one activity source`);
        }
        referencedProjectedIndexes.add(projectedIndex);
      }
    } else {
      validateRawSourceReferences(
        fixture,
        origin.sourceReferences,
        `derived activity source ${activitySourceIndex}`,
        sourceIds,
        errors,
      );
    }

    if (itemType.length === 0) {
      errors.push(`activity source ${activitySourceIndex} has an empty item type`);
    }

    if (isInvisibleClassification(classification)) {
      if (identity !== null) {
        errors.push(`invisible activity source ${activitySourceIndex} must not have an identity`);
      }
      return;
    }

    if (identity === null) {
      errors.push(`visible activity source ${activitySourceIndex} must have an identity`);
      return;
    }

    const selectedIdentity = selectIdentity(sourceItem);
    if (!identitiesMatch(identity, selectedIdentity)) {
      errors.push(
        `activity source ${activitySourceIndex} identity ${identity.field}:${identity.value} does not match ${selectedIdentity.field}:${selectedIdentity.value}`,
      );
    }
  });
}

function unitExpectationsMatch(
  left: readonly AgentActivityV2UnitExpectation[],
  right: readonly AgentActivityV2UnitExpectation[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftUnit, index) => {
    const rightUnit = right[index];
    if (
      rightUnit === undefined
      || leftUnit.kind !== rightUnit.kind
      || leftUnit.key !== rightUnit.key
    ) {
      return false;
    }

    if (leftUnit.kind === "standalone" && rightUnit.kind === "standalone") {
      return leftUnit.activitySourceIndex === rightUnit.activitySourceIndex;
    }
    if (leftUnit.kind !== "group" || rightUnit.kind !== "group") {
      return false;
    }
    if (leftUnit.activitySourceIndexes.length !== rightUnit.activitySourceIndexes.length) {
      return false;
    }

    return leftUnit.activitySourceIndexes.every(
      (sourceIndex, sourcePosition) =>
        sourceIndex === rightUnit.activitySourceIndexes[sourcePosition],
    );
  });
}

function buildCanonicalUnitExpectations(
  sourceItems: readonly AgentActivityV2SourceItemExpectation[],
  errors: string[],
): AgentActivityV2UnitExpectation[] {
  const units: AgentActivityV2UnitExpectation[] = [];
  let groupIndexes: number[] = [];

  const flushGroup = (): void => {
    const firstIndex = groupIndexes[0];
    if (firstIndex === undefined) {
      return;
    }

    const firstItem = sourceItems[firstIndex];
    if (firstItem?.identity === null || firstItem === undefined) {
      errors.push(`group beginning at activity source ${firstIndex} has no identity`);
      groupIndexes = [];
      return;
    }

    units.push({
      kind: "group",
      key: `agent-activity-group:${firstItem.identity.value}`,
      activitySourceIndexes: [...groupIndexes] as [number, ...number[]],
    });
    groupIndexes = [];
  };

  for (const sourceItem of sourceItems) {
    if (isInvisibleClassification(sourceItem.classification)) {
      continue;
    }

    if (sourceItem.classification === "groupable") {
      groupIndexes.push(sourceItem.activitySourceIndex);
      continue;
    }

    flushGroup();
    if (sourceItem.identity === null) {
      errors.push(`standalone activity source ${sourceItem.activitySourceIndex} has no identity`);
      continue;
    }

    units.push({
      kind: "standalone",
      key: `agent-activity-standalone:${sourceItem.identity.value}`,
      activitySourceIndex: sourceItem.activitySourceIndex,
    });
  }

  flushGroup();
  return units;
}

function validateUnitMembership(
  fixture: AgentActivityV2ProjectionFixture,
  errors: string[],
): void {
  const { activitySourceItems, units } = fixture.expected;
  const seenVisibleIndexes = new Set<number>();

  units.forEach((unit, unitIndex) => {
    const runtimeKind = (unit as { readonly kind?: unknown }).kind;
    if (runtimeKind !== "group" && runtimeKind !== "standalone") {
      errors.push(`unit ${unitIndex} has unsupported kind ${String(runtimeKind)}`);
      return;
    }

    if (runtimeKind === "group") {
      const group = unit as Extract<AgentActivityV2UnitExpectation, { kind: "group" }>;
      validateIndexReferences(
        group.activitySourceIndexes,
        activitySourceItems.length,
        `group unit ${unitIndex} membership`,
        errors,
      );
      for (const sourceIndex of group.activitySourceIndexes) {
        if (activitySourceItems[sourceIndex]?.classification !== "groupable") {
          errors.push(`group unit ${unitIndex} contains non-groupable source ${sourceIndex}`);
        }
        if (seenVisibleIndexes.has(sourceIndex)) {
          errors.push(`activity source ${sourceIndex} appears in more than one unit`);
        }
        seenVisibleIndexes.add(sourceIndex);
      }
      return;
    }

    const standalone = unit as Extract<
      AgentActivityV2UnitExpectation,
      { kind: "standalone" }
    >;
    const sourceIndex = standalone.activitySourceIndex;
    if (
      !Number.isInteger(sourceIndex)
      || sourceIndex < 0
      || sourceIndex >= activitySourceItems.length
    ) {
      errors.push(`standalone unit ${unitIndex} contains out-of-range source ${sourceIndex}`);
      return;
    }
    if (activitySourceItems[sourceIndex]?.classification !== "standalone") {
      errors.push(`standalone unit ${unitIndex} contains non-standalone source ${sourceIndex}`);
    }
    if (seenVisibleIndexes.has(sourceIndex)) {
      errors.push(`activity source ${sourceIndex} appears in more than one unit`);
    }
    seenVisibleIndexes.add(sourceIndex);
  });

  for (const sourceItem of activitySourceItems) {
    if (isInvisibleClassification(sourceItem.classification)) {
      continue;
    }
    if (!seenVisibleIndexes.has(sourceItem.activitySourceIndex)) {
      errors.push(`visible activity source ${sourceItem.activitySourceIndex} is missing from units`);
    }
  }
}

export function validateAgentActivityV2ProjectionFixture(
  fixture: AgentActivityV2ProjectionFixture,
): readonly string[] {
  const errors: string[] = [];
  const runtimeSchemaVersion = (fixture as { readonly schemaVersion?: unknown }).schemaVersion;
  if (runtimeSchemaVersion !== AGENT_ACTIVITY_V2_FIXTURE_SCHEMA_VERSION) {
    errors.push(`unsupported fixture schema version ${String(runtimeSchemaVersion)}`);
  }

  const { replay, projectionContext, expected } = fixture;
  if (replay.initialThread === null) {
    errors.push("activity projection fixtures require a hydrated initial thread");
  } else if (replay.initialThread.id !== replay.threadId) {
    errors.push("hydrated initial thread does not match the replay thread ID");
  }

  if (
    replay.initialThread?.turns.some((turn) => turn.id === projectionContext.turnId) !== true
  ) {
    errors.push(`projection turn ${projectionContext.turnId} is missing from the hydrated thread`);
  }

  validateDenseIndexes(
    expected.projectedItems,
    (item) => item.projectedItemIndex,
    "projected item indexes",
    errors,
  );
  validateDenseIndexes(
    expected.activitySourceItems,
    (item) => item.activitySourceIndex,
    "activity source indexes",
    errors,
  );
  const sourceIds = collectReplaySourceIds(fixture);
  validateProjectionSources(fixture, sourceIds, errors);
  validateSourceItems(fixture, sourceIds, errors);
  validateUnitMembership(fixture, errors);

  const canonicalUnits = buildCanonicalUnitExpectations(expected.activitySourceItems, errors);
  if (!unitExpectationsMatch(expected.units, canonicalUnits)) {
    errors.push("fixture units do not match canonical hidden/filter/barrier grouping semantics");
  }

  return errors;
}

export function assertAgentActivityV2ProjectionFixture(
  fixture: AgentActivityV2ProjectionFixture,
): void {
  const errors = validateAgentActivityV2ProjectionFixture(fixture);
  if (errors.length === 0) {
    return;
  }

  throw new Error(`Invalid agent activity v2 fixture:\n- ${errors.join("\n- ")}`);
}
