import type { ChatActivity, MobileEventData } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { makeMobileCatalog } from "./catalog";
import { makeMobileChatCommands } from "./chat-commands";
import { makeMobileFiles } from "./files";
import { makeMobileInbox } from "./inbox";
import { MobileRpc, type PushMobileEvent } from "./rpc";
import { makeMobileTranscript } from "./transcript";
import { nativeActivity } from "./transcript-projection";

type Topic = MobileEventData<"changed">["topics"][number];
const topics = ["inbox", "chats", "projects", "agents"] as const;

export const live = Layer.effect(
  MobileRpc,
  Effect.gen(function* () {
    const database = yield* DatabaseNotifierRuntime;
    const runtime = yield* AgentRuntimeApplication;
    const settings = yield* ApplicationSettings;
    const files = yield* makeMobileFiles;
    const inbox = yield* makeMobileInbox(files);
    const catalog = yield* makeMobileCatalog;
    const commands = yield* makeMobileChatCommands(files, catalog);
    const transcript = yield* makeMobileTranscript(commands);

    const inboxChanged = database.inboxInvalidations.pipe(
      Stream.map((): readonly Topic[] => ["inbox", "projects"]),
    );
    const chatsChanged = database.projectSessionInvalidations.pipe(
      Stream.map((): readonly Topic[] => ["chats"]),
    );
    const projectsChanged = database.projectInvalidations.pipe(
      Stream.map((): readonly Topic[] => ["projects", "chats"]),
    );
    const agentsChanged = Stream.merge(runtime.catalogChanges, settings.inboxSettingsChanges).pipe(
      Stream.map((): readonly Topic[] => ["agents"]),
    );
    const changes = Stream.mergeAll([inboxChanged, chatsChanged, projectsChanged, agentsChanged], {
      concurrency: 4,
      bufferSize: 16,
    }).pipe(Stream.groupedWithin(128, "250 millis"));

    return MobileRpc.of({
      open: (send) =>
        Effect.gen(function* () {
          const activity = new Map<string, ChatActivity>();
          const push: PushMobileEvent = (event, data) => {
            if (event !== "chat.activity") return send(event, data);
            const next = data as ChatActivity;
            return Effect.sync(() => {
              activity.delete(next.sessionId);
              activity.set(next.sessionId, next);
              if (activity.size > 128) activity.delete(activity.keys().next().value!);
            }).pipe(Effect.andThen(send(event, data)));
          };
          const fileHandlers = yield* files.open;
          const history = yield* transcript(push);
          yield* changes.pipe(
            Stream.runForEach((changes) =>
              push("changed", { topics: [...new Set(changes.flat())] }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* catalog
            .observeActivity((data) => push("chat.activity", data))
            .pipe(Effect.forkScoped({ startImmediately: true }));
          // Native Thread status is projected into Core's Session invalidations.
          yield* database.projectSessionInvalidations.pipe(
            Stream.filter((change) => change.changeType === "thread"),
            Stream.runForEach(({ detailInvalidation }) => {
              if (detailInvalidation.kind === "all") return Effect.void;
              return Effect.forEach(
                detailInvalidation.sessionIds,
                (sessionId) =>
                  Effect.gen(function* () {
                    const row = yield* commands.session(sessionId);
                    if (row.executionRef || !row.thread) return;
                    yield* push(
                      "chat.activity",
                      nativeActivity(
                        sessionId,
                        row.thread.statusType,
                        row.thread.statusActiveFlags,
                      ),
                    );
                  }).pipe(Effect.ignore),
                { discard: true, concurrency: 2 },
              );
            }),
            Effect.forkScoped({ startImmediately: true }),
          );
          return {
            handlers: {
              ...fileHandlers,
              ...inbox,
              ...commands.handlers,
              ...history.handlers,
              "projects.list": catalog.projects,
              "agents.catalog": catalog.agents,
              "chats.list": catalog.chats,
            },
            recover: (recover, discard) =>
              history
                .recover(recover, discard)
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      Effect.forEach(
                        [...activity.values()],
                        (data) => recover("chat.activity", data),
                        { discard: true },
                      ),
                    ),
                  ),
                  Effect.andThen(recover("changed", { topics: [...topics] })),
                ),
          };
        }),
    });
  }),
);
