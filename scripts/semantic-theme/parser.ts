import {
  transform,
  type Declaration,
  type Rule,
  type Selector,
  type StyleSheet,
} from "lightningcss";

import type {
  SemanticThemeCssFacts,
  SemanticThemeTarget,
  SemanticThemeVariableDefinition,
  SemanticThemeVariableReference,
  SemanticThemeVariableUse,
} from "./types";

interface CssRuleContext {
  readonly layerNames: readonly string[];
  readonly mediaDepth: number;
  readonly supportsDepth: number;
}

interface FilterCssOptions {
  readonly declarationPredicate?: (declaration: Declaration) => boolean;
  readonly keepKeyframes?: ReadonlySet<string>;
  readonly keepPropertyRules?: ReadonlySet<string>;
  readonly selectorFingerprints: ReadonlySet<string>;
  readonly styleContextPredicate?: (context: CssRuleContext) => boolean;
}

const SEMANTIC_THEME_TARGETS = [
  "electron-light",
  "electron-dark",
  "browser-light",
  "browser-dark",
  "extension-light",
  "extension-dark",
] as const satisfies readonly SemanticThemeTarget[];

const EMPTY_CONTEXT: CssRuleContext = {
  layerNames: [],
  mediaDepth: 0,
  supportsDepth: 0,
};

const sanitizeSourceCss = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const omittedWhitespace = Symbol("omitted-css-whitespace");

/** Compare parsed CSS values by tokens, not formatter-owned whitespace trivia. */
const normalizeCssValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .map(normalizeCssValue)
      .filter(
        (item): item is Exclude<typeof item, typeof omittedWhitespace> =>
          item !== omittedWhitespace,
      );
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Readonly<Record<string, unknown>>;
  const tokenValue = record.value;
  if (
    record.type === "token" &&
    tokenValue !== null &&
    typeof tokenValue === "object" &&
    (tokenValue as Readonly<Record<string, unknown>>).type === "white-space"
  ) {
    return omittedWhitespace;
  }

  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      const normalized = normalizeCssValue(item);
      return normalized === omittedWhitespace ? [] : [[key, normalized]];
    }),
  );
};

const semanticValueKey = (value: unknown): string => JSON.stringify(normalizeCssValue(value));

export const parseStylesheet = (css: string): StyleSheet => {
  let stylesheet: StyleSheet | null = null;

  transform({
    filename: "reference.css",
    code: Buffer.from(sanitizeSourceCss(css)),
    minify: false,
    analyzeDependencies: false,
    visitor: {
      StyleSheet(sheet) {
        stylesheet = sheet;
      },
    },
  });

  if (stylesheet === null) {
    throw new Error("Unable to parse the theme source.");
  }

  return stylesheet;
};

export const selectorFingerprint = (selector: Selector): string => JSON.stringify(selector);

const parseSelectorFingerprints = (selectorText: string): readonly string[] => {
  const stylesheet = parseStylesheet(`${selectorText} { color: red; }`);
  const firstRule = stylesheet.rules[0];
  if (firstRule?.type !== "style") {
    throw new Error("Unable to parse a configured selector.");
  }

  return firstRule.value.selectors.map(selectorFingerprint);
};

export const collectSelectorFingerprints = (selectors: readonly string[]): ReadonlySet<string> => {
  const fingerprints = new Set<string>();
  for (const selector of selectors) {
    for (const fingerprint of parseSelectorFingerprints(selector)) {
      fingerprints.add(fingerprint);
    }
  }
  return fingerprints;
};

export const customPropertyName = (declaration: Declaration): string | null =>
  declaration.property === "custom" ? declaration.value.name : null;

const hasDeclarations = (rule: Extract<Rule, { type: "style" }>): boolean => {
  const declarations = rule.value.declarations;
  return (
    (declarations?.declarations?.length ?? 0) > 0 ||
    (declarations?.importantDeclarations?.length ?? 0) > 0
  );
};

