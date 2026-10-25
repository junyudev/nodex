import type {
  SemanticThemeCollisionResolution,
  SemanticThemeExclusionProfile,
  SemanticThemeTarget,
  SemanticUtilityProfile,
} from "./types";

export const SEMANTIC_THEME_GENERATOR_VERSION = 4;
export const SEMANTIC_THEME_REF_VERSION = "26.1007.30912";

export const SEMANTIC_THEME_TARGETS = [
  "electron-light",
  "electron-dark",
  "browser-light",
  "browser-dark",
  "extension-light",
  "extension-dark",
] as const satisfies readonly SemanticThemeTarget[];

export const SEMANTIC_THEME_ARTIFACT_PATHS = {
  foundation: "src/renderer/styles/theme-extracted-foundation.generated.css",
  contract: "src/renderer/styles/theme-semantic-contract.generated.css",
  utilities: "src/renderer/styles/theme-semantic-utilities.generated.css",
  surfaces: "src/renderer/styles/theme-extracted-surfaces.generated.css",
  manifest: "src/renderer/styles/semantic-theme-contract.generated.json",
  provenance: "src/renderer/styles/semantic-theme.provenance.json",
} as const;

export const SEMANTIC_DECLARATION_PREFIXES = [
  "--color-text",
  "--color-background-",
  "--color-border",
  "--color-icon-",
  "--color-surface",
  "--color-codex-",
  "--color-chart-",
  "--color-control-",
  "--transition-duration-",
  "--transition-ease-",
] as const;

export const CONTRACT_DECLARATION_PREFIXES = [
  "--color-token-",
  "--app-color-",
  ...SEMANTIC_DECLARATION_PREFIXES,
] as const;

export const FOUNDATION_THEME_PROPERTIES = [
  "--font-sans",
  "--font-mono",
  "--spacing-panel",
  "--radius-2xs",
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-2xl",
  "--radius-3xl",
  "--radius-4xl",
  "--padding-row-y",
  "--padding-row-x",
  "--padding-panel",
  "--padding-toolbar",
  "--height-toolbar",
  "--height-toolbar-sm",
  "--inset-toolbar",
  "--inset-toolbar-sm",
  "--spacing-token-sidebar",
  "--spacing-token-button-composer",
  "--spacing-token-button-composer-sm",
  "--spacing-token-button-composer-gap",
  "--spacing-token-safe-header-left",
  "--spacing-token-safe-header-right",
  "--h-token-button-composer-gap",
  "--cursor-interaction",
  "--thread-content-max-width",
  "--thread-composer-max-width",
  "--markdown-wide-block-max-width",
  "--text-heading-md",
  "--text-heading-lg",
  "--diffs-font-size",
] as const;

export const FOUNDATION_THEME_NORMALIZATIONS = {
  "--padding-row-y": "calc(var(--spacing) * 1)",
  "--padding-panel": "var(--padding-panel-base)",
  "--padding-toolbar": "calc(var(--spacing) * 4)",
  "--spacing-token-sidebar": "clamp(240px, 300px, min(520px, calc(100vw - 320px)))",
} as const;

export const FOUNDATION_ROOT_FALLBACKS = {
  "--padding-toolbar": "calc(var(--spacing) * 4)",
} as const;

export const FOUNDATION_ELECTRON_OVERRIDES = {
  "--thread-composer-max-width": "calc(var(--thread-content-max-width) + 1rem)",
  "--markdown-wide-block-max-width": "80rem",
  "--color-token-bg-fog": "var(--color-background-elevated-secondary)",
} as const;

export const FOUNDATION_BROWSER_OVERRIDES = {
  "--height-toolbar": "56px",
} as const;

export const CONTRACT_NODEX_OWNED_PROPERTIES = new Set([
  "--color-border",
  "--color-token-bg-fog",
  "--color-token-bg-primary",
  "--transition-duration-relaxed",
]);

export const SEMANTIC_THEME_RUNTIME_PROVIDERS = [
  {
    prefix: "--tw-",
    targets: SEMANTIC_THEME_TARGETS,
    reason: "Tailwind owns its registered utility runtime properties.",
  },
] as const;

export const SEMANTIC_THEME_EXCLUSIONS = [
  {
    scope: "application-menu-window",
    declarationPattern: "*",
    reason: "The desktop application-menu window is not a Nodex renderer target.",
    consumerStatus: "unsupported",
  },
] as const satisfies readonly SemanticThemeExclusionProfile[];

const ELECTRON_TARGETS = ["electron-light", "electron-dark"] as const;

