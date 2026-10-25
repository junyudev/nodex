import {
  CONTRACT_NODEX_OWNED_PROPERTIES,
  CONTRACT_DECLARATION_PREFIXES,
  CONTRACT_SOURCE_SELECTORS,
  ELECTRON_BODY_PROPERTIES,
  FOUNDATION_BROWSER_OVERRIDES,
  FOUNDATION_ELECTRON_OVERRIDES,
  FOUNDATION_ROOT_FALLBACKS,
  FOUNDATION_SOURCE_SELECTORS,
  FOUNDATION_THEME_NORMALIZATIONS,
  FOUNDATION_THEME_PROPERTIES,
  LEGACY_UTILITY_SELECTORS,
  ROOT_FOUNDATION_PROPERTIES,
  SEMANTIC_THEME_ARTIFACT_PATHS,
  SEMANTIC_THEME_RUNTIME_VARIABLES,
  SEMANTIC_UTILITY_PROFILE,
  SURFACE_SELECTORS,
} from "./profile";
import {
  assertExportSafeCss,
  collectSemanticThemeCssFacts,
  collectSelectorFingerprints,
  contextWithoutConditions,
  customPropertyName,
  extractCustomPropertyMap,
  extractDeclarations,
  extractDeclarationsByPrefix,
  extractVarReferences,
  filterCss,
} from "./parser";
import type {
  SemanticThemeArtifact,
  SemanticThemeGeneratedContract,
  SemanticThemeTarget,
} from "./types";

const RUNTIME_TOKEN_AUGMENTATIONS = new Map<string, string>([
  ["--color-token-border-heavy", "var(--color-border-strong)"],
  [
    "--color-token-conversation-header",
    "color-mix(in oklab, var(--color-token-foreground) 30%, transparent)",
  ],
  [
    "--color-token-conversation-body",
    "color-mix(in oklab, var(--color-token-foreground) 60%, transparent)",
  ],
  [
    "--color-token-non-assistant-body-descendant",
    "color-mix(in oklab, var(--color-token-foreground) 50%, transparent)",
  ],
  [
    "--color-token-conversation-summary-leading",
    "color-mix(in oklab, var(--color-token-description-foreground) 90%, transparent)",
  ],
  [
    "--color-token-conversation-summary-trailing",
    "color-mix(in oklab, var(--color-token-foreground) 40%, transparent)",
  ],
]);

const HEADER = (refVersion: string): string => `/*
 * Generated semantic theme contract (refVersion ${refVersion}).
 * Do not edit by hand. Run:
 *   vp run semantic-theme:sync -- --source /temporary/reference.css --ref-version ${refVersion}
 */`;