const isEmptyRuleContainer = (rule: Rule): boolean => {
  if (
    rule.type !== "layer-block" &&
    rule.type !== "supports" &&
    rule.type !== "media" &&
    rule.type !== "container" &&
    rule.type !== "scope" &&
    rule.type !== "starting-style"
  ) {
    return false;
  }
  return rule.value.rules.length === 0;
};

const keyframeName = (rule: Extract<Rule, { type: "keyframes" }>): string | null =>
  rule.value.name.type === "ident" ? rule.value.name.value : null;

const propertyRuleName = (rule: Extract<Rule, { type: "property" }>): string => rule.value.name;

const isAllowedStyleRule = (
  rule: Extract<Rule, { type: "style" }>,
  fingerprints: ReadonlySet<string>,
): boolean =>
  rule.value.selectors.some((selector) => fingerprints.has(selectorFingerprint(selector)));

const isWindowVariantArbitraryPropertySelector = (selector: Selector): boolean => {
  if (selector.length !== 2) return false;
  const [classNode, whereNode] = selector;
  if (
    classNode?.type !== "class" ||
    whereNode?.type !== "pseudo-class" ||
    whereNode.kind !== "where"
  ) {
    return false;
  }

  const windowType = classNode.name.startsWith("browser:[")
    ? "browser"
    : classNode.name.startsWith("electron:[")
      ? "electron"
      : classNode.name.startsWith("extension:[")
        ? "extension"
        : null;
  if (!windowType) return false;

  const nestedSelector = whereNode.selectors?.[0];
  if (!nestedSelector || nestedSelector.length !== 3) return false;
  const [attributeNode, combinatorNode, nestedClassNode] = nestedSelector;
  return (
    attributeNode?.type === "attribute" &&
    attributeNode.name === "data-codex-window-type" &&
    attributeNode.operation?.value === windowType &&
    combinatorNode?.type === "combinator" &&
    combinatorNode.value === "descendant" &&
    nestedClassNode?.type === "class" &&
    nestedClassNode.name === classNode.name
  );
};

export const filterCss = (css: string, options: FilterCssOptions): string => {
  const layerNames: string[] = [];
  const filteredStyleRules = new Set<string>();
  let filteredStyleDepth = 0;
  let mediaDepth = 0;
  let supportsDepth = 0;

  const ruleLocationKey = (rule: Extract<Rule, { type: "style" }>): string =>
    `${rule.value.loc.source_index}:${rule.value.loc.line}:${rule.value.loc.column}`;

  const result = transform({
    filename: "reference.css",
    code: Buffer.from(sanitizeSourceCss(css)),
    minify: false,
    analyzeDependencies: false,
    visitor: {
      Rule(rule) {
        if (rule.type === "layer-block") {
          layerNames.push((rule.value.name ?? []).join("."));
          return;
        }
        if (rule.type === "supports") {
          supportsDepth += 1;
          return;
        }
        if (rule.type === "media") {
          mediaDepth += 1;
          return;
        }
        if (rule.type === "style") {
          const context: CssRuleContext = {
            layerNames,
            mediaDepth,
            supportsDepth,
          };
          const selectorAllowed = isAllowedStyleRule(rule, options.selectorFingerprints);
          if (!selectorAllowed || !(options.styleContextPredicate?.(context) ?? true)) {
            return [];
          }
          filteredStyleRules.add(ruleLocationKey(rule));
          filteredStyleDepth += 1;
          return;
        }
        if (rule.type === "keyframes") {
          const name = keyframeName(rule);
          return name && options.keepKeyframes?.has(name) ? undefined : [];
        }
        if (rule.type === "property") {
          return options.keepPropertyRules?.has(propertyRuleName(rule)) ? undefined : [];
        }
        if (
          rule.type === "font-face" ||
          rule.type === "font-feature-values" ||
          rule.type === "font-palette-values" ||
          rule.type === "import" ||
          rule.type === "namespace" ||
          rule.type === "unknown" ||
          rule.type === "custom"
        ) {
          return [];
        }
      },
      Declaration(declaration) {
        if (filteredStyleDepth === 0 || !options.declarationPredicate) return;
        return options.declarationPredicate(declaration) ? undefined : [];
      },
      RuleExit(rule) {
        if (rule.type === "style") {
          const key = ruleLocationKey(rule);
          if (filteredStyleRules.delete(key)) filteredStyleDepth -= 1;
          return hasDeclarations(rule) ? undefined : [];
        }
        if (rule.type === "layer-block") {
          layerNames.pop();
        } else if (rule.type === "supports") {
          supportsDepth -= 1;
        } else if (rule.type === "media") {
          mediaDepth -= 1;
        }
        return isEmptyRuleContainer(rule) ? [] : undefined;
      },
    },
  });

  let output = Buffer.from(result.code).toString("utf8").trim();
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const cleaned = transform({
      filename: "generated.css",
      code: Buffer.from(output),
      minify: false,
      analyzeDependencies: false,
      visitor: {
        Rule(rule) {
          return isEmptyRuleContainer(rule) ? [] : undefined;
        },
      },
    });
    const next = Buffer.from(cleaned.code).toString("utf8").trim();
    if (next === output) break;
    output = next;
  }
  return output;
};

