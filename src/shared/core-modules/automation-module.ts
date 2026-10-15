import type { components } from "@nodex/core-protocol";
import type { DeepCoreModule } from "./common";

type SuccessfulPayload<Response> = Response extends {
  readonly status: "ok";
  readonly payload: infer Payload;
}
  ? Payload
  : never;

// Runtime contracts come directly from Core; product projections own their camelCase view models.
export type AutomationDefinitionKind = components["schemas"]["AutomationDefinitionKind"];
export type AutomationDefinitionStatus = components["schemas"]["AutomationDefinitionStatus"];
export type AutomationExecutionEnvironment =
  components["schemas"]["AutomationExecutionEnvironment"];
export type AutomationDefinitionInput = components["schemas"]["AutomationDefinitionInput"];
export type AutomationDefinition = components["schemas"]["AutomationDefinition"];
export type AutomationReasoningEffort = NonNullable<AutomationDefinitionInput["reasoning_effort"]>;
export type AutomationLeaseStatus = components["schemas"]["AutomationLeaseStatus"];
export type AutomationLease = components["schemas"]["AutomationLease"];
export type AutomationRunStatus = components["schemas"]["AutomationRunStatus"];
export type AutomationRun = components["schemas"]["AutomationRun"];
export type AutomationInboxItem = Extract<
  AutomationReadValue,
  { readonly kind: "inbox" }
>["window"]["items"][number];
export type AutomationRunUnreadCounts = components["schemas"]["AutomationRunUnreadCounts"];
export type AutomationRunBulkResult = components["schemas"]["AutomationRunBulkResult"];
export type AutomationRead = AutomationModuleReadRequest["read"];
export type AutomationReadValue = SuccessfulPayload<AutomationModuleReadResult>["value"];
export type AutomationIntent = components["schemas"]["AutomationIntent"];
export type AutomationCommitValue = SuccessfulPayload<AutomationModuleApplyResult>["outcome"];
export type AutomationReceipt = SuccessfulPayload<AutomationModuleApplyResult>["receipt"];
export type AutomationEvent = components["schemas"]["AutomationEvent"];
export type AutomationModuleReadRequest = components["schemas"]["AutomationReadRequest"];
export type AutomationModuleReadResult = components["schemas"]["AutomationReadResponse"];
export type AutomationModuleApplyRequest = components["schemas"]["AutomationApplyRequest"];
export type AutomationModuleApplyResult = components["schemas"]["AutomationApplyResponse"];
export type AutomationModule = DeepCoreModule<
  AutomationModuleReadRequest,
  AutomationModuleReadResult,
  AutomationModuleApplyRequest,
  AutomationModuleApplyResult
>;