// The accent overlay and its swatch controls choose these providers by preset and appearance.
export const SEMANTIC_THEME_RUNTIME_VARIABLES = [
  ...["blue", "green", "yellow", "pink", "orange", "purple"].flatMap((color) => [
    ...[75, 200, 400, 600, 800].map((tone) => `--${color}-${tone}`),
    `--brand-${color}-400`,
  ]),
  "--gray-fixed-1000",
] as const;

export const SEMANTIC_THEME_REQUIRED_VARIABLES = [
  ...[
    "--corner-radius-scale",
    "--radius-xs",
    "--radius-sm",
    "--radius-md",
    "--radius-lg",
    "--radius-xl",
    "--radius-2xl",
    "--radius-3xl",
    "--radius-4xl",
    "--height-toolbar",
    "--spacing-token-sidebar",
  ].map((name) => ({ name, targets: SEMANTIC_THEME_TARGETS })),
  ...[
    "--color-text",
    "--color-text-danger",
    "--color-text-info",
    "--color-text-secondary",
    "--color-text-tertiary",
    "--color-background-composer-primary",
    "--color-background-user-message",
    "--color-text-composer-primary",
    "--color-text-user-message",
    "--color-border",
    "--color-token-description-foreground",
    "--color-token-editor-background",
    "--color-chart-blue",
    "--color-control-thumb-on-accent",
    "--color-text-inverse",
    "--color-background-primary-solid",
    "--color-text-primary-solid",
  ].map((name) => ({ name, targets: ELECTRON_TARGETS })),
  ...SEMANTIC_THEME_RUNTIME_VARIABLES.map((name) => ({ name, targets: ELECTRON_TARGETS })),
] satisfies readonly {
  readonly name: string;
  readonly targets: readonly SemanticThemeTarget[];
}[];

export const ROOT_FOUNDATION_PROPERTIES = [
  "--padding-row-y",
  "--padding-panel-base",
  "--padding-panel",
  "--padding-toolbar",
  "--inset-toolbar",
  "--safe-area-left",
  "--safe-area-right",
  "--spacing-token-button-composer-sm",
  "--text-heading-md",
] as const;

export const ELECTRON_BODY_PROPERTIES = [
  "--padding-row-y",
  "--padding-panel-base",
  "--padding-panel",
  "--thread-content-max-width",
  "--thread-composer-max-width",
  "--markdown-wide-block-max-width",
  "--cursor-interaction",
  "--color-token-bg-fog",
  "--vscode-editor-font-family",
  "--vscode-font-size",
  "--vscode-editor-font-size",
  "--vscode-chat-font-size",
  "--vscode-chat-editor-font-size",
  "--spacing-token-button-composer-sm",
  "--text-heading-md",
] as const;

export const FOUNDATION_SOURCE_SELECTORS = {
  theme: [":root, :host"],
  root: [":root"],
  electronBody: [
    '[data-codex-window-type="electron"] body',
    ':is([data-codex-window-type="browser"], [data-codex-window-type="chrome-extension"], [data-codex-window-type="electron"]) body',
  ],
  browser: [
    '[data-codex-window-type="browser"]',
    ':is([data-codex-window-type="browser"], [data-codex-window-type="chrome-extension"]) body',
  ],
  extension: [
    ':root[data-codex-window-type="extension"]',
    ':root[data-codex-window-type="chrome-extension"]',
  ],
} as const;

export const CONTRACT_SOURCE_SELECTORS = {
  base: [
    ":root, :host",
    ":root",
    ":where(:root), :where([data-theme])",
    ":where(:root, [data-theme])",
  ],
  scoped: [
    ':where(:root:not([data-codex-window-type="extension"])), :where(:root:not([data-codex-window-type="extension"]) [data-theme])',
    ':is(:where(:root:not([data-codex-window-type="extension"])), :where(:root:not([data-codex-window-type="extension"]) [data-theme])):where([data-theme="dark"])',
    ':where(:root:not([data-codex-window-type="extension"])[data-theme="light"]), :where(:root:not([data-codex-window-type="extension"]) [data-theme="light"])',
    ':where(:root:not([data-codex-window-type="extension"]):not([data-theme]))',
    ':is(:where(:root), :where([data-theme])):where(:root[data-codex-window-type="browser"], :root[data-codex-window-type="browser"] *)',
    ':where(:root[data-codex-window-type="browser"], :root[data-codex-window-type="browser"] [data-theme])',
    '[data-codex-window-type="browser"]',
    '[data-codex-window-type="electron"]',
    ':root[data-codex-window-type="extension"]',
    ':root[data-codex-window-type="extension"], :root[data-codex-window-type="extension"] :where([data-theme])',
    ':is([data-codex-window-type="browser"], [data-codex-window-type="chrome-extension"], [data-codex-window-type="electron"]) body',
    '[data-codex-window-type="electron"].electron-opaque body',
    '[data-codex-window-type="electron"].electron-opaque :where([data-theme])',
  ],
  appearance: [
    ':where([data-theme="light"])',
    ':where([data-theme="dark"])',
    ".electron-dark",
    ".electron-light",
    ".\\[color-scheme\\:light\\]",
  ],
} as const;

