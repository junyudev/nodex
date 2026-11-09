import * as Effect from "effect/Effect";
import type { CoreModuleClients } from "../../main/core-runtime/CoreModules";
import type { InboxSettings } from "../../shared/inbox";
import { createOperationId } from "../../main/core-runtime/operation-identity";

/** Import the Desktop's previous preference once; Core owns subsequent Member choices. */
export const readRoutingConsent = (core: CoreModuleClients, settings: InboxSettings) =>
  Effect.gen(function* () {
    const snapshot = yield* core.workspace.read({ kind: "inbox_routing_consent" }, undefined, null);
    if (snapshot.value.kind !== "inbox_routing_consent")
      return yield* Effect.die(new Error("Invalid Inbox consent response"));
    if (snapshot.value.start_my_requests !== null && snapshot.value.start_my_requests !== undefined)
      return snapshot.value.start_my_requests;
    const initial = settings.dispatchMode === "act_on_requests";
    yield* writeRoutingConsent(core, initial, true);
    const current = yield* core.workspace.read({ kind: "inbox_routing_consent" }, undefined, null);
    if (current.value.kind !== "inbox_routing_consent")
      return yield* Effect.die(new Error("Invalid Inbox consent response"));
    return current.value.start_my_requests === true;
  });

export const writeRoutingConsent = (
  core: CoreModuleClients,
  start: boolean,
  initializeOnly = false,
) =>
  core.workspace.apply(
    {
      operationId: createOperationId("inbox.routing-consent"),
      intent: {
        kind: "set_inbox_routing_consent",
        start_my_requests: start,
        initialize_only: initializeOnly,
      },
    },
    undefined,
    null,
  );
