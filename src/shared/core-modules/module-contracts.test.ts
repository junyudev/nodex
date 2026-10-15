import { describe, expect, test } from "vite-plus/test";

import {
  bindInProcessModule,
  type BoundModuleContext,
  type DeepCoreModule,
  type ModuleApplyRequest,
  type ModuleReadRequest,
} from ".";

interface ProbeRead {
  readonly kind: "metadata";
}

interface ProbeIntent {
  readonly kind: "rename_project";
  readonly projectId: string;
  readonly name: string;
}

type ProbeReadRequest = ModuleReadRequest<ProbeRead>;
type ProbeApplyRequest = ModuleApplyRequest<ProbeIntent>;

describe("deep Core Module contract", () => {
  test("binds trusted adapter identity separately and preserves Module-owned results", async () => {
    const observed: BoundModuleContext[] = [];
    const module: DeepCoreModule<
      ProbeReadRequest,
      { readonly snapshot: "module-owned" },
      ProbeApplyRequest,
      { readonly receipt: "module-owned"; readonly eventSequence: 7 }
    > = {
      read: async (context) => {
        observed.push(context);
        return { snapshot: "module-owned" };
      },
      apply: async (context) => {
        observed.push(context);
        return { receipt: "module-owned", eventSequence: 7 };
      },
    };
    const adapters = (["electron_host", "loopback_http", "native_cli", "agent"] as const).map(
      (adapter, index) =>
        bindInProcessModule(module, () => ({
          profileId: "profile-1",
          libraryId: "library-1",
          projectId: "project-1",
          connectionId: `connection-${index + 1}`,
          adapter,
        })),
    );
    const readRequest: ProbeReadRequest = {
      read: { kind: "metadata" },
    };
    const applyRequest: ProbeApplyRequest = {
      operationId: "operation-1",
      storeEpoch: "epoch-1",
      intent: { kind: "rename_project", projectId: "project-1", name: "Project" },
    };

    expect(await adapters[0]?.read(readRequest)).toEqual({
      snapshot: "module-owned",
    });
    expect(await adapters[1]?.read(readRequest)).toEqual({
      snapshot: "module-owned",
    });
    expect(await adapters[2]?.apply(applyRequest)).toEqual({
      receipt: "module-owned",
      eventSequence: 7,
    });
    await adapters[3]?.read(readRequest);

    expect(observed.map(({ adapter, connectionId }) => ({ adapter, connectionId }))).toEqual([
      { adapter: "electron_host", connectionId: "connection-1" },
      { adapter: "loopback_http", connectionId: "connection-2" },
      { adapter: "native_cli", connectionId: "connection-3" },
      { adapter: "agent", connectionId: "connection-4" },
    ]);
    expect(readRequest).not.toHaveProperty("profileId");
    expect(applyRequest).not.toHaveProperty("libraryId");
  });
});
