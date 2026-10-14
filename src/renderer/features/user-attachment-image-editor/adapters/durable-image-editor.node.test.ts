import { describe, expect, test } from "vite-plus/test";
import { normalizeUserAttachmentImageEditorOptions } from "../model/feature-policy";
import { WorkbenchImageEditorSurfaceConfigSchema } from "../../../../shared/schemas/workbench-image-editor";
import {
  createWorkbenchImageEditorSurfaceConfig,
  materializeWorkbenchImageEditorSurfaceConfig,
  restoreNormalizedImageEditorOptions,
} from "./durable-image-editor";

function uploadedOptions(source: string) {
  return normalizeUserAttachmentImageEditorOptions({
    alt: "User attachment",
    attachmentId: "attachment-1",
    attachmentSrc: source,
    composerTarget: {
      channelId: "AppScope:app/ThreadScope:session:session-1::root",
      placement: "root",
    },
    openInEditor: true,
    projectId: null,
    src: source,
    threadId: null,
  });
}

describe("durable image editor config", () => {
  test("accepts stable managed, local, pointer, and remote locators", () => {
    const sources = [
      "nodex://assets/image-1",
      "/Users/test/image.png",
      "file-service://image/one",
      "https://example.com/image.png",
    ];

    expect(
      sources.map(
        (source) =>
          createWorkbenchImageEditorSurfaceConfig(uploadedOptions(source))?.images[0]?.locator.kind,
      ),
    ).toEqual(["managed", "local", "pointer", "remote"]);
  });

  test("refuses transient data and object URLs before materialization", () => {
    expect(
      createWorkbenchImageEditorSurfaceConfig(uploadedOptions("data:image/png;base64,AA==")),
    ).toBeNull();
    expect(
      createWorkbenchImageEditorSurfaceConfig(
        uploadedOptions("blob:https://nodex.local/transient"),
      ),
    ).toBeNull();
    expect(
      createWorkbenchImageEditorSurfaceConfig(uploadedOptions("nodex://assets/folder/image.png")),
    ).toBeNull();
  });

  test("rejects a materializer result that is not a canonical managed asset", async () => {
    await expect(
      materializeWorkbenchImageEditorSurfaceConfig(uploadedOptions("data:image/png;base64,AA=="), {
        materialize: async () => "nodex://assets/folder/image.png",
      }),
    ).resolves.toBeNull();
  });

  test("materializes a data URL once and restores runtime editor options", async () => {
    const config = await materializeWorkbenchImageEditorSurfaceConfig(
      uploadedOptions("data:image/png;base64,AA=="),
      {
        materialize: async (image) => {
          expect(image.id).toBe("attachment-1");
          return "nodex://assets/materialized-image";
        },
      },
    );

    expect(config?.images[0]?.locator).toEqual({
      kind: "managed",
      source: "nodex://assets/materialized-image",
    });
    expect(restoreNormalizedImageEditorOptions(config!, "Pinned attachment")).toMatchObject({
      composerTarget: {
        channelId: "AppScope:app/ThreadScope:session:session-1::root",
        placement: "root",
      },
      images: [
        {
          attachmentSrc: "nodex://assets/materialized-image",
          managedSource: "nodex://assets/materialized-image",
          src: "nodex://assets/materialized-image",
        },
      ],
      openInEditor: true,
      title: "Pinned attachment",
    });
  });

  test("preserves generated collection order and view state", () => {
    const source = "sediment://image/one";
    const options = normalizeUserAttachmentImageEditorOptions({
      alt: "Generated image 2",
      attachmentSrc: source,
      generatedImages: [1, 2].map((ordinal) => ({
        alt: `Generated image ${ordinal}`,
        attachmentSrc: `sediment://image/${ordinal}`,
        generatedOrdinal: ordinal,
        groupId: "turn-1",
        id: `generated-${ordinal}`,
        source: "generated" as const,
        src: `sediment://image/${ordinal}`,
        status: "ready" as const,
      })),
      imageSource: "generated",
      initialImageId: "generated-2",
      initialView: "playground",
      openInEditor: true,
      src: source,
    });

    const config = createWorkbenchImageEditorSurfaceConfig(options);
    const restored = restoreNormalizedImageEditorOptions(config!, "Generated image 2");

    expect(restored.initialView).toBe("playground");
    expect(restored.generatedImages?.map((image) => image.id)).toEqual([
      "generated-1",
      "generated-2",
    ]);
    expect(restored.generatedImages?.[1]).toMatchObject({
      generatedOrdinal: 2,
      groupId: "turn-1",
      status: "ready",
    });
  });
});
test("read-only tabs keep their permission through pin and restoration", () => {
  const options = normalizeUserAttachmentImageEditorOptions({
    src: "nodex://assets/read-only-image",
    attachmentSrc: "nodex://assets/read-only-image",
    alt: "View",
    readOnly: true,
    openInEditor: true,
  });
  const config = createWorkbenchImageEditorSurfaceConfig(options)!;
  expect(config.readOnly).toBe(true);
  const persisted = WorkbenchImageEditorSurfaceConfigSchema.parse(
    JSON.parse(JSON.stringify(config)),
  );
  expect(restoreNormalizedImageEditorOptions(persisted, "View").readOnly).toBe(true);
});
