import type { ReactNode } from "react";
import { vi } from "vite-plus/test";
import {
  NodexReferenceRouterProvider,
  NodexReferenceSourceProvider,
  type NodexReferenceRouter,
  type NodexReferenceSource,
} from "@/lib/nodex-reference-router";

/** A router that records what references ask to open, for surfaces under test. */
export function createTestNodexReferenceRouter() {
  const open = vi.fn<NodexReferenceRouter["open"]>(async () => "opened" as const);
  const router: NodexReferenceRouter = { open };
  const wrap = (children: ReactNode, source?: NodexReferenceSource) => (
    <NodexReferenceRouterProvider router={router}>
      {source ? (
        <NodexReferenceSourceProvider source={source}>{children}</NodexReferenceSourceProvider>
      ) : (
        children
      )}
    </NodexReferenceRouterProvider>
  );
  return { open, router, wrap };
}
