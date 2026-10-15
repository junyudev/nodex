import { queryOptions, useQuery } from "@tanstack/react-query";
import { prepareOwnedBlockDocumentForContentRouting } from "./api";
import {
  fetchOwnedBlockDocumentDescriptor,
  fetchRegisteredOwnedBlockDocumentDescriptor,
  makeOwnedBlockDocumentModel,
  makeRegisteredOwnedBlockDocumentModel,
  unwrapOwnedBlockDocumentPreparationResult,
  type OwnedDocumentDescriptorFetcher,
  type OwnedBlockDocumentModel,
  type OwnedBlockDocumentRequest,
  type RegisteredOwnedBlockDocumentModel,
} from "./owned-block-document";
import { queryKeys } from "./query-keys";

export interface OwnedBlockDocumentQueryDependencies {
  readonly fetchDescriptor?: OwnedDocumentDescriptorFetcher;
}

const defaultFetcher: OwnedDocumentDescriptorFetcher = (routingContext, ownerBlockId, signal) =>
  prepareOwnedBlockDocumentForContentRouting(routingContext, ownerBlockId).then((result) => {
    if (signal?.aborted) throw signal.reason;
    return unwrapOwnedBlockDocumentPreparationResult(result);
  });

const retryOwnedDocumentRead = (failureCount: number, error: unknown): boolean =>
  failureCount < 2 && error instanceof Error && "retryable" in error && error.retryable === true;

const ownedDocumentRetryDelay = (attemptIndex: number): number => (attemptIndex === 0 ? 250 : 750);

const makeOwnedBlockDocumentQueryFn =
  (request: OwnedBlockDocumentRequest, fetcher: OwnedDocumentDescriptorFetcher) =>
  async ({ signal }: { readonly signal: AbortSignal }) =>
    await fetchOwnedBlockDocumentDescriptor(request, (routingContext, ownerBlockId) =>
      fetcher(routingContext, ownerBlockId, signal),
    );

const makeRegisteredOwnedBlockDocumentQueryFn =
  (request: OwnedBlockDocumentRequest, fetcher: OwnedDocumentDescriptorFetcher) =>
  async ({ signal }: { readonly signal: AbortSignal }) =>
    await fetchRegisteredOwnedBlockDocumentDescriptor(request, (routingContext, ownerBlockId) =>
      fetcher(routingContext, ownerBlockId, signal),
    );

export const ownedBlockDocumentQueryOptions = (
  request: OwnedBlockDocumentRequest,
  dependencies: OwnedBlockDocumentQueryDependencies = {},
) => {
  const fetcher = dependencies.fetchDescriptor ?? defaultFetcher;
  return queryOptions({
    queryKey: queryKeys.blockDocuments.owned(request.routingContext, request.ownerBlockId),
    queryFn: makeOwnedBlockDocumentQueryFn(request, fetcher),
    retry: retryOwnedDocumentRead,
    retryDelay: ownedDocumentRetryDelay,
  });
};

export const registeredOwnedBlockDocumentQueryOptions = (
  request: OwnedBlockDocumentRequest,
  dependencies: OwnedBlockDocumentQueryDependencies = {},
) => {
  const fetcher = dependencies.fetchDescriptor ?? defaultFetcher;
  return queryOptions({
    queryKey: queryKeys.blockDocuments.owned(request.routingContext, request.ownerBlockId),
    queryFn: makeRegisteredOwnedBlockDocumentQueryFn(request, fetcher),
    retry: retryOwnedDocumentRead,
    retryDelay: ownedDocumentRetryDelay,
  });
};

export const useOwnedBlockDocument = (
  request: OwnedBlockDocumentRequest,
  dependencies: OwnedBlockDocumentQueryDependencies = {},
): OwnedBlockDocumentModel => {
  const query = useQuery(ownedBlockDocumentQueryOptions(request, dependencies));
  if (query.status === "pending") {
    if (query.failureReason) {
      return makeOwnedBlockDocumentModel(request, {
        status: "error",
        error: query.failureReason,
        retrying: true,
      });
    }
    return makeOwnedBlockDocumentModel(request, { status: "pending" });
  }
  if (query.status === "error") {
    return makeOwnedBlockDocumentModel(request, {
      status: "error",
      error: query.error,
      retrying: false,
    });
  }
  return makeOwnedBlockDocumentModel(request, {
    status: "success",
    data: query.data,
  });
};

export const useRegisteredOwnedBlockDocument = (
  request: OwnedBlockDocumentRequest,
  dependencies: OwnedBlockDocumentQueryDependencies = {},
): RegisteredOwnedBlockDocumentModel => {
  const query = useQuery(registeredOwnedBlockDocumentQueryOptions(request, dependencies));
  if (query.status === "pending") {
    if (query.failureReason) {
      return makeRegisteredOwnedBlockDocumentModel(request, {
        status: "error",
        error: query.failureReason,
        retrying: true,
      });
    }
    return makeRegisteredOwnedBlockDocumentModel(request, {
      status: "pending",
    });
  }
  if (query.status === "error") {
    return makeRegisteredOwnedBlockDocumentModel(request, {
      status: "error",
      error: query.error,
      retrying: false,
    });
  }
  return makeRegisteredOwnedBlockDocumentModel(request, {
    status: "success",
    data: query.data,
  });
};