const CUSTOM_PROPERTY_PATTERN = /(?<=[{;])\s*(--[A-Za-z0-9_.\\-]+)\s*:\s*([^;}]*)/g;

export const extractCustomPropertyMap = (css: string): Map<string, string> => {
  const declarations = new Map<string, string>();
  for (const match of css.matchAll(CUSTOM_PROPERTY_PATTERN)) {
    const name = match[1];
    const value = match[2]?.replace(/\s+/g, " ").trim();
    if (!name || !value) continue;
    declarations.set(name, value);
  }
  return declarations;
};

export const extractDeclarations = (
  css: string,
  selectors: readonly string[],
  propertyNames: readonly string[],
  contextPredicate: (context: CssRuleContext) => boolean = () => true,
): Map<string, string> => {
  const propertySet = new Set(propertyNames);
  const filtered = filterCss(css, {
    selectorFingerprints: collectSelectorFingerprints(selectors),
    styleContextPredicate: contextPredicate,
    declarationPredicate: (declaration) => {
      const name = customPropertyName(declaration);
      return name !== null && propertySet.has(name);
    },
  });
  return extractCustomPropertyMap(filtered);
};

export const extractDeclarationsByPrefix = (
  css: string,
  selectors: readonly string[],
  prefixes: readonly string[],
  contextPredicate: (context: CssRuleContext) => boolean = () => true,
): Map<string, string> => {
  const filtered = filterCss(css, {
    selectorFingerprints: collectSelectorFingerprints(selectors),
    styleContextPredicate: contextPredicate,
    declarationPredicate: (declaration) => {
      const name = customPropertyName(declaration);
      return name !== null && prefixes.some((prefix) => name.startsWith(prefix));
    },
  });
  return extractCustomPropertyMap(filtered);
};

