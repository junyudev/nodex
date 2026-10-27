import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

type Resources = AgentRuntimeOperations["attachments.import"]["input"]["attachments"];

class MessageResourceError extends Schema.TaggedError<MessageResourceError>()(
  "MessageResourceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Inline media crosses the process boundary as private files, never aggregated base64. */
export const make = Effect.fn("AgentRuntimeMessageResources.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return {
    materialize: Effect.fn("AgentRuntimeMessageResources.materialize")(function* (
      resources: Resources,
    ) {
      if (!resources.some((resource) => resource.source.startsWith("data:"))) return resources;
      const limit = getProviderAttachmentLimitError(
        resources.map((resource) => ({
          ...resource,
          type: resource.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
        })),
      );
      if (limit) return yield* new MessageResourceError({ message: limit });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-message-" });
      return yield* Effect.forEach(resources, (resource, index) =>
        Effect.gen(function* () {
          if (!resource.source.startsWith("data:")) return resource;
          const maximumBytes = resource.mimeType.startsWith("image/")
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          if (resource.sizeBytes < 1 || resource.sizeBytes > maximumBytes)
            return yield* new MessageResourceError({
              message: "Attachment exceeds its byte budget",
            });
          const parsed = parseBase64DataUrl(resource.source);
          if (
            !parsed ||
            parsed.mimeType !== resource.mimeType.toLowerCase() ||
            parsed.base64.length > 4 * Math.ceil(maximumBytes / 3)
          )
            return yield* new MessageResourceError({
              message: "Attachment media payload is invalid",
            });
          // The canonical parser checks alphabet and padding before Buffer's permissive decoder.
          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength !== resource.sizeBytes)
            return yield* new MessageResourceError({
              message: "Attachment resource changed",
            });
          const source = path.join(directory, String(index));
          yield* fs.writeFile(source, bytes, { flag: "wx", mode: 0o400 });
          return { ...resource, source };
        }),
      );
    }),
  };
});
