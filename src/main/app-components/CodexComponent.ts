import type { CodexPackageUnavailableReason } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NODEX_MODELS } from "../../shared/nodex-models";
import type {
  AppComponentState,
  CodexComponentUnavailableReason,
} from "../../shared/app-components";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import type { CodexPackageAvailability } from "../codex/CodexPackage";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { AppComponents } from "./AppComponents";
import { CodexPlatform } from "../../host/ProviderPlatform";
import * as Stream from "effect/Stream";

export const hasCodexCreditModels = (
  models: readonly { readonly id: string; readonly protocol: string }[],
): boolean =>
  models.some(
    ({ id, protocol }) =>
      protocol === "openai" &&
      NODEX_MODELS.some((model) => model.id === id && model.protocol === protocol),
  );

export const needsCodexComponentForAccounts = (input: {
  readonly usesExternalExecutable: boolean;
  readonly accountPresent: boolean;
  readonly creditModels: readonly { readonly id: string; readonly protocol: string }[];
}): boolean =>
  (!input.usesExternalExecutable && input.accountPresent) ||
  hasCodexCreditModels(input.creditModels);

type SessionWindow = Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "session_window" }>;
export const hasCodexSession = (
  items: readonly Pick<SessionWindow["sessions"]["items"][number]["task"], "thread">[],
): boolean => items.some(({ thread }) => thread?.backend_binding.kind === "codex");

const turnedOff = "Codex is turned off in Settings → General → Components.";

const unavailable = (reason: CodexPackageUnavailableReason, message: string) =>
  ({ status: "unavailable", reason, message }) as const;

const installing = unavailable("installing", "Codex is still installing.");

export function codexComponentAvailability(
  component: AppComponentState | undefined,
  runtime: CodexPackageAvailability,
): CodexPackageAvailability {
  if (
    !component ||
    (runtime.status === "available" && runtime.package.source === "external") ||
    (runtime.status === "unavailable" && runtime.reason === "external-unusable")
  )
    return runtime;
  if (!component.enabled) return unavailable("turned-off", turnedOff);
  if (runtime.status === "available") return runtime;
  const { installation } = component;
  if (installation.status === "failed" && installation.retryAt === null)
    return unavailable("invalid", installation.message);
  if (installation.status === "on-demand" || installation.status === "not-installed")
    return runtime;
  return installing;
}

export const readCodexComponent = (components: Pick<AppComponents["Service"], "read">) =>
  components.read.pipe(Effect.map(({ components }) => components.find(({ id }) => id === "codex")));

/** The features that use the local Codex can offer setup only when this build offers it. */
export function codexComponentUnavailableReason(
  component: AppComponentState | undefined,
  runtime: CodexPackageAvailability,
): CodexComponentUnavailableReason | undefined {
  if (!component) return undefined;
  const availability = codexComponentAvailability(component, runtime);
  return availability.status === "unavailable" && availability.reason !== "external-unusable"
    ? availability.reason
    : undefined;
}

export const makeCodexComponentRequirement = Effect.gen(function* () {
  const components = Option.getOrUndefined(yield* Effect.serviceOption(AppComponents));
  const codex = Option.getOrUndefined(yield* Effect.serviceOption(CodexPlatform));
  if (!components || !codex || codex.usesExternalExecutable)
    return { read: Effect.succeed(undefined), changes: Stream.never };
  return {
    read: Effect.gen(function* () {
      const component = yield* readCodexComponent(components);
      if (!component) return undefined;
      return codexComponentUnavailableReason(
        component,
        yield* codex.ordinaryPackageAfterStartupCheck,
      );
    }),
    changes: components.changes.pipe(
      Stream.map(({ components }) => {
        const component = components.find(({ id }) => id === "codex");
        return component?.enabled ? component.installation.status : null;
      }),
      Stream.changes,
    ),
  };
});

export const codexAdmissionError = (
  failure: Extract<CodexPackageAvailability, { status: "unavailable" }>,
) =>
  new CodexRuntimeError({
    operation: "endpoint.admission",
    reason: "codex-unavailable",
    availabilityReason: failure.reason,
    message: failure.message,
    retryable: failure.reason === "installing",
    hostId: "local",
  });

export const ensureCodexComponent = (components: Pick<AppComponents["Service"], "ensure">) =>
  components.ensure("codex").pipe(
    Effect.flatMap((result) => {
      if (result.status === "installed" || result.reason === "not-offered") return Effect.void;
      return Effect.fail(
        codexAdmissionError(
          result.reason === "turned-off"
            ? unavailable("turned-off", turnedOff)
            : unavailable("invalid", result.message),
        ),
      );
    }),
  );

/** Passive account/catalog reads cannot make Codex wanted. A wanted install can finish in flight. */
export const admitCodexPackage = Effect.fnUntraced(function* (
  components: Pick<AppComponents["Service"], "read" | "ensure">,
  readPackage: Effect.Effect<CodexPackageAvailability>,
) {
  const availability = codexComponentAvailability(
    yield* readCodexComponent(components),
    yield* readPackage,
  );
  if (availability.status === "available") return availability.package;
  if (availability.reason !== "installing") return yield* codexAdmissionError(availability);
  const settled = yield* ensureCodexComponent(components).pipe(Effect.timeoutOption("4 seconds"));
  if (Option.isNone(settled)) return yield* codexAdmissionError(availability);
  const ready = codexComponentAvailability(
    yield* readCodexComponent(components),
    yield* readPackage,
  );
  if (ready.status === "available") return ready.package;
  return yield* codexAdmissionError(ready);
});