const formatDeclarations = (declarations: ReadonlyMap<string, string>): string =>
  [...declarations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

const formatBlock = (selector: string, declarations: ReadonlyMap<string, string>): string =>
  declarations.size === 0 ? "" : `${selector} {\n${formatDeclarations(declarations)}\n}`;

const formatThemeBlock = (
  declarations: ReadonlyMap<string, string>,
  mode: "static" | "reference" = "static",
): string =>
  declarations.size === 0 ? "" : `@theme ${mode} {\n${formatDeclarations(declarations)}\n}`;

const mergeMaps = (...maps: readonly ReadonlyMap<string, string>[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (const map of maps) {
    for (const [name, value] of map) result.set(name, value);
  }
  return result;
};

const applyValues = (
  target: Map<string, string>,
  values: Readonly<Record<string, string>>,
): void => {
  for (const [name, value] of Object.entries(values)) target.set(name, value);
};

const extractFromCandidates = (
  sourceCss: string,
  selectors: readonly string[],
  properties: readonly string[],
  contextPredicate = contextWithoutConditions,
): Map<string, string> =>
  mergeMaps(
    ...selectors.map((selector) =>
      extractDeclarations(sourceCss, [selector], properties, contextPredicate),
    ),
  );

const renderFoundation = (sourceCss: string, refVersion: string): string => {
  const theme = extractFromCandidates(
    sourceCss,
    FOUNDATION_SOURCE_SELECTORS.theme,
    FOUNDATION_THEME_PROPERTIES,
  );
  applyValues(theme, FOUNDATION_THEME_NORMALIZATIONS);

  const root = extractFromCandidates(
    sourceCss,
    FOUNDATION_SOURCE_SELECTORS.root,
    ROOT_FOUNDATION_PROPERTIES,
  );
  applyValues(root, FOUNDATION_ROOT_FALLBACKS);

  const electronBody = extractFromCandidates(
    sourceCss,
    FOUNDATION_SOURCE_SELECTORS.electronBody,
    ELECTRON_BODY_PROPERTIES,
  );
  applyValues(electronBody, FOUNDATION_ELECTRON_OVERRIDES);
  const browser = extractFromCandidates(sourceCss, FOUNDATION_SOURCE_SELECTORS.browser, [
    "--height-toolbar",
  ]);
  applyValues(browser, FOUNDATION_BROWSER_OVERRIDES);
  const extension = extractFromCandidates(sourceCss, FOUNDATION_SOURCE_SELECTORS.extension, [
    "--diffs-font-size",
    "--text-heading-md",
  ]);

  return [
    HEADER(refVersion),
    formatThemeBlock(theme),
    formatBlock(":root", root),
    formatBlock('[data-codex-window-type="electron"] body', electronBody),
    formatBlock('[data-codex-window-type="browser"]', browser),
    formatBlock(':root[data-codex-window-type="extension"]', extension),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
};

const renderContract = (
  sourceCss: string,
  refVersion: string,
  consumerCss: readonly string[],
): string => {
  const theme = extractDeclarationsByPrefix(
    sourceCss,
    CONTRACT_SOURCE_SELECTORS.base,
    CONTRACT_DECLARATION_PREFIXES,
    contextWithoutConditions,
  );
  for (const name of CONTRACT_NODEX_OWNED_PROPERTIES) theme.delete(name);
  for (const [name, value] of RUNTIME_TOKEN_AUGMENTATIONS) theme.set(name, value);

  const sourceDeclarations = filterCss(sourceCss, {
    selectorFingerprints: collectSelectorFingerprints([
      ...CONTRACT_SOURCE_SELECTORS.base,
      ...CONTRACT_SOURCE_SELECTORS.scoped,
    ]),
    declarationPredicate: (declaration) => customPropertyName(declaration) !== null,
  });
  const facts = collectSemanticThemeCssFacts(sourceDeclarations, "source");
  const propertyNames = new Set([
    ...theme.keys(),
    ...SEMANTIC_THEME_RUNTIME_VARIABLES,
    ...facts.definitions
      .filter(({ name }) => CONTRACT_DECLARATION_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map(({ name }) => name),
    ...consumerCss.flatMap((css) => [...extractVarReferences(css)]),
  ]);
  const productFoundationNames = new Set<string>([
    ...FOUNDATION_THEME_PROPERTIES,
    ...ROOT_FOUNDATION_PROPERTIES,
    ...CONTRACT_NODEX_OWNED_PROPERTIES,
    "--corner-radius-scale",
    "--spacing",
    "--text-base",
    "--text-sm",
    "--text-xs",
    "--text-xl",
    "--text-2xl",
    "--text-3xl",
    "--text-4xl",
    "--text-heading-lg",
    "--radius-2xs-base",
    "--radius-xs-base",
    "--radius-sm-base",
    "--radius-md-base",
    "--radius-lg-base",
    "--radius-xl-base",
    "--radius-2xl-base",
    "--radius-3xl-base",
    "--radius-4xl-base",
    "--font-weight-normal",
    "--font-weight-medium",
    "--font-weight-semibold",
    "--font-weight-bold",
  ]);
  for (const name of productFoundationNames) propertyNames.delete(name);

  // Retain only providers reachable from exported roles, in their original scopes.
  let previousSize = -1;
  while (propertyNames.size !== previousSize) {
    previousSize = propertyNames.size;
    for (const definition of facts.definitions) {
      if (!propertyNames.has(definition.name)) continue;
      for (const reference of definition.references) {
        if (!productFoundationNames.has(reference.name)) propertyNames.add(reference.name);
      }
    }
  }
  const appearanceNames = new Set([
    "--theme-variant",
    "--lightningcss-light",
    "--lightningcss-dark",
  ]);
  const declarations = filterCss(sourceCss, {
    selectorFingerprints: collectSelectorFingerprints([
      ...CONTRACT_SOURCE_SELECTORS.base,
      ...CONTRACT_SOURCE_SELECTORS.scoped,
      ...CONTRACT_SOURCE_SELECTORS.appearance,
    ]),
    declarationPredicate: (declaration) => {
      const name = customPropertyName(declaration);
      return name !== null && (propertyNames.has(name) || appearanceNames.has(name));
    },
  });

  // Registration must not synthesize a :root rule above the source's zero-specificity cascade.
  // Source declarations publish their own runtime values; Nodex-only defaults use the same layer.
  const augmentations = `@layer theme {\n  ${formatBlock(":where(:root, :host)", RUNTIME_TOKEN_AUGMENTATIONS).replaceAll("\n", "\n  ")}\n}`;
  return [HEADER(refVersion), formatThemeBlock(theme, "reference"), augmentations, declarations]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
};

const UTILITY_PROPERTY_RULES = new Set([
  "--top-fade",
  "--bottom-fade",
  "--edge-fade-distance",
  "--left-fade",
  "--right-fade",
]);

const UTILITY_KEYFRAMES = new Set([
  "edge-fade",
  "edge-fade-top",
  "edge-fade-bottom",
  "edge-fade-horizontal",
]);

const renderUtilities = (sourceCss: string, refVersion: string): string => {
  const selectors = [
    ...LEGACY_UTILITY_SELECTORS,
    ...SEMANTIC_UTILITY_PROFILE.map((utility) => utility.selector),
  ];
  let css = filterCss(sourceCss, {
    selectorFingerprints: collectSelectorFingerprints(selectors),
    keepKeyframes: UTILITY_KEYFRAMES,
    keepPropertyRules: UTILITY_PROPERTY_RULES,
  });

  for (const utility of SEMANTIC_UTILITY_PROFILE) {
    if (!utility.outputSelector) continue;
    css = css.split(utility.selector).join(utility.outputSelector);
  }
  return `${HEADER(refVersion)}\n\n${css.trim()}\n`;
};

const renderSurfaces = (sourceCss: string, refVersion: string): string => {
  const extracted = filterCss(sourceCss, {
    selectorFingerprints: collectSelectorFingerprints(SURFACE_SELECTORS),
    keepKeyframes: new Set(["loading-shimmer"]),
  });
  return `${HEADER(refVersion)}\n\n${extracted.trim()}\n`;
};

const countPrefixDeclarations = (css: string, prefix: string): number =>
  [...extractCustomPropertyMap(css).keys()].filter((name) => name.startsWith(prefix)).length;

const renderManifest = (
  refVersion: string,
  artifacts: readonly SemanticThemeArtifact[],
): string => {
  const contractCss =
    artifacts.find((artifact) => artifact.path === SEMANTIC_THEME_ARTIFACT_PATHS.contract)
      ?.content ?? "";
  const manifest: SemanticThemeGeneratedContract = {
    schemaVersion: 1,
    refVersion,
    families: ["--vscode-", ...CONTRACT_DECLARATION_PREFIXES].map((prefix) => ({
      prefix,
      declarationCount: countPrefixDeclarations(contractCss, prefix),
    })),
    utilities: SEMANTIC_UTILITY_PROFILE.map((utility) => ({
      id: utility.id,
      selector: utility.outputSelector ?? utility.selector,
      dependencies: [...utility.tokenDependencies],
    })),
    variables: [
      ...artifacts
        .filter((artifact) => artifact.path.endsWith(".css"))
        .flatMap(
          (artifact) => collectSemanticThemeCssFacts(artifact.content, artifact.path).definitions,
        )
        .reduce(
          (variables, definition) => {
            const current = variables.get(definition.name) ?? {
              dependencies: new Set<string>(),
              owners: new Set<string>(),
              scopes: new Set<SemanticThemeTarget>(),
            };
            for (const reference of definition.references) current.dependencies.add(reference.name);
            current.owners.add(definition.artifactPath);
            for (const target of definition.targets) current.scopes.add(target);
            variables.set(definition.name, current);
            return variables;
          },
          new Map<
            string,
            {
              dependencies: Set<string>;
              owners: Set<string>;
              scopes: Set<SemanticThemeTarget>;
            }
          >(),
        ),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({
        name,
        scopes: [...value.scopes].sort(),
        dependencies: [...value.dependencies].sort(),
        owners: [...value.owners].sort(),
      })),
    artifacts: artifacts.map((artifact) => artifact.path),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

export const renderSemanticThemeArtifacts = (
  sourceCss: string,
  refVersion: string,
): readonly SemanticThemeArtifact[] => {
  const foundation = renderFoundation(sourceCss, refVersion);
  const utilities = renderUtilities(sourceCss, refVersion);
  const surfaces = renderSurfaces(sourceCss, refVersion);
  const cssArtifacts: SemanticThemeArtifact[] = [
    {
      path: SEMANTIC_THEME_ARTIFACT_PATHS.foundation,
      content: foundation,
    },
    {
      path: SEMANTIC_THEME_ARTIFACT_PATHS.contract,
      content: renderContract(sourceCss, refVersion, [foundation, utilities, surfaces]),
    },
    {
      path: SEMANTIC_THEME_ARTIFACT_PATHS.utilities,
      content: utilities,
    },
    {
      path: SEMANTIC_THEME_ARTIFACT_PATHS.surfaces,
      content: surfaces,
    },
  ];

  for (const artifact of cssArtifacts) {
    assertExportSafeCss(artifact.content);
  }

  const manifest: SemanticThemeArtifact = {
    path: SEMANTIC_THEME_ARTIFACT_PATHS.manifest,
    content: renderManifest(refVersion, cssArtifacts),
  };
  return [...cssArtifacts, manifest];
};
