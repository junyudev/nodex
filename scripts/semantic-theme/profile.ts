import type {
  SemanticThemeCollisionResolution,
  SemanticThemeExclusionProfile,
  SemanticThemeTarget,
  SemanticUtilityProfile,
} from "./types";

export const SEMANTIC_THEME_GENERATOR_VERSION = 2;
export const SEMANTIC_THEME_REF_VERSION = "26.810.41047";

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
  "--transition-duration-",
  "--transition-ease-",
] as const;

export const CONTRACT_DECLARATION_PREFIXES = [
  "--color-token-",
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
  "--color-text-success",
  "--color-text-warning",
  "--color-token-bg-fog",
  "--color-token-bg-primary",
  "--transition-duration-relaxed",
]);

export const CONTRACT_VALUE_NORMALIZATIONS = {
  "--color-background-danger-surface": "var(--vscode-inputValidation-errorBackground)",
  "--color-background-success-solid": "var(--vscode-charts-green)",
  "--color-background-success-surface":
    "color-mix(in oklab, var(--vscode-charts-green) 12%, transparent)",
  "--color-background-warning-surface": "var(--vscode-inputValidation-warningBackground)",
} as const;

export const UTILITY_VALUE_REPLACEMENTS = {
  "var(--ease-basic)": "var(--transition-ease-basic)",
} as const;

export const SURFACE_VALUE_REPLACEMENTS = {
  "var(--color-codex-description)": "var(--color-token-description-foreground)",
} as const;

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
    "--color-border",
    "--color-token-description-foreground",
    "--color-token-editor-background",
  ].map((name) => ({ name, targets: ELECTRON_TARGETS })),
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
  ".font-vscode-editor",
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
  ".\\[\\&_\\.ProseMirror\\]\\:focus-visible\\:outline-none .ProseMirror:focus-visible",
  ".\\[\\&_\\.ProseMirror\\]\\:h-auto .ProseMirror",
  ".\\[\\&_\\.ProseMirror\\]\\:min-h-\\[2rem\\] .ProseMirror",
  ".\\[\\&_\\.ProseMirror\\]\\:resize-none .ProseMirror",
  ".\\[\\&_\\.ProseMirror_p\\]\\:m-0 .ProseMirror p",
  ".\\[\\&_\\.contain-inline-size\\]\\:\\[contain\\:initial\\] .contain-inline-size",
  ".\\[\\&\\>\\*\\:first-child\\]\\:mt-0 > :first-child",
  ".\\[\\&\\>\\*\\:last-child\\]\\:mb-0 > :last-child",
  ".\\[\\&\\>ol\\:first-child\\]\\:mt-0 > ol:first-child",
  ".\\[\\&\\>ul\\:first-child\\]\\:mt-0 > ul:first-child",
  ".\\[\\&_\\*\\]\\:text-token-description-foreground\\/80 *",
  ".\\[\\&_\\*\\]\\:text-token-foreground\\/50 *",
] as const;

export const SURFACE_SELECTORS = [
  ".loading-shimmer-pure-text, .loading-shimmer",
  ".dark .loading-shimmer-pure-text, .dark .loading-shimmer",
  ".loading-shimmer:hover",
  ".loading-shimmer-pure-text-inverted",
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
    contract: CONTRACT_VALUE_NORMALIZATIONS,
    utility: UTILITY_VALUE_REPLACEMENTS,
    surface: SURFACE_VALUE_REPLACEMENTS,
  },
  runtimeProviders: SEMANTIC_THEME_RUNTIME_PROVIDERS,
  exclusions: SEMANTIC_THEME_EXCLUSIONS,
  requiredVariables: SEMANTIC_THEME_REQUIRED_VARIABLES,
  collisions: COLLISION_RESOLUTIONS,
  migratedSurfaces: MIGRATED_SURFACE_POLICIES,
} as const;
