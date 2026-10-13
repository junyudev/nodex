import type {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskWebhookDeliveryOutcome,
  ScheduledTaskListResult,
  ScheduledTaskMutationResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { WebhookTriggerRequest, WebhookTriggerResult } from "./ScheduledTaskService.ts";

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    /** Issues a new URL token for a webhook task; the old URL stops working at once. */
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /**
     * Verifies, logs and dispatches one webhook request. Returns as soon as the
     * delivery is logged; the run itself continues in the background so senders
     * with short timeouts get their answer immediately.
     */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}
