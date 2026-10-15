import { resolveRendererTransport } from "./renderer-transport";
import { INTERACTIVE_PROJECTION_REPAIR_BURST } from "./causal-projection-runtime";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";

let rendererRegistry: ProjectionInvalidationRegistry | null = null;

/**
 * Renderer-lifetime projection authority. External stores are not owned by a
 * React tree, so their causal subscriptions must not depend on Provider
 * mount/cleanup ordering (including StrictMode's lifecycle probe).
 */
export const getRendererProjectionInvalidationRegistry = () => {
  rendererRegistry ??= new ProjectionInvalidationRegistry({
    effectRepairBurst: INTERACTIVE_PROJECTION_REPAIR_BURST,
    subscribeProjection: (scope, listener) =>
      resolveRendererTransport().subscribeProjectionStream(scope, listener),
  });
  return rendererRegistry;
};
