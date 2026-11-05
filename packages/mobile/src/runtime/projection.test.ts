import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { expect, it } from "vite-plus/test";
import { createProjection } from "./projection";

it("does not notify an atom or replace unchanged snapshots", () => {
  const item = { id: "message" };
  const projection = createProjection({ items: [item], loading: false });
  const registry = AtomRegistry.make();
  const initial = registry.get(projection.atom);
  const seen: unknown[] = [];
  const unsubscribe = registry.subscribe(projection.atom, (value) => seen.push(value), {
    immediate: false,
  });
  try {
    projection.setState({ loading: false });
    projection.setState({ ...initial }, true);
    expect(registry.get(projection.atom)).toBe(initial);
    expect(seen).toEqual([]);
    projection.setState({ loading: true });
    expect(seen).toHaveLength(1);
    expect(registry.get(projection.atom).items).toBe(initial.items);
    expect(registry.get(projection.atom).items[0]).toBe(item);
  } finally {
    unsubscribe();
    registry.dispose();
  }
});
