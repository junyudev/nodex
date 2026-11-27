import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../main/agent-runtime/AgentRuntimeSupervisor";
import { AutomationRoutingIndex } from "../main/core-runtime/AutomationRoutingIndex";
import { layer as administration } from "../main/core-runtime/StoreAdministration";
import {
  ClockAutomationRuntime,
  live as clockAutomations,
} from "../main/host-runtime/ClockAutomationRuntime";
import {
  StoreAdministrationSchedulerRuntime,
  live as maintenance,
} from "../main/host-runtime/StoreAdministrationSchedulerRuntime";
import * as GitHubPlatform from "../main/platform/node/GitHubSourcePlatform";
import * as Automation from "./automation-application/AutomationExecution";
import * as Decisions from "./nodex-decisions/DecisionRuns";
import * as ChatExecution from "./work-observation/ChatExecutionMonitor";
import * as Assessments from "./nodex-decisions/AutomationAssessmentRuntime";
import * as Inbox from "./inbox-application/InboxApplication";
import * as InboxDispatcher from "./inbox-application/InboxDispatcher";
import * as InboxDispatch from "./inbox-application/InboxDispatchRuntime";
import * as ChannelSender from "./sources/ChannelSender";
import * as GitHubAccount from "./github/GitHubAccount";
import * as GitHubThreads from "./github/GitHubThreads";
import * as GitHubChannel from "./sources/GitHubChannelAdapter";
import * as GitHubSource from "./sources/GitHubSourceAdapter";
import * as Sources from "./sources/SourceSupervisor";
import * as ThreadDelivery from "./sources/ThreadDeliveryRuntime";
import * as Holds from "./work-application/ExecutionHoldRuntime";
import * as Work from "./work-application/WorkApplication";
import * as MemberMessages from "./MemberMessages";
import * as ChatAttachments from "./ChatAttachments";
import * as WorkDispatch from "./work-application/WorkDispatchRuntime";
import { live as notificationIntents } from "./NotificationIntents";
import * as WorkScheduler from "./work-application/WorkScheduler";

/** One Space's shared producers. Acquisition and rollback belong to the embedding process Scope. */
export class HostKernel extends Context.Service<
  HostKernel,
  {
    readonly synchronize: AutomationRoutingIndex["Service"]["synchronize"];
    readonly activate: Effect.Effect<void>;
  }
>()("nodex/host/HostKernel") {}

const administrationLayer = Layer.unwrap(
  Effect.gen(function* () {
    const application = yield* AgentRuntimeApplication;
    const runtime = yield* AgentRuntimeSupervisor;
    return administration({
      restore: {
        prepare: application.stopRunningReplies(),
        withStopped: (use) => runtime.withStopped(use, { retireOnSuccess: true }),
      },
    });
  }),
);

const kernel = Layer.effect(
  HostKernel,
  Effect.gen(function* () {
    const routing = yield* AutomationRoutingIndex;
    const clock = yield* ClockAutomationRuntime;
    const store = yield* StoreAdministrationSchedulerRuntime;
    return {
      synchronize: routing.synchronize,
      activate: Effect.all([clock.activate, store.activate], {
        concurrency: "unbounded",
        discard: true,
      }),
    };
  }),
);

/** Application capabilities acquire before app tools and recovered producer work. */
/** Host owners a Member reaches through Core: Page work, and their messages to and reads of hosted chats. */
export const workApplication = Layer.mergeAll(Work.live, MemberMessages.live, ChatAttachments.live);
const inbox = Inbox.live.pipe(Layer.provideMerge(administrationLayer));
const automation = Automation.live.pipe(Layer.provideMerge(inbox));
const clock = clockAutomations().pipe(Layer.provideMerge(automation));
const schedules = maintenance({}).pipe(Layer.provideMerge(clock));
const decisions = Layer.merge(Decisions.live, notificationIntents).pipe(
  Layer.provideMerge(schedules),
);
export const applications = Layer.mergeAll(
  GitHubSource.live,
  GitHubChannel.live,
  GitHubThreads.live,
).pipe(
  Layer.provide(GitHubAccount.live),
  Layer.provide(GitHubPlatform.live),
  Layer.provideMerge(decisions),
);

const workers = Layer.mergeAll(
  ThreadDelivery.live,
  ChannelSender.live,
  InboxDispatcher.live,
  Assessments.live,
  Decisions.retirement,
  InboxDispatch.live,
  ChatExecution.live,
  WorkScheduler.live,
  Holds.live,
  WorkDispatch.live,
);

/** The embedding Scope supplies application and tool capabilities before starting producers. */
export const live = kernel.pipe(Layer.provideMerge(Sources.live.pipe(Layer.provideMerge(workers))));
