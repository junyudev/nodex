import { createContext, useContext, useEffect, useEffectEvent, type ReactNode } from "react";
import {
  ProjectionInvalidationRegistry,
  type ProjectionFenceCause,
  type ProjectionInvalidationCause,
  type ProjectionRegistration,
} from "./projection-invalidation-registry";
import { getRendererProjectionInvalidationRegistry } from "./projection-invalidation-service";
import { projectionScopeKey } from "../../shared/projection-stream";

const ProjectionInvalidationContext = createContext<ProjectionInvalidationRegistry | null>(null);

export function ProjectionInvalidationProvider({
  children,
  registry: providedRegistry,
}: {
  readonly children: ReactNode;
  readonly registry?: ProjectionInvalidationRegistry;
}) {
  const registry = providedRegistry ?? getRendererProjectionInvalidationRegistry();
  return (
    <ProjectionInvalidationContext.Provider value={registry}>
      {children}
    </ProjectionInvalidationContext.Provider>
  );
}

export const useProjectionInvalidationRegistry = () => {
  const registry = useContext(ProjectionInvalidationContext);
  if (!registry) {
    throw new Error("Projection invalidation registry is unavailable");
  }
  return registry;
};

/**
 * Owns one React projection subscription by semantic identity. Query payloads
 * and callback closures stay live without replaying the scope checkpoint.
 */
export const useProjectionRegistration = (registration: ProjectionRegistration | null): void => {
  const registry = useProjectionInvalidationRegistry();
  const scopeKey = registration ? projectionScopeKey(registration.scope) : null;
  const consumerKey = registration?.consumerKey ?? null;
  const causalRuntime = registration?.causalRuntime;
  const projectionEffects = registration?.projectionEffects;
  const getDependencies = useEffectEvent(() => registration?.getDependencies() ?? {});
  const getCursor = useEffectEvent(() => registration?.getCursor() ?? null);
  const fence = useEffectEvent((cause: ProjectionFenceCause) => registration?.fence?.(cause));
  const invalidate = useEffectEvent((cause: ProjectionInvalidationCause) =>
    registration?.invalidate(cause),
  );
  const subscribe = useEffectEvent(() => {
    if (!registration) return;
    return registry.register({
      scope: registration.scope,
      consumerKey: registration.consumerKey,
      ...(registration.causalRuntime ? { causalRuntime: registration.causalRuntime } : {}),
      ...(registration.projectionEffects
        ? { projectionEffects: registration.projectionEffects }
        : {}),
      getDependencies,
      getCursor,
      fence,
      invalidate,
    });
  });

  useEffect(() => {
    return subscribe();
  }, [causalRuntime, consumerKey, projectionEffects, registry, scopeKey]);
};