export const extractVarReferences = (css: string): ReadonlySet<string> =>
  new Set(Array.from(css.matchAll(/var\((--[A-Za-z0-9_.\\-]+)/g), (match) => match[1]));

export const assertExportSafeCss = (css: string): void => {
  if (/sourceMappingURL|\/\*!|@import\b|url\s*\(/i.test(css)) {
    throw new Error("THEME_EXPORT_UNSAFE_VALUE");
  }
};

const collectObjectVariableReferences = (
  value: unknown,
): readonly SemanticThemeVariableReference[] => {
  const references: SemanticThemeVariableReference[] = [];
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    const record = current as Readonly<Record<string, unknown>>;
    if (record.type === "var") {
      const variable = record.value as Readonly<Record<string, unknown>> | undefined;
      const nameRecord = variable?.name as Readonly<Record<string, unknown>> | undefined;
      if (typeof nameRecord?.ident === "string") {
        references.push({
          name: nameRecord.ident,
          hasFallback: variable?.fallback !== null && variable?.fallback !== undefined,
        });
      }
      visit(variable?.fallback);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return references;
};

interface SelectorTargetMatch {
  readonly constrained: boolean;
  readonly matches: boolean;
}

const UNCONSTRAINED_TARGET: SelectorTargetMatch = { constrained: false, matches: true };

/** Preserve selector unions, negations, and nested appearance scopes in the finite target graph. */
const selectorTargetMatch = (value: unknown, target: SemanticThemeTarget): SelectorTargetMatch => {
  if (!value || typeof value !== "object") return UNCONSTRAINED_TARGET;
  if (Array.isArray(value)) {
    const parts = value.map((part) => selectorTargetMatch(part, target));
    return {
      constrained: parts.some((part) => part.constrained),
      matches: parts.every((part) => part.matches),
    };
  }

  const [windowType, scheme] = target.split("-");
  const record = value as Readonly<Record<string, unknown>>;
  if (record.type === "attribute") {
    const operation = record.operation as Readonly<Record<string, unknown>> | undefined;
    if (record.name === "data-codex-window-type" && typeof operation?.value === "string") {
      const requested = operation.value === "chrome-extension" ? "extension" : operation.value;
      return { constrained: true, matches: requested === windowType };
    }
    if (
      record.name === "data-theme" &&
      (operation?.value === "light" || operation?.value === "dark")
    ) {
      return { constrained: true, matches: operation.value === scheme };
    }
    return UNCONSTRAINED_TARGET;
  }
  if (record.type === "class") {
    if (record.name === "electron-light" || record.name === "electron-dark") {
      return { constrained: true, matches: record.name === target };
    }
    if (record.name === "dark") return { constrained: true, matches: scheme === "dark" };
    if (typeof record.name === "string" && record.name.includes("color-scheme:light")) {
      return { constrained: true, matches: scheme === "light" };
    }
    return UNCONSTRAINED_TARGET;
  }
  if (record.type !== "pseudo-class" || !Array.isArray(record.selectors)) {
    return UNCONSTRAINED_TARGET;
  }

  const branches = record.selectors.map((branch) => selectorTargetMatch(branch, target));
  const constrained = branches.some((branch) => branch.constrained);
  if (!constrained) return UNCONSTRAINED_TARGET;
  const matches = branches.some((branch) => branch.matches);
  return { constrained, matches: record.kind === "not" ? !matches : matches };
};

const selectorTargets = (selector: Selector): ReadonlySet<SemanticThemeTarget> =>
  new Set(SEMANTIC_THEME_TARGETS.filter((target) => selectorTargetMatch(selector, target).matches));

const selectorsContainRoot = (selectors: readonly Selector[]): boolean => {
  let containsRoot = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || containsRoot) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (record.type === "pseudo-class" && (record.kind === "root" || record.kind === "host")) {
      containsRoot = true;
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(selectors);
  return containsRoot;
};

const selectorCoverage = (
  selectors: readonly Selector[],
): {
  readonly scopeKind: SemanticThemeVariableDefinition["scopeKind"];
  readonly selectorKey: string;
  readonly targets: readonly SemanticThemeTarget[];
} => {
  const targets = new Set<SemanticThemeTarget>();
  for (const selector of selectors) {
    for (const target of selectorTargets(selector)) targets.add(target);
  }
  const allTargets = targets.size === SEMANTIC_THEME_TARGETS.length;
  const isRoot = selectorsContainRoot(selectors);
  return {
    scopeKind: isRoot && allTargets ? "root" : allTargets ? "local" : "scoped",
    selectorKey: selectors.map(selectorFingerprint).join("|"),
    targets: [...targets].sort(),
  };
};

const conditionFromDepth = (
  supportsDepth: number,
  mediaDepth: number,
): SemanticThemeVariableDefinition["condition"] =>
  supportsDepth > 0 ? "supports" : mediaDepth > 0 ? "media" : "base";

const collectThemeRuleFacts = (
  rule: Extract<Rule, { type: "unknown" }>,
  artifactPath: string,
): SemanticThemeCssFacts => {
  if (rule.value.name !== "theme" || !rule.value.block) return { definitions: [], uses: [] };
  const definitions: SemanticThemeVariableDefinition[] = [];
  const uses: SemanticThemeVariableUse[] = [];
  const tokens = rule.value.block;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== "dashed-ident") continue;
    const name = token.value;
    const valueTokens: unknown[] = [];
    for (index += 1; index < tokens.length; index += 1) {
      const valueToken = tokens[index];
      if (valueToken?.type === "token" && valueToken.value.type === "semicolon") break;
      valueTokens.push(valueToken);
    }
    const references = collectObjectVariableReferences(valueTokens);
    definitions.push({
      name,
      artifactPath,
      condition: "base",
      scopeKind: "root",
      selectorKey: "@theme",
      targets: SEMANTIC_THEME_TARGETS,
      valueKey: semanticValueKey(valueTokens),
      references,
    });
    for (const reference of references) {
      uses.push({
        artifactPath,
        condition: "base",
        ownerName: name,
        selectorKey: "@theme",
        targets: SEMANTIC_THEME_TARGETS,
        reference,
      });
    }
  }
  return { definitions, uses };
};

/**
 * Extracts the scoped custom-property graph used by source-free and compiled
 * theme verification. Target coverage is intentionally finite: every exported
 * declaration must be valid in each supported window/scheme combination.
 */
export const collectSemanticThemeCssFacts = (
  css: string,
  artifactPath: string,
): SemanticThemeCssFacts => {
  const definitions: SemanticThemeVariableDefinition[] = [];
  const uses: SemanticThemeVariableUse[] = [];
  const styleStack: ReturnType<typeof selectorCoverage>[] = [];
  let supportsDepth = 0;
  let mediaDepth = 0;

  transform({
    filename: artifactPath,
    code: Buffer.from(sanitizeSourceCss(css)),
    minify: false,
    analyzeDependencies: false,
    visitor: {
      Rule(rule) {
        if (rule.type === "supports") supportsDepth += 1;
        if (rule.type === "media") mediaDepth += 1;
        if (rule.type === "style") styleStack.push(selectorCoverage(rule.value.selectors));
        if (rule.type === "property") {
          definitions.push({
            name: rule.value.name,
            artifactPath,
            condition: conditionFromDepth(supportsDepth, mediaDepth),
            scopeKind: "root",
            selectorKey: "@property",
            targets: SEMANTIC_THEME_TARGETS,
            valueKey: semanticValueKey(rule.value.initialValue),
            references: collectObjectVariableReferences(rule.value.initialValue),
          });
        }
        if (rule.type === "unknown") {
          const themeFacts = collectThemeRuleFacts(rule, artifactPath);
          definitions.push(...themeFacts.definitions);
          uses.push(...themeFacts.uses);
        }
      },
      Declaration(declaration) {
        const coverage = styleStack.at(-1) ?? {
          scopeKind: "root" as const,
          selectorKey: "@global",
          targets: SEMANTIC_THEME_TARGETS,
        };
        const condition = conditionFromDepth(supportsDepth, mediaDepth);
        const references = collectObjectVariableReferences(declaration);
        if (declaration.property === "custom") {
          definitions.push({
            name: declaration.value.name,
            artifactPath,
            condition,
            scopeKind: coverage.scopeKind,
            selectorKey: coverage.selectorKey,
            targets: coverage.targets,
            valueKey: semanticValueKey(declaration.value.value),
            references,
          });
        }
        for (const reference of references) {
          uses.push({
            artifactPath,
            condition,
            ...(declaration.property === "custom" ? { ownerName: declaration.value.name } : {}),
            selectorKey: coverage.selectorKey,
            targets: coverage.targets,
            reference,
          });
        }
      },
      RuleExit(rule) {
        if (rule.type === "style") styleStack.pop();
        if (rule.type === "supports") supportsDepth -= 1;
        if (rule.type === "media") mediaDepth -= 1;
      },
    },
  });

  return { definitions, uses };
};

export const contextWithoutConditions = (context: CssRuleContext): boolean =>
  context.supportsDepth === 0 && context.mediaDepth === 0;

export const contextWithinSupports = (context: CssRuleContext): boolean =>
  context.supportsDepth > 0;

export { EMPTY_CONTEXT, isWindowVariantArbitraryPropertySelector };
