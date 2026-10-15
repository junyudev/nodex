import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useOwnedBlockDocument,
  useRegisteredOwnedBlockDocument,
  type OwnedBlockDocumentQueryDependencies,
} from "@/lib/owned-block-document-query";
import type {
  OwnedBlockDocumentModel,
  RegisteredOwnedBlockDocumentModel,
} from "@/lib/owned-block-document";
import { queryKeys } from "@/lib/query-keys";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";

export interface OwnedBlockDocumentBoundaryControls {
  /**
   * Drops the current descriptor result and prepares it again. This is the
   * authority-boundary reload used after a store epoch or generation reset.
   */
  readonly reload: () => Promise<void>;
}

export interface OwnedBlockDocumentBoundaryProps {
  readonly routingContext: ContentRoutingContext;
  readonly ownerBlockId: string;
  readonly dependencies?: OwnedBlockDocumentQueryDependencies;
  readonly children: (
    model: OwnedBlockDocumentModel,
    controls: OwnedBlockDocumentBoundaryControls,
  ) => ReactNode;
}

export interface RegisteredOwnedBlockDocumentBoundaryProps extends Omit<
  OwnedBlockDocumentBoundaryProps,
  "children"
> {
  readonly children: (
    model: RegisteredOwnedBlockDocumentModel,
    controls: OwnedBlockDocumentBoundaryControls,
  ) => ReactNode;
}

/**
 * The single renderer query boundary for a Block-owned document. Consumers
 * must branch on the explicit authority model; there is intentionally no
 * inferred document ID or legacy fallback hidden inside this component.
 */
export function OwnedBlockDocumentBoundary({
  routingContext,
  ownerBlockId,
  dependencies,
  children,
}: OwnedBlockDocumentBoundaryProps) {
  const queryClient = useQueryClient();
  const model = useOwnedBlockDocument({ routingContext, ownerBlockId }, dependencies);

  const reload = async (): Promise<void> => {
    await queryClient.resetQueries({
      queryKey: queryKeys.blockDocuments.owned(routingContext, ownerBlockId),
      exact: true,
    });
  };

  return children(model, { reload });
}

/** Registry-dispatched boundary for every supported document-bearing Block. */
export function RegisteredOwnedBlockDocumentBoundary({
  routingContext,
  ownerBlockId,
  dependencies,
  children,
}: RegisteredOwnedBlockDocumentBoundaryProps) {
  const queryClient = useQueryClient();
  const model = useRegisteredOwnedBlockDocument({ routingContext, ownerBlockId }, dependencies);

  const reload = async (): Promise<void> => {
    await queryClient.resetQueries({
      queryKey: queryKeys.blockDocuments.owned(routingContext, ownerBlockId),
      exact: true,
    });
  };

  return children(model, { reload });
}
