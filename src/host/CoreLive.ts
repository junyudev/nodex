import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../main/app/MainConfig";
import { live as authority } from "../main/core-runtime/CoreAuthority";
import { live as modules } from "../main/core-runtime/CoreModules";
import { live as transport } from "../main/core-runtime/CoreTransport";
import { CoreAuthority, CoreSessionAccess } from "../main/core-runtime/CoreAuthority";
import { CoreEventDelivery, live as events } from "../main/core-runtime/CoreEventHub";
import {
  CoreApplicationProjectionRuntime,
  live as projections,
} from "../main/core-runtime/CoreApplicationProjectionRuntime";
import { coreRuntimeError } from "../main/core-runtime/CoreRuntimeError";
import { live as routing } from "../main/core-runtime/AutomationRoutingIndex";
import { make as makeCommits } from "../main/core-runtime/LocalCommitRuntime";
import { live as projects } from "../main/project-application/ProjectWorkspace";
import { live as library } from "../main/library-application/LibraryModule";
import { live as databases } from "../main/database-application/DatabaseModule";
import { live as files } from "../main/library-application/FileExportRuntime";
import { live as agentContent } from "../main/nodex-agent-application/NodexAgentApplication";
import { live as lifecycle } from "../main/host-runtime/ProjectRuntimeLifecycleRuntime";
import { headless as notifications } from "../main/host-runtime/DatabaseNotifierRuntime";
import {
  CodexApplicationEventHub,
  make as makeApplicationEvents,
} from "../main/codex-application/CodexApplicationEventHub";
import { live as automation } from "./automation-application/AutomationApplication";

const delivery = Layer.effect(
  CoreEventDelivery,
  Effect.gen(function* () {
    const owner = yield* CoreAuthority;
    const access = yield* CoreSessionAccess;
    const handshake = yield* access.handshake;
    const projection = yield* CoreApplicationProjectionRuntime;
    const commits = yield* makeCommits({
      expectedLibraryId: owner.identity.libraryId,
      expectedStoreEpoch: owner.identity.storeEpoch,
      onDocument: () => Effect.void,
      onProjection: () => Effect.void,
      onNotification: (packet, atom) =>
        projection.publish(
          { transport_version: handshake.selected_transport_version, packet },
          atom,
          owner.identity.libraryId,
        ),
    });
    const failure = (operation: string) => (cause: unknown) =>
      coreRuntimeError({ operation, cause, reason: "delivery", retryable: false });
    return {
      event: (envelope) =>
        commits
          .admitAndWait(envelope.packet, "tailer")
          .pipe(Effect.asVoid, Effect.mapError(failure("events.deliver"))),
      checkpoint: (checkpoint) =>
        commits.observeCheckpoint(checkpoint).pipe(Effect.mapError(failure("events.checkpoint"))),
      resync: (boundary) =>
        commits.resetStream("event_gap").pipe(
          Effect.andThen(
            projection.publishResync({
              commitSeq: boundary.commit_head,
              libraryId: owner.identity.libraryId,
              storeEpoch: owner.identity.storeEpoch,
            }),
          ),
        ),
    };
  }),
);

/** Core content and producer wakeups for one Space, with no renderer audience or document replica. */
export const live = (coreHome: string, operatorAddress: string) => {
  const coreTransport = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      return transport({
        appResourcesPath: config.isPackaged ? config.resourcesPath : undefined,
        buildId: `nodex-host/${config.appVersion}`,
        isPackaged: config.isPackaged,
        nodexHome: coreHome,
        operatorListener: { address: operatorAddress, cert: null, key: null },
        repositoryRoot: config.projectRootPath,
      });
    }),
  );
  const core = modules.pipe(Layer.provideMerge(authority().pipe(Layer.provide(coreTransport))));
  const data = Layer.mergeAll(projects, library, databases, routing, lifecycle).pipe(
    Layer.provideMerge(core),
  );
  const content = Layer.mergeAll(agentContent, files, automation).pipe(Layer.provideMerge(data));
  const platform = Layer.merge(
    notifications,
    Layer.effect(CodexApplicationEventHub, makeApplicationEvents),
  );
  const projected = projections.pipe(Layer.provideMerge(Layer.merge(content, platform)));
  return events({}).pipe(Layer.provideMerge(delivery.pipe(Layer.provideMerge(projected))));
};
