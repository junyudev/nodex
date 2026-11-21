import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AcpInputSchemas } from "../../../shared/schemas/acp-api";
import { AcpAgents } from "../../acp-agents/AcpAgents";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { makeWindowAgentManagement } from "./window-agent-management";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* AcpAgents;
    const ipc = yield* ElectronIpc;
    const handle = yield* makeWindowAgentManagement({ ...agents, releaseOwner: () => Effect.void });
    yield* ipc.handleQuery("acp:registry:search", (event, input) =>
      handle(event, AcpInputSchemas["acp.registry.search"], input, agents["acp.registry.search"]),
    );
    yield* ipc.handleQuery("acp:inspect", (event, input) =>
      handle(event, AcpInputSchemas["acp.inspect"], input, agents["acp.inspect"]),
    );
    yield* ipc.handleQuery("acp:install:preview", (event, input) =>
      handle(event, AcpInputSchemas["acp.install.preview"], input, agents["acp.install.preview"]),
    );
    yield* ipc.handleQuery("acp:operation:read", (event, input) =>
      handle(event, AcpInputSchemas["acp.operation.read"], input, agents["acp.operation.read"]),
    );
    yield* ipc.handleQuery("acp:sessions:list", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.list"], input, agents["acp.sessions.list"]),
    );
    yield* ipc.handleQuery("acp:modelProviders:list", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.list"],
        input,
        agents["acp.modelProviders.list"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:install:start", (event, input) =>
      handle(event, AcpInputSchemas["acp.install.start"], input, agents["acp.install.start"]),
    );
    yield* ipc.handlePlainCommand("acp:registry:uninstall", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.registry.uninstall"],
        input,
        agents["acp.registry.uninstall"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:connection:start", (event, input) =>
      handle(event, AcpInputSchemas["acp.connection.start"], input, agents["acp.connection.start"]),
    );
    yield* ipc.handlePlainCommand("acp:operation:cancel", (event, input) =>
      handle(event, AcpInputSchemas["acp.operation.cancel"], input, agents["acp.operation.cancel"]),
    );
    yield* ipc.handlePlainCommand("acp:urlAuth:accept", (event, input) =>
      handle(event, AcpInputSchemas["acp.urlAuth.accept"], input, agents["acp.urlAuth.accept"]),
    );
    yield* ipc.handlePlainCommand("acp:sessions:delete", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.delete"], input, agents["acp.sessions.delete"]),
    );
    yield* ipc.handlePlainCommand("acp:modelProviders:set", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.set"],
        input,
        agents["acp.modelProviders.set"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:modelProviders:disable", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.disable"],
        input,
        agents["acp.modelProviders.disable"],
      ),
    );
    yield* ipc.handleQuery("acp:sessions:prepareImport", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.sessions.prepareImport"],
        input,
        agents["acp.sessions.prepareImport"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:sessions:import", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.import"], input, agents["acp.sessions.import"]),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
