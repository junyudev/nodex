import {
  PROVIDER_SLUG_MAX_CHARS,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const ProviderDeclarationsInput = Schema.Unknown.pipe(
  Schema.refine(Predicate.isObject, { expected: "a map of provider declarations" }),
);

const decodeId = Schema.decodeUnknownOption(ProviderInstanceId);
const decodeEnvelope = Schema.decodeUnknownResult(ProviderInstanceConfig, { reportInput: false });
const decodeDriver = Schema.decodeUnknownOption(ProviderDriverKind);
const decodeDisplayName = Schema.decodeUnknownOption(ProviderInstanceConfig.fields.displayName);
const unknownDriver = ProviderDriverKind.make("unknown");
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Admits Host declarations independently before policy or driver materialization. */
export const admit = Effect.fnUntraced(function* (
  declarations: typeof ProviderDeclarationsInput.Type,
): Effect.fn.Return<ProviderInstanceConfigMap> {
  const admitted: Array<readonly [ProviderInstanceId, ProviderInstanceConfig]> = [];
  for (const [rawId, input] of Object.entries(declarations)) {
    const id = decodeId(rawId);
    // An invalid spelling must never replace a valid row after normalization.
    if (Option.isNone(id) || id.value !== rawId) {
      yield* Effect.logError(
        `Dropped provider declaration with an invalid instance ID. Use 1–${PROVIDER_SLUG_MAX_CHARS} ASCII letters, digits, underscores or hyphens, starting with a letter.`,
      );
      continue;
    }
    const decoded = decodeEnvelope(input);
    if (decoded._tag === "Success") {
      const entry = decoded.success;
      admitted.push([id.value, entry.unavailable ? { ...entry, enabled: false } : entry]);
      continue;
    }

    // The envelope schema only reports fixed fields and array indexes. Input reporting is
    // disabled so rejected environment values and other credentials stay on the private pipe.
    const issue = formatIssues(decoded.failure.issue).issues[0];
    const path = issue?.path?.join(".");
    const message =
      `Invalid Agent configuration${path ? ` at ${path}` : ""}. ${issue?.message ?? ""}`.trim();
    const row = Predicate.isObject(input) ? input : {};
    const driver = Option.getOrElse(decodeDriver(row.driver), () => unknownDriver);
    const displayName = Option.getOrUndefined(decodeDisplayName(row.displayName));
    admitted.push([
      id.value,
      {
        driver,
        ...(displayName === undefined ? {} : { displayName }),
        ...(row.source === "nodex" ? { source: row.source } : {}),
        enabled: false,
        unavailable: { message },
      },
    ]);
  }
  return Object.fromEntries(admitted);
});
