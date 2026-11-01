import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { make } from "./WorkbenchOpenTarget";

it.effect("resolves a Page File open target through canonical Page/File validation", () =>
  Effect.gen(function* () {
    const target = workbenchControlSchemas.open_tab.shape.target.parse({
      kind: "page_file",
      pageId: "page",
      fileId: "file",
    });
    for (const available of [true, false]) {
      const resolve = yield* make.pipe(
        Effect.provideService(ProjectWorkspace, {} as never),
        Effect.provideService(WorkbenchContentRouting, {
          describe: () => Effect.succeed({ status: "unavailable" }),
          describePageFile: ({ surface }) => {
            assert.equal(surface.config.pageId, "page");
            assert.equal(surface.config.fileId, "file");
            return Effect.succeed(
              available
                ? {
                    status: "available",
                    kind: "page_file",
                    title: "report.html",
                    pageId: "page",
                    pageTitle: "Report",
                    fileId: "file",
                    logicalPath: "output/report.html",
                    libraryId: "library",
                    displayedRoutingContext: { kind: "library" },
                  }
                : { status: "unavailable" },
            );
          },
        }),
      );
      const surface = yield* resolve({
        target,
        sceneOwner: { kind: "library" },
        operationId: "open",
        authority: {} as NodexAgentTurnContext,
        callId: "call",
      });
      assert.deepEqual(
        surface,
        available
          ? {
              kind: "page_file",
              titleSnapshot: "report.html",
              config: {
                routingContext: { kind: "library" },
                pageId: "page",
                fileId: "file",
                logicalPath: "output/report.html",
                titleSnapshot: "report.html",
              },
            }
          : null,
      );
    }
  }),
);
