import { execFileSync } from "node:child_process";
import { parseTypeScriptSource } from "../lib/oxc-source";
import type { IconGlyph } from "../../packages/mobile/src/ui/icon-glyphs";

// Pin the last handmade catalog so review exports still work after the replacement is committed.
const LEGACY_REVISION = "bad3cc9ca6272ea80322a0e3c2b9a7549fa9f863";

export function legacyMobileIcons(): Record<string, IconGlyph> {
  const source = execFileSync(
    "git",
    ["show", `${LEGACY_REVISION}:packages/mobile/src/ui/icons.tsx`],
    { encoding: "utf8" },
  );
  return parseLegacyMobileIcons(source);
}

/** Read only string literals and arrays, without evaluating historical source code. */
export function parseLegacyMobileIcons(source: string): Record<string, IconGlyph> {
  const declarations = parseTypeScriptSource("icons.tsx", source).body.flatMap((statement) =>
    statement.type === "VariableDeclaration" ? statement.declarations : [],
  );
  const glyphs: Record<string, IconGlyph> = {};
  for (const catalog of ["LINE_GLYPHS", "SOLID_GLYPHS"]) {
    const declaration = declarations.find(
      (node) => node.id.type === "Identifier" && node.id.name === catalog,
    );
    const object =
      declaration?.init?.type === "TSAsExpression"
        ? declaration.init.expression
        : declaration?.init;
    if (object?.type !== "ObjectExpression") throw new Error(`Missing legacy ${catalog}`);
    for (const property of object.properties) {
      if (property.type !== "Property" || property.key.type !== "Identifier" || property.computed)
        throw new Error(`Unsupported legacy property in ${catalog}`);
      const name = property.key.name;
      const values =
        property.value.type === "ArrayExpression" ? property.value.elements : [property.value];
      const paths = values.map((value) => {
        if (value?.type !== "Literal" || typeof value.value !== "string")
          throw new Error(`Unsupported legacy ${catalog}.${name}`);
        return {
          d: value.value,
          ...(catalog === "LINE_GLYPHS"
            ? {
                fill: "none" as const,
                stroke: "currentColor" as const,
                strokeWidth: 1.33,
                strokeLinecap: "round" as const,
                strokeLinejoin: "round" as const,
              }
            : {}),
        };
      });
      glyphs[name] = { viewBox: "0 0 20 20", paths };
    }
  }
  return glyphs;
}
