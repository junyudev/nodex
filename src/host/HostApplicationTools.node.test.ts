import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import { createHostedAppToolCaller } from "../main/app-tools/AppToolCaller";
import { hostToolTestServices } from "../main/app-tools/host-tools.test-support";
import inputs from "../main/agent-runtime/host-tool-inputs.test-fixture.json";
import { HostWorkspace } from "./HostWorkspace";
import { make, hostAppToolCatalog } from "./HostApplicationTools";

const services = Layer.merge(hostToolTestServices, Layer.mock(HostWorkspace, {}));

const authority = {
  threadId: "thread",
  rootThreadId: "thread",
  turnId: "run",
  actorProjectId: null,
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1_000,
  runtime: { sessionId: "nodex", runtimeId: "runtime", turnKind: "run" as const },
};

it.effect.each(hostAppToolCatalog)(
  "routes advertised Host tool $name with valid arguments",
  (tool) =>
    Effect.gen(function* () {
      const args = (inputs as Record<string, Record<string, unknown>>)[tool.name];
      assert.isDefined(args, `Add a valid invocation for ${tool.name}`);
      assert.isTrue(z.fromJSONSchema(tool.inputSchema).safeParse(args).success, tool.name);
      if (Object.keys(tool.inputSchema.properties ?? {}).length) assert.isNotEmpty(args);
      // Revocation after Host admission stops side effects inside the real semantic handler.
      // A missing route instead hits the old generic invalid_arguments/context fallback.
      let captures = 0;
      const caller = createHostedAppToolCaller({
        backend: "codex",
        authority,
        callId: tool.name,
        generation: 1,
        isActive: () => true,
        capture: Effect.sync(() => (++captures === 1 ? authority : null)),
      });
      const execute = yield* make.pipe(Effect.provide(services));
      const result = yield* execute(caller, tool.name, args!);
      assert.notInclude(
        ["invalid_arguments", "tool_unavailable", "unknown_tool"],
        result.structuredContent?.error &&
          (result.structuredContent.error as { code: string }).code,
        tool.name,
      );
      if (
        ![
          "load_workspace_dependencies",
          "get_app_capabilities",
          "list_projects",
          "list_sidebar_sections",
          "list_sidebar_section_items",
          "list_sidebar_order",
        ].includes(tool.name)
      ) {
        assert.isAtLeast(captures, 2, `${tool.name} must reach its authority-owning handler`);
        assert.isTrue(result.isError, `${tool.name} must honor authority revocation`);
      }
    }),
);