export const SEMANTIC_UTILITY_PROFILE: readonly SemanticUtilityProfile[] = [
  {
    id: "text-info",
    selector: ".text-info",
    tokenDependencies: ["--color-text-info"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "text-danger",
    selector: ".text-danger",
    tokenDependencies: ["--color-text-danger"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "text-tertiary",
    selector: ".text-tertiary",
    tokenDependencies: ["--color-text-tertiary"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "semantic-text-secondary",
    selector: ".text-secondary",
    outputSelector: ".semantic-text-secondary",
    tokenDependencies: ["--color-text-secondary"],
    collisionStrategy: "collision-safe-alias",
    consumers: ["agent-task"],
  },
  {
    id: "border-default",
    selector: ".border-default",
    tokenDependencies: ["--color-border"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "bg-info-solid",
    selector: ".bg-info-solid",
    tokenDependencies: ["--color-background-info-solid"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "bg-text-info",
    selector: ".bg-text-info",
    tokenDependencies: ["--color-text-info"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  {
    id: "bg-text/10",
    selector: ".bg-text\\/10",
    tokenDependencies: ["--color-text"],
    collisionStrategy: "exact",
    consumers: ["agent-task"],
  },
  ...[
    { id: "bg-composer-primary", dependency: "--color-background-composer-primary" },
    { id: "text-composer-primary", dependency: "--color-text-composer-primary" },
    { id: "bg-user-message", dependency: "--color-background-user-message" },
    { id: "text-user-message", dependency: "--color-text-user-message" },
  ].map(({ id, dependency }) => ({
    id,
    selector: `.${id}`,
    tokenDependencies: [dependency],
    collisionStrategy: "exact" as const,
    consumers: ["conversation"],
  })),
  ...[
    { id: "bg-chart-blue", dependency: "--color-chart-blue" },
    { id: "bg-control-thumb-on-accent", dependency: "--color-control-thumb-on-accent" },
    { id: "border-control-thumb-on-accent", dependency: "--color-control-thumb-on-accent" },
    { id: "text-inverse", dependency: "--color-text-inverse" },
    { id: "bg-primary-solid", dependency: "--color-background-primary-solid" },
    { id: "text-primary-solid", dependency: "--color-text-primary-solid" },
  ].map(({ id, dependency }) => ({
    id,
    selector: `.${id}`,
    tokenDependencies: [dependency],
    collisionStrategy: "exact" as const,
    consumers: ["shared-controls"],
  })),
] as const;

export const LEGACY_UTILITY_SELECTORS = [
  ".\\@container\\/diff-header",
  ".\\@container\\/left-panel",
  ".icon-3xs",
  ".icon-xxs",
  ".icon-2xs",
  ".icon-xs",
  ".icon-sm",
  ".icon-base",
  ".icon-md",
  ".icon-lg",
  ".heading-4xl",
  ".heading-3xl",
  ".heading-2xl",
  ".heading-xl",
  ".heading-lg",
  ".heading-base",
  ".heading-dialog",
  ".heading-sm",
  ".heading-xs",
  ".contain-inline-size",
  ".text-size-chat",
  ".text-size-chat-sm",
  ".text-size-code",
  ".text-size-code-sm",
  ".px-toolbar",
  ".font-code",
  ".cursor-interaction",
  ".h-token-button-composer, .h-token-button-composer-sm",
  ".draggable",
  ".draggable button, .no-drag",
  ".duration-relaxed",
  ".ease-basic",
  ".scroll-contain",
  ".scrollbar-stable",
  ".horizontal-scroll-fade-mask",
  ".vertical-scroll-fade-mask",
  ".vertical-scroll-fade-mask-top",
  ".vertical-scroll-fade-mask-bottom",
  ".disambiguated-digits",
  ".disambig-digits.slashed-zero",
  ".\\[\\&_\\.contain-inline-size\\]\\:\\[contain\\:initial\\] .contain-inline-size",
  ".\\[\\&\\>\\*\\:first-child\\]\\:mt-0 > :first-child",
  ".\\[\\&\\>\\*\\:last-child\\]\\:mb-0 > :last-child",
  ".\\[\\&\\>ol\\:first-child\\]\\:mt-0 > ol:first-child",
  ".\\[\\&\\>ul\\:first-child\\]\\:mt-0 > ul:first-child",
] as const;

export const SURFACE_SELECTORS = [
  ".loading-shimmer-pure-text, .loading-shimmer",
  ":where(.loading-shimmer-pure-text, .loading-shimmer, .loading-shimmer-dot-grid)",
  ':is(.loading-shimmer-pure-text, .loading-shimmer):where([data-theme="dark"])',
  ":is(.loading-shimmer-pure-text, .loading-shimmer):where(:not([data-theme]))",
  ".loading-shimmer-working",
  ".loading-shimmer-on-color",
  ".loading-shimmer:hover",
  ".loading-shimmer-pure-text-inverted",
  '[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"]) :is([data-app-shell-frame][data-app-shell-workspace-tab-chrome], [data-app-shell-page-surface="true"], .app-shell-left-panel:not([data-app-shell-left-panel-appearance="content-surface"]))',
  '[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"]) :is([data-app-shell-frame][data-app-shell-workspace-tab-chrome], [data-app-shell-page-surface="true"], .app-shell-left-panel:not([data-app-shell-left-panel-appearance="content-surface"]))[data-app-shell-page-surface="true"]',
  '[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"]) :is([data-app-shell-frame][data-app-shell-workspace-tab-chrome], [data-app-shell-page-surface="true"]) .app-shell-left-panel:not([data-app-shell-left-panel-appearance="content-surface"])',
  '[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"]) .app-shell-left-panel:not([data-app-shell-left-panel-appearance="content-surface"])::after',
] as const;

export const COLLISION_RESOLUTIONS = {
  "--color-border": {
    kind: "nodex-owner",
    reason:
      "The product theme owns the canonical hairline border; generated semantic utilities consume it.",
  },
  "--diffs-font-size": {
    kind: "generated-owner",
  },
  "--color-secondary": {
    kind: "nodex-owner",
    reason: "Generic control surface color remains a Nodex-owned theme token.",
  },
  ".text-secondary": {
    kind: "alias",
    target: ".semantic-text-secondary",
  },
} as const satisfies Readonly<Record<string, SemanticThemeCollisionResolution>>;

export const MIGRATED_SURFACE_POLICIES = [
  {
    path: "src/renderer/components/workbench/pending-worktree-progress.tsx",
    forbiddenClassNames: [
      "text-token-text-tertiary",
      "text-[var(--color-text-accent)]",
      "bg-token-foreground/10",
      "bg-[var(--color-text-accent)]",
      "text-token-text-secondary",
      "border-token-border-default",
      "text-token-error-foreground",
    ],
  },
  {
    path: "src/renderer/features/local-conversation/view/shared/tools/worktree-init-activity-list.tsx",
    forbiddenClassNames: [
      "text-token-editor-error-foreground",
      "text-token-conversation-body",
      "text-token-conversation-summary-leading",
    ],
  },
  {
    path: "src/renderer/features/local-conversation/view/shared/tools/thread-command-shell-block.tsx",
    forbiddenClassNames: ["border-token-border-heavy"],
  },
  {
    path: "src/renderer/components/workbench/pending-worktree-route.tsx",
    forbiddenClassNames: ["text-token-description-foreground"],
  },
] as const;

export const SEMANTIC_THEME_PROFILE = {
  schemaVersion: 1,
  declarationPrefixes: CONTRACT_DECLARATION_PREFIXES,
  foundationProperties: FOUNDATION_THEME_PROPERTIES,
  utilities: SEMANTIC_UTILITY_PROFILE,
  surfaces: SURFACE_SELECTORS,
  normalizations: {
    foundationTheme: FOUNDATION_THEME_NORMALIZATIONS,
    foundationRoot: FOUNDATION_ROOT_FALLBACKS,
    foundationElectron: FOUNDATION_ELECTRON_OVERRIDES,
    foundationBrowser: FOUNDATION_BROWSER_OVERRIDES,
  },
  runtimeProviders: SEMANTIC_THEME_RUNTIME_PROVIDERS,
  runtimeVariables: SEMANTIC_THEME_RUNTIME_VARIABLES,
  sourceSelectors: CONTRACT_SOURCE_SELECTORS,
  exclusions: SEMANTIC_THEME_EXCLUSIONS,
  requiredVariables: SEMANTIC_THEME_REQUIRED_VARIABLES,
  collisions: COLLISION_RESOLUTIONS,
  migratedSurfaces: MIGRATED_SURFACE_POLICIES,
} as const;
