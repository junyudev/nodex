import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { WorkbenchObservedTab } from "../../shared/nodex-app-tools/workbench";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { make } from "./WorkbenchTabDescription";

const tab: WorkbenchObservedTab = {
  tabId: "surface",
  panelId: "right",
  groupId: "group",
  protected: false,
  persisted: true,
  preview: false,
  selected: true,
  visible: true,
  auxiliary: null,
  surface: {
    id: "surface",
    kind: "page_file",
    titleSnapshot: "Stale",
    config: {
      routingContext: { kind: "library" },
      pageId: "page",
      fileId: "file",
      logicalPath: "old.html",
    },
  },
};
it.effect(
  "describes a Page File with canonical Page and File metadata and redacts unavailable content",
  () =>
    Effect.gen(function* () {
      for (const available of [true, false]) {
        const describe = yield* make.pipe(
          Effect.provideService(WorkbenchContentRouting, {
            describe: () => Effect.succeed({ status: "unavailable" }),
            describePageFile: () =>
              Effect.succeed(
                available
                  ? {
                      status: "available",
                      kind: "page_file",
                      title: "report.html",
                      libraryId: "library",
                      displayedRoutingContext: { kind: "library" },
                      pageId: "page",
                      pageTitle: "Report",
                      fileId: "file",
                      logicalPath: "output/report.html",
                    }
                  : { status: "unavailable" },
              ),
          }),
        );
        const result = yield* describe({
          observationId: "observation",
          tab,
          sceneOwner: { kind: "library" },
          authority: {} as NodexAgentTurnContext,
          callId: "call",
        });
        if (available) {
          assert.equal(result.kind, "page_file");
          assert.equal(result.pageId, "page");
          assert.equal(result.pageTitle, "Report");
          assert.equal(result.fileId, "file");
          assert.equal(result.logicalPath, "output/report.html");
          assert.equal(result.title, "report.html");
        } else {
          assert.equal(result.status, "unavailable");
          assert.notProperty(result, "pageId");
          assert.notProperty(result, "fileId");
          assert.notProperty(result, "title");
        }
      }
    }),
);
