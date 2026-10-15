import { expect, test } from "vite-plus/test";
import {
  buildAgentRuntimeAttachmentSource,
  parseAgentRuntimeAttachmentSource,
} from "./agent-runtime-attachments";

test("attachment descriptors preserve original item identity without manufacturing a filesystem path", () => {
  const reference = {
    sourceThreadId: "source/thread",
    itemId: "user:item/1",
    attachmentId: "image-asset",
  };
  expect(parseAgentRuntimeAttachmentSource(buildAgentRuntimeAttachmentSource(reference))).toEqual(
    reference,
  );
  expect(parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/%zz")).toBeNull();
  expect(
    parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/image/extra"),
  ).toBeNull();
  expect(parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/%00")).toBeNull();
  expect(parseAgentRuntimeAttachmentSource("/tmp/attachment.png")).toBeNull();
});
