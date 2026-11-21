import type { Rolldown } from "vite";

interface RendererChunkRule {
  readonly chunkName: string;
  readonly packageFragments: readonly string[];
}

// Runtime packages that ordinary surfaces and on-demand vendors share, highest priority
// first. Every group also captures the dependencies of the packages it matches, so a shared
// package needs an owner that outranks each group able to reach it. Otherwise it lands in
// whichever vendor reaches it first, and every module that uses it statically imports that
// whole vendor: a TypeScript helper inside Excalidraw loaded Excalidraw with every Workbench.
// React outranks the helpers because the store shim depends on it.
const sharedRuntimeChunkRules: readonly RendererChunkRule[] = [
  {
    chunkName: "vendor-react",
    packageFragments: [
      "/node_modules/react/",
      "/node_modules/react-dom/",
      "/node_modules/scheduler/",
    ],
  },
  {
    chunkName: "vendor-shared-helpers",
    packageFragments: ["/node_modules/tslib/", "/node_modules/use-sync-external-store/"],
  },
];

const featureChunkRules: readonly RendererChunkRule[] = [
  {
    chunkName: "vendor-editor-markdown",
    packageFragments: [
      "/node_modules/streamdown/",
      "/node_modules/@streamdown/",
      "/third_party/blocknote/packages/",
      "/node_modules/@blocknote/",
      "/node_modules/@tiptap/",
      "/node_modules/prosemirror-",
      "/node_modules/y-prosemirror/",
      "/node_modules/orderedmap/",
      "/node_modules/crelt/",
      "/node_modules/rope-sequence/",
    ],
  },
  {
    chunkName: "vendor-excalidraw",
    packageFragments: ["/node_modules/@excalidraw/excalidraw/"],
  },
  {
    chunkName: "vendor-cytoscape",
    packageFragments: ["/node_modules/cytoscape/", "/node_modules/cytoscape-cose-bilkent/"],
  },
];

const matchesRule = (rule: RendererChunkRule, id: string) => {
  const normalizedId = id.replaceAll("\\", "/");
  return rule.packageFragments.some((fragment) => normalizedId.includes(fragment));
};

function resolveFeatureChunk(id: string): string | undefined {
  // Vite injects this helper into every chunk that owns a dynamic import.
  // Pinning it prevents large feature manual chunks from absorbing the helper
  // and becoming an eager dependency of the lightweight renderer entry.
  if (id === "\0vite/preload-helper.js") return "renderer-bootstrap-runtime";
  return featureChunkRules.find((rule) => matchesRule(rule, id))?.chunkName;
}

export function resolveRendererManualChunk(id: string): string | undefined {
  return (
    sharedRuntimeChunkRules.find((rule) => matchesRule(rule, id))?.chunkName ??
    resolveFeatureChunk(id)
  );
}

export const rendererCodeSplitting = {
  groups: [
    ...sharedRuntimeChunkRules.map((rule, index) => ({
      name: rule.chunkName,
      priority: sharedRuntimeChunkRules.length - index,
      test: (id: string) => matchesRule(rule, id),
    })),
    { name: (id: string) => resolveFeatureChunk(id) ?? null },
  ],
} satisfies Rolldown.CodeSplittingOptions;

export function resolveRendererChunkFileName(moduleIds: readonly string[]): string {
  // Rolldown assigns its runtime before manual chunking and keeps it separate.
  // Only that pure helper chunk belongs to the lightweight bootstrap boundary.
  if (moduleIds.length === 1 && moduleIds[0] === "\0rolldown/runtime.js") {
    return "assets/renderer-bootstrap-runtime-[hash].js";
  }
  return "assets/[name]-[hash].js";
}
