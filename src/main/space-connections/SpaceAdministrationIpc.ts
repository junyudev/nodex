import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { ElectronIpc } from "../platform/electron/ElectronIpc";

/** Acquired under the selected Space authority for both local and remote ingress. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const core = yield* CoreSessionAccess;
    const authority = yield* CoreAuthority;
    const snapshot = (state: components["schemas"]["RemoteAccessState"]) => ({
      listener: state.listener ?? null,
      intent: authority.initialLaunch ? state.intent : null,
      routesChanged: state.routes_changed,
    });
    const remoteAccess = core
      .use("space-admin:remoteAccess", (client, signal) => {
        if (!client.spaceRemoteAccess) throw new Error("Space administration is unavailable");
        return client.spaceRemoteAccess({ signal });
      })
      .pipe(Effect.map(snapshot));
    yield* ipc.handleQuery("space-admin:members", () =>
      core.use("space-admin:members", (client, signal) => {
        if (!client.spaceMembers) throw new Error("Space administration is unavailable");
        return client.spaceMembers({ signal });
      }),
    );
    yield* ipc.handleQuery("space-admin:devices", () =>
      core.use("space-admin:devices", (client, signal) => {
        if (!client.spaceDevices) throw new Error("Space administration is unavailable");
        return client.spaceDevices({ signal });
      }),
    );
    yield* ipc.handlePlainCommand("space-admin:invite", (_, input) =>
      core.use(
        "space-admin:invite",
        (client, signal) => {
          if (!client.spaceInvite) throw new Error("Space administration is unavailable");
          return client.spaceInvite(input, { signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handlePlainCommand("space-admin:link-device", () =>
      core.use(
        "space-admin:linkDevice",
        (client, signal) => {
          if (!client.spaceLinkDevice) throw new Error("Space administration is unavailable");
          return client.spaceLinkDevice({ signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handlePlainCommand("space-admin:revoke", (_, input) =>
      core.use(
        "space-admin:revokeDevice",
        (client, signal) => {
          if (!client.spaceRevokeDevice) throw new Error("Space administration is unavailable");
          return client.spaceRevokeDevice(input, { signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handlePlainCommand("space-admin:remove-member", (_, input) =>
      core.use(
        "space-admin:removeMember",
        (client, signal) => {
          if (!client.spaceRemoveMember) throw new Error("Space administration is unavailable");
          return client.spaceRemoveMember(input, { signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handlePlainCommand("space-admin:name", (_, input) =>
      core.use(
        "space-admin:rename",
        (client, signal) => {
          if (!client.spaceRename) throw new Error("Space administration is unavailable");
          return client.spaceRename(input, { signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handlePlainCommand("space-admin:member-name", (_, input) =>
      core.use(
        "space-admin:renameMember",
        (client, signal) => {
          if (!client.spaceRenameMember) throw new Error("Space administration is unavailable");
          return client.spaceRenameMember(input, { signal });
        },
        { replayAfterRecovery: false },
      ),
    );
    yield* ipc.handleQuery("space-admin:remote-access", () => remoteAccess);
    yield* ipc.handlePlainCommand("space-admin:remote-access-on", (_, input) =>
      core
        .use(
          "space-admin:remoteAccessOn",
          (client, signal) => {
            if (!client.spaceRemoteAccessOn) throw new Error("Space administration is unavailable");
            return client.spaceRemoteAccessOn(input, { signal });
          },
          { replayAfterRecovery: false },
        )
        .pipe(Effect.andThen(remoteAccess)),
    );
    yield* ipc.handlePlainCommand("space-admin:remote-access-off", () =>
      core
        .use(
          "space-admin:remoteAccessOff",
          (client, signal) => {
            if (!client.spaceRemoteAccessOff)
              throw new Error("Space administration is unavailable");
            return client.spaceRemoteAccessOff({ signal });
          },
          { replayAfterRecovery: false },
        )
        .pipe(Effect.map(snapshot)),
    );
  }),
);
