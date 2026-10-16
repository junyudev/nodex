import { parseTypeScriptSource } from "./oxc-source";

/** Keep the eager-entry boundary independent of formatting and minifier syntax. */
export function rendererBootstrapImports(file: string, source: string): readonly string[] {
  return parseTypeScriptSource(file, source).body.flatMap((statement) => {
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      statement.type === "ExportNamedDeclaration"
    ) {
      return statement.source ? [statement.source.value] : [];
    }
    return [];
  });
}
