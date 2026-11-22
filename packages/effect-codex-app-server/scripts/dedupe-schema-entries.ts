/**
 * Each JSON Schema root carries its own copy of every definition it references, so one wire type
 * such as `Thread` arrives as dozens of identical `<Root>__Thread` schemas. Constructing them all
 * costs every process that loads the protocol tens of megabytes. Nested definitions that are
 * structurally equal, including everything they reference, are emitted once and the rest alias
 * the first; root schemas keep their own identity.
 *
 * Entries are `export type Name = ...;\nexport const Name = ...;` pairs in emission order, which
 * already places every directly referenced schema first, so an alias never precedes its target.
 */
export function dedupeSchemaEntries(
  entries: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const names = [...entries.keys()];
  const known = new Set(names);
  const nested = (name: string) => name.includes("__");
  const shapes = new Map(
    names.map((name) => {
      const references: string[] = [];
      const body = entries.get(name)!.replace(/\b[A-Za-z_$][\w$]*\b/g, (token) => {
        if (token === name) return "\u0000self";
        if (!known.has(token)) return token;
        references.push(token);
        return "\u0000ref";
      });
      return [name, { body, references }] as const;
    }),
  );
  // Partition refinement: start from each nested definition's own name and text, then split
  // classes until every member also references members of the same classes.
  let classes = new Map(
    names.map((name) => [
      name,
      nested(name)
        ? `${name.slice(name.lastIndexOf("__") + 2)}\u0001${shapes.get(name)!.body}`
        : `\u0001${name}`,
    ]),
  );
  for (;;) {
    const ids = new Map<string, string>();
    const next = new Map<string, string>();
    for (const name of names) {
      const key = nested(name)
        ? `${classes.get(name)}\u0002${shapes
            .get(name)!
            .references.map((reference) => classes.get(reference))
            .join("\u0003")}`
        : `\u0001${name}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = String(ids.size);
        ids.set(key, id);
      }
      next.set(name, id);
    }
    const stable = new Set(next.values()).size === new Set(classes.values()).size;
    classes = next;
    if (stable) break;
  }
  const canonical = new Map<string, string>();
  const result = new Map<string, string>();
  for (const name of names) {
    const id = classes.get(name)!;
    const first = canonical.get(id);
    if (first === undefined) {
      canonical.set(id, name);
      result.set(name, entries.get(name)!);
    } else result.set(name, `export type ${name} = ${first};\nexport const ${name} = ${first};`);
  }
  return result;
}
