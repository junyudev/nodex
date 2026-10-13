import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { MainConfig, testLayer as mainConfig } from "../app/MainConfig";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { make } from "./CodexThreadTargets";

export const targetThread = (id: string): Thread => ({
  model: null,
  reasoningEffort: null,
  id,
  environments: null,
  extra: null,
  sessionId: `native-${id}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "Created response",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: "idle" },
  path: null,
  cwd: "/remote/work",
  cliVersion: "fixture",
  originator: null,
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: "user",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "**Created** chat",
  daybreakEnabled: null,
  turns: [],
});

export const makeTargetFixture = (input: {
  readonly core: CoreModules["Service"];
  readonly request?: CodexGateway["Service"]["requestOnHost"];
  readonly hostId?: string;
}) =>
  Effect.gen(function* () {
    const hostId = input.hostId ?? "ssh:owner";
    let generation = 1;
    let current = true;
    let online = true;
    const resets = new Set<() => void>();
    const disposals = new Set<() => void>();
    const listen = (set: Set<() => void>, callback: () => void): Disposable => {
      set.add(callback);
      return {
        [Symbol.dispose]: () => {
          set.delete(callback);
        },
      };
    };
    const manager = {
      hostId,
      get generation() {
        return generation;
      },
      assertCurrent(expected: number) {
        if (!current || expected !== generation) throw new Error("Source retired");
      },
      onDispose: (callback: () => void) => listen(disposals, callback),
      onConnectionReset: (callback: () => void) => listen(resets, callback),
    };
    const capability = createCodexAppServerCapabilitySnapshot({
      hostId,
      generation,
      userAgent: "codex/0.150.0-alpha.12",
    });
    const requests: { hostId: string; method: string; params: unknown; options: unknown }[] = [];
    const config = Context.get(
      yield* Layer.buildWithScope(mainConfig(), yield* Scope.Scope),
      MainConfig,
    );
    const service = yield* make.pipe(
      Effect.provideService(CoreModules, input.core),
      Effect.provideService(CodexMainConversationManagers, {
        current: (host: string) => (current && host === hostId ? manager : null),
        get: () => Effect.die("A readonly target cannot start a manager"),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexGateway, {
        connection: () => Effect.succeed({ kind: online ? "ready" : "disconnected" }),
        requestOnHost: (host: string, method: string, params: unknown, options: unknown) => {
          requests.push({ hostId: host, method, params, options });
          return input.request
            ? input.request(host, method as never, params as never, options as never)
            : Effect.die("No native read expected");
        },
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.succeed(current && capability.generation === generation),
      }),
      Effect.provideService(MainConfig, config),
    );
    return {
      service,
      requests,
      disconnect: () => {
        online = false;
      },
      reset: () => {
        generation++;
        for (const callback of resets) callback();
      },
      dispose: () => {
        current = false;
        for (const callback of disposals) callback();
      },
      listeners: () => resets.size + disposals.size,
      retirementCallbacks: () => [...resets, ...disposals],
    };
  });
