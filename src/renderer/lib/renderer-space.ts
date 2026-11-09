import type { SpaceConnectionSummary } from "../../shared/space-connection";

let binding: SpaceConnectionSummary | null = null;
const testBinding: SpaceConnectionSummary = {
  spaceId: "test-space",
  kind: "personal",
  memberId: null,
  name: "Personal",
  availability: "ready",
};

/** One renderer document belongs to exactly one Space for its whole lifetime.
 * Switching starts a new document after flushing the old document's owners. */
export function bindRendererSpace(space: SpaceConnectionSummary): void {
  if (binding && binding.spaceId !== space.spaceId)
    throw new Error("A renderer cannot change its Space authority");
  binding = space;
}

export function rendererSpace(): SpaceConnectionSummary {
  if (binding) return binding;
  if (import.meta.env.MODE === "test") return testBinding;
  throw new Error("Bind a Space before constructing renderer state");
}

export const rendererSpaceId = (): string => rendererSpace().spaceId;
export const isRemoteSpace = (): boolean => rendererSpace().kind === "team";
/** A device-local key that belongs to one Space and Member. */
export const spaceStorageKeyFor = (
  space: Pick<SpaceConnectionSummary, "spaceId" | "memberId">,
  key: string,
): string => JSON.stringify(["space", space.spaceId, space.memberId, key]);
export const spaceStorageKey = (key: string): string => spaceStorageKeyFor(rendererSpace(), key);
export const spaceQueryKey = <const Key extends readonly unknown[]>(
  key: Key,
): readonly ["space", string, ...Key] => ["space", rendererSpaceId(), ...key];
