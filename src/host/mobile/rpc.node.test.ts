import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import {
  MemberMessages,
  type HostedChatMessageInput,
  type HostedChatStartInput,
  type MemberChatStartInput,
} from "../MemberMessages";
import {
  agentRuntimeProviderFixture,
  agentRuntimeSnapshotFixture,
} from "../../shared/testing/agent-runtime-snapshot";
import { createUuidV7 } from "../../shared/uuid-v7";
import { makeMobileChatCommands } from "./chat-commands";
import { mobileAgentChoice } from "./inbox";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { HostInvocation } from "../HostInvocation";
import { invokeMobileRpc, type MobileHandlers } from "./rpc";

it.effect("refuses a phone call without Member invocation before invoking its owner", () =>
  Effect.gen(function* () {
    let calls = 0;
    const handlers = {
      "projects.list": () =>
        Effect.sync(() => {
          calls++;
          return { projects: [], libraryInboxCount: 0 };
        }),
    } as unknown as MobileHandlers;
    const refused = yield* Effect.result(invokeMobileRpc(handlers, "projects.list", {}));
    expect(refused).toMatchObject({
      _tag: "Failure",
      failure: { code: "rejected", retryable: false },
    });
    expect(calls).toBe(0);
    const admitted = yield* invokeMobileRpc(handlers, "projects.list", {}).pipe(
      Effect.provideService(HostInvocation, "core-invocation-context"),
    );
    expect(admitted).toEqual({ projects: [], libraryInboxCount: 0 });
    expect(calls).toBe(1);
  }),
);

it.effect("starts chats at the phone's offered effort and leaves other choices to the model", () =>
  Effect.gen(function* () {
    const starts: HostedChatStartInput[] = [];
    const commands = yield* makeMobileChatCommands({
      agentChoice: (choice) => Effect.succeed(mobileAgentChoice(choice!)),
    }).pipe(
      Effect.provideService(AgentRuntimeApplication, {
        catalog: () => Effect.succeed([provider]),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(MemberMessages, {
        start: (input: MemberChatStartInput<never>) =>
          Effect.gen(function* () {
            const modelSelection =
              "resolve" in input.modelSelection
                ? yield* input.modelSelection.resolve
                : input.modelSelection;
            starts.push({ ...input, modelSelection });
            return { sessionId: input.sessionId };
          }),
      } as unknown as MemberMessages["Service"]),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
    );
    for (const [effort, expected] of [
      ["high", "high"],
      ["unoffered", "medium"],
      [null, null],
    ] as const) {
      yield* commands.handlers["chats.start"]({
        sessionId: "chat",
        launchId: createUuidV7(),
        messageId: "message",
        text: "Start",
        projectId: null,
        location: "local",
        fileRefs: [],
        agent: { providerInstanceId: "codex", model: "model", reasoningEffort: effort },
      });
      expect(starts.at(-1)?.modelSelection).toEqual({
        instanceId: "codex",
        model: "model",
        ...(expected ? { options: [{ id: "reasoningEffort", value: expected }] } : {}),
      });
    }
  }),
);

it.effect(
  "changes only an offered, different effort on a message, preserving the chat's other options",
  () =>
    Effect.gen(function* () {
      const sent: unknown[] = [];
      let reads = 0;
      let alreadyAccepted = false;
      const selection = {
        instanceId: "codex",
        model: "model",
        options: [
          { id: "serviceTier", value: "fast" },
          { id: "futureOption", value: true },
        ],
      };
      const commands = yield* makeMobileChatCommands({
        agentChoice: () => Effect.die("Send uses the chat's Agent"),
      }).pipe(
        Effect.provideService(AgentRuntimeApplication, {
          catalog: () => Effect.succeed([provider]),
          read: () =>
            Effect.sync(() => {
              reads++;
              return {
                snapshot: agentRuntimeSnapshotFixture({ thread: { modelSelection: selection } }),
              };
            }),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(MemberMessages, {
          send: (
            input: HostedChatMessageInput,
            effort: Parameters<MemberMessages["Service"]["send"]>[1],
          ) =>
            Effect.gen(function* () {
              if (alreadyAccepted) return;
              const modelSelection = effort
                ? yield* effort.resolve({ sessionId: "chat", threadId: "thread" })
                : undefined;
              sent.push({
                ...input,
                message: { ...input.message, ...(modelSelection ? { modelSelection } : {}) },
              });
            }),
        } as unknown as MemberMessages["Service"]),
        Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
      );
      for (const delivery of ["queue", "steer"] as const) {
        for (const effort of ["high", "medium", "unoffered", null, undefined]) {
          const input = {
            sessionId: "chat",
            messageId: "message",
            text: "Continue",
            fileRefs: ["file"],
            delivery,
          };
          yield* commands.handlers["chat.send"]({
            ...input,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          });
          expect(sent.at(-1)).toEqual({
            sessionId: "chat",
            delivery,
            message: {
              messageId: "message",
              text: "Continue",
              fileRefs: ["file"],
              ...(effort === "high"
                ? {
                    modelSelection: {
                      ...selection,
                      options: [...selection.options, { id: "reasoningEffort", value: "high" }],
                    },
                  }
                : {}),
            },
          });
        }
      }
      expect(reads).toBe(6); // Null and absent keep the existing send path, with no extra Runtime read.
      alreadyAccepted = true;
      yield* commands.handlers["chat.send"]({
        sessionId: "chat",
        messageId: "message",
        text: "Continue",
        fileRefs: ["file"],
        delivery: "steer",
        reasoningEffort: "high",
      });
      expect(reads).toBe(6);
    }),
);

const provider = agentRuntimeProviderFixture({
  models: [
    {
      slug: "model",
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            type: "select",
            id: "reasoningEffort",
            label: "Reasoning",
            currentValue: "medium",
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
});
