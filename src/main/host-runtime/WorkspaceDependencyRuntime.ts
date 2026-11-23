import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { WorkspaceDependencies } from "../../shared/workspace-dependency-runtime";
import type { AppComponents } from "../app-components/AppComponents";
import {
  readWorkspaceDependencyBundle,
  type WorkspaceDependencyBundleInput,
} from "../platform/node/WorkspaceDependencyBundle";

export class WorkspaceDependencyRuntime extends Context.Service<
  WorkspaceDependencyRuntime,
  {
    readonly read: Effect.Effect<WorkspaceDependencies>;
  }
>()("nodex/main/host-runtime/WorkspaceDependencyRuntime") {}

// Give a slow connection time to download the runtime while bounding each Agent tool call.
const DOCUMENT_TOOLS_INSTALL_WAIT = "3 minutes";

export const live = (
  input: Omit<WorkspaceDependencyBundleInput, "root"> & { readonly root: string | null },
  components?: Pick<AppComponents["Service"], "ensure"> & { readonly manifestSha256: string },
) =>
  Layer.effect(
    WorkspaceDependencyRuntime,
    Effect.gen(function* () {
      const available = yield* Ref.make<{
        root: string;
        result: Extract<WorkspaceDependencies, { status: "available" }>;
      } | null>(null);
      const read = Effect.gen(function* (): Effect.fn.Return<WorkspaceDependencies> {
        if (!input.node) return { status: "unavailable", reason: "node_unavailable" };
        let root = input.root;
        if (components) {
          // AppComponents owns installation. The timeout interrupts only this caller's wait.
          const installed = yield* components
            .ensure("document-tools")
            .pipe(Effect.timeoutOption(DOCUMENT_TOOLS_INSTALL_WAIT));
          if (Option.isNone(installed))
            return {
              status: "unavailable",
              reason: "installing",
              message: "Document Tools are still downloading. Retry shortly.",
            };
          if (installed.value.status === "unavailable") {
            return installed.value.reason === "turned-off"
              ? {
                  status: "unavailable",
                  reason: "not_installed",
                  message: "Document Tools are turned off in Settings → General → Add-ons.",
                }
              : { status: "unavailable", reason: "invalid_bundle" };
          }
          root = installed.value.root;
        }
        // Recheck availability above even when this process has already verified the installed files.
        if (!root) return { status: "unavailable", reason: "not_installed" };
        const cached = yield* Ref.get(available);
        if (cached?.root === root) return cached.result;
        const result = yield* Effect.promise((signal) =>
          readWorkspaceDependencyBundle(
            { ...input, root },
            {
              signal,
              manifestSha256: components?.manifestSha256,
              installedComponent: !!components,
            },
          ),
        );
        if (result.status === "available") yield* Ref.set(available, { root, result });
        return result;
      });
      return WorkspaceDependencyRuntime.of({ read });
    }),
  );
