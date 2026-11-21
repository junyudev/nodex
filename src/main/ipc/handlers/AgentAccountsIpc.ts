import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentAccountInputSchemas as schemas } from "../../../shared/schemas/agent-accounts-api";
import { AgentAccounts } from "../../agent-accounts/AgentAccounts";
import { makeAgentManagementFailurePresenter } from "../../agent-runtime/AgentManagementFailure";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { makeWindowAgentManagement } from "./window-agent-management";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* AgentAccounts;
    const application = yield* AgentRuntimeApplication;
    const ipc = yield* ElectronIpc;
    const handle = yield* makeWindowAgentManagement({
      ...accounts,
      presentFailure: makeAgentManagementFailurePresenter(application),
    });
    yield* ipc.handleQuery("agent-accounts:read", (event, input) =>
      handle(event, schemas.read, input, accounts.read),
    );
    yield* ipc.handlePlainCommand("agent-accounts:start", (event, input) =>
      handle(event, schemas.start, input, accounts.start),
    );
    yield* ipc.handlePlainCommand("agent-accounts:respond", (event, input) =>
      handle(event, schemas.respond, input, accounts.respond),
    );
    yield* ipc.handlePlainCommand("agent-accounts:complete", (event, input) =>
      handle(event, schemas.complete, input, accounts.complete),
    );
    yield* ipc.handlePlainCommand("agent-accounts:cancel", (event, input) =>
      handle(event, schemas.cancel, input, accounts.cancel),
    );
    yield* ipc.handlePlainCommand("agent-accounts:logout", (event, input) =>
      handle(event, schemas.logout, input, accounts.logout),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
