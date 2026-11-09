import * as Effect from "effect/Effect";
import { makeWithCapture as makeContent } from "../main/app-tools/ContentAppTools";
import { makeWithCapture as makeQuery } from "../main/app-tools/ContentQueryAppTools";
import { makeWithCapture as makeAutomations } from "../main/app-tools/AutomationAppTools";
import { makeWithCapture as makeCoordinator } from "../main/app-tools/CoordinatorAppTools";
import { makeWithCapture as makeWork } from "../main/app-tools/WorkAppTools";
import { makeWithCapture as makeInbox } from "../main/app-tools/InboxAppTools";
import { makeWithCapture as makeHandback } from "../main/app-tools/MessageHandbackAppTools";
import { makeWithCapture as makeFollow } from "../main/app-tools/FollowThreadAppTools";
import { makeWithCapture as makeDependencies } from "../main/app-tools/WorkspaceDependencyAppTools";
import { captureHostedAppToolAuthority } from "../main/app-tools/AppToolCaller";
import {
  runtimeHostToolCatalog,
  hostToolGroupByName,
  type HostToolGroupExecutor,
} from "./HostToolExecutor";

export const hostContentToolGroups = [
  "content",
  "query",
  "automations",
  "coordinator",
  "work",
  "inbox",
  "messageHandback",
  "followThread",
  "dependencies",
] as const;
const groups = new Set<string>(hostContentToolGroups);
export const hostContentToolCatalog = runtimeHostToolCatalog.filter(({ name }) =>
  groups.has(hostToolGroupByName.get(name) ?? ""),
);

/** Shared semantic groups keep advertisement and execution on the same catalog. */
export const make = Effect.gen(function* () {
  return {
    content: yield* makeContent(captureHostedAppToolAuthority),
    query: yield* makeQuery(captureHostedAppToolAuthority),
    automations: yield* makeAutomations(captureHostedAppToolAuthority),
    coordinator: yield* makeCoordinator(captureHostedAppToolAuthority),
    work: yield* makeWork(captureHostedAppToolAuthority),
    inbox: yield* makeInbox(captureHostedAppToolAuthority),
    messageHandback: yield* makeHandback(captureHostedAppToolAuthority),
    followThread: yield* makeFollow(captureHostedAppToolAuthority),
    dependencies: yield* makeDependencies(captureHostedAppToolAuthority),
  } satisfies Record<(typeof hostContentToolGroups)[number], HostToolGroupExecutor>;
});
