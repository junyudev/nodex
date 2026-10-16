const rendererChunkRules = [
  {
    chunkName: "vendor-react",
    packageFragments: [
      "/node_modules/react/",
      "/node_modules/react-dom/",
      "/node_modules/scheduler/",
    ],
  },
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
] as const;

export function resolveRendererManualChunk(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");

  // Vite injects this helper into every chunk that owns a dynamic import.
  // Pinning it prevents large feature manual chunks from absorbing the helper
  // and becoming an eager dependency of the lightweight renderer entry.
  if (normalizedId === "\0vite/preload-helper.js") return "renderer-bootstrap-runtime";

  for (const rule of rendererChunkRules) {
    if (rule.packageFragments.some((fragment) => normalizedId.includes(fragment))) {
      return rule.chunkName;
    }
  }

  return undefined;
}

export function resolveRendererChunkFileName(moduleIds: readonly string[]): string {
  // Rolldown assigns its runtime before manual chunking and keeps it separate.
  // Only that pure helper chunk belongs to the lightweight bootstrap boundary.
  if (moduleIds.length === 1 && moduleIds[0] === "\0rolldown/runtime.js") {
    return "assets/renderer-bootstrap-runtime-[hash].js";
  }
  return "assets/[name]-[hash].js";
}
