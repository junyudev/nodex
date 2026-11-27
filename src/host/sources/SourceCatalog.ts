import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectWorkspaceReadSnapshot } from "../../main/core-client/types";
import type { CoreModules } from "../../main/core-runtime/CoreModules";

type Model = components["schemas"];

export class SourceCatalogError extends Schema.TaggedError<SourceCatalogError>()(
  "SourceCatalogError",
  { message: Schema.String },
) {}

const unavailable = () => new SourceCatalogError({ message: "Could not read GitHub connections." });

/** Reads saved Library configuration without starting or synchronizing Source producers. */
export const readSources = (core: CoreModules["Service"]) =>
  Effect.gen(function* () {
    const sources: Model["Source"][] = [];
    let after: string | null = null;
    while (true) {
      const snapshot: ProjectWorkspaceReadSnapshot = yield* core.workspace
        .read(
          { kind: "sources", read: { kind: "sources", after_id: after, limit: 100 } },
          undefined,
          null,
        )
        .pipe(Effect.mapError(unavailable));
      const read = snapshot.value;
      if (read.kind !== "sources" || read.value.kind !== "sources") return yield* unavailable();
      const page = read.value.sources;
      sources.push(...page);
      const last = page.at(-1);
      if (!last || page.length < 100) return sources;
      after = last.id;
    }
  });
