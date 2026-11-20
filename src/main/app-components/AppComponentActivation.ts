import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AppComponentId } from "../../shared/app-components";

export type AppComponentActivationResult =
  | { readonly status: "active" }
  | { readonly status: "rejected"; readonly message: string };

/** Process-scoped admission for one Component's already published files. */
export interface AppComponentActivator {
  readonly activate: Effect.Effect<AppComponentActivationResult>;
  readonly isActive: Effect.Effect<boolean>;
}

/**
 * The seam between installing a component's files and the running features that use them.
 * The owner of each component's consumers implements it; the installer only publishes files.
 */
export class AppComponentActivation extends Context.Service<
  AppComponentActivation,
  {
    /**
     * Admit the files published at the component's store root into this process. A rejected
     * component stays unused, and the installer removes its files.
     */
    readonly activate: (id: AppComponentId) => Effect.Effect<AppComponentActivationResult>;
    /** Whether this process has handed the component's files to running consumers. */
    readonly isActive: (id: AppComponentId) => Effect.Effect<boolean>;
  }
>()("nodex/main/app-components/AppComponentActivation") {}
