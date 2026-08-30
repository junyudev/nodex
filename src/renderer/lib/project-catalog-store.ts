import type { LocalCommitApply } from "../../shared/local-commit-delivery";
import type { ProjectUpdateCommandInput, ProjectUpdateInput } from "../../shared/types";
import {
  beginRendererOwnerTrace,
  recordRendererOwnerTrace,
  type RendererCausalTrace,
  type RendererCausalTraceContext,
} from "./renderer-causal-trace";
import type { Project, ProjectWindow } from "./types";

export type ProjectCatalogCanonicalSnapshot = Pick<
  ProjectWindow,
  "storeEpoch" | "projectionRevision"
> & {
  /** The oldest Project-window revision represented by `projects`. */
  readonly projects: readonly Project[];
};

export type ProjectCatalogUpdateCommand = ProjectUpdateCommandInput;

export interface ProjectCatalogUpdateFailure {
  readonly code: string;
  readonly message: string;
}

export type ProjectCatalogUpdateTransportResult =
  | {
      readonly kind: "acknowledged";
      readonly project: Project;
      readonly acknowledgement: LocalCommitApply;
    }
  | {
      readonly kind: "definitive_failure";
      readonly failure: ProjectCatalogUpdateFailure;
    }
  | {
      readonly kind: "unknown_outcome";
      readonly failure: ProjectCatalogUpdateFailure;
    };

export interface ProjectCatalogUpdatePort {
  readonly send: (
    command: ProjectCatalogUpdateCommand,
  ) => Promise<ProjectCatalogUpdateTransportResult>;
}

export type ProjectCatalogUpdateOutcome =
  | {
      readonly kind: "acknowledged";
      readonly project: Project;
    }
  | {
      readonly kind: "definitive_failure";
      readonly failure: ProjectCatalogUpdateFailure;
    }
  | {
      readonly kind: "unknown_outcome";
      readonly failure: ProjectCatalogUpdateFailure;
    }
  | { readonly kind: "superseded" };

export interface ProjectCatalogStoreSnapshot {
  readonly revision: number;
  readonly pendingCount: number;
  readonly unknownOutcomeCount: number;
  /** Stable while the exact materialized presentation candidate is unchanged. */
  readonly renderToken: number | null;
}

export interface ProjectCatalogStore {
  readonly getSnapshot: () => ProjectCatalogStoreSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Projects a pending name over either a catalog item or a detail query value. */
  readonly project: (project: Project | null) => Project | null;
  readonly projects: (projects: readonly Project[]) => readonly Project[];
  /** Installs presentation synchronously, before the transport Port is entered. */
  readonly renameProject: (projectId: string, name: string) => Promise<ProjectCatalogUpdateOutcome>;
  /** Updates Project metadata through the same ordered catalog lane. */
  readonly updateProject: (
    projectId: string,
    updates: ProjectUpdateInput,
  ) => Promise<ProjectCatalogUpdateOutcome>;
  /** Retries the latest unknown outcome for a Project with the exact same operation identity. */
  readonly retryProjectUpdate: (projectId: string) => Promise<ProjectCatalogUpdateOutcome | null>;
  /** Waits for this Project's current transport lane and returns its latest presentation. */
  readonly waitForProjectUpdates: (fallback: Project) => Promise<Project>;
  readonly publishCanonical: (snapshot: ProjectCatalogCanonicalSnapshot) => void;
  /** Settles only the materialization candidate represented by this exact token. */
  readonly markRendered: (renderToken: number) => void;
}

interface ProjectUpdateEntry {
  readonly operationId: string;
  readonly projectId: string;
  readonly updates: ProjectUpdateInput;
  readonly sequence: number;
  command: ProjectCatalogUpdateCommand | null;
  phase: "submitting" | "unknown" | "acknowledged";
  acknowledgement: LocalCommitApply | null;
  readonly trace: RendererCausalTraceContext | null;
}

interface RenderCandidate {
  readonly fingerprint: string;
  readonly operationIds: readonly string[];
  readonly token: number;
}

interface ProjectTransportGeneration {
  readonly id: number;
  readonly retired: Promise<void>;
  readonly retire: () => void;
  readonly tails: Map<string, Promise<void>>;
}

type ProjectPresentationKey = "name" | "description" | "appearance" | "sources";

const DEFAULT_MAX_RETAINED_UPDATES = 128;
const MAX_RETIRED_STORE_EPOCHS = 8;

const transportFailure = (cause: unknown): ProjectCatalogUpdateFailure => ({
  code: "transport_unknown_outcome",
  message: cause instanceof Error ? cause.message : "The Project update outcome is unknown",
});

const acknowledgementCoordinate = (
  acknowledgement: LocalCommitApply,
): { readonly storeEpoch: string; readonly commitSeq: number } =>
  acknowledgement.status === "committed"
    ? {
        storeEpoch: acknowledgement.commit.store_epoch,
        commitSeq: acknowledgement.commit.commit_seq,
      }
    : {
        storeEpoch: acknowledgement.observed.store_epoch,
        commitSeq: acknowledgement.observed.commit_head,
      };

function validCanonicalSnapshot(snapshot: ProjectCatalogCanonicalSnapshot): boolean {
  return (
    snapshot.storeEpoch.trim().length > 0 &&
    Number.isSafeInteger(snapshot.projectionRevision) &&
    snapshot.projectionRevision >= 0
  );
}

/**
 * Renderer-window owner for Project name presentation and its causal handoff.
 *
 * Canonical reads remain outside this Module. The Interface accepts their
 * stamped observations and hides local intent, exact retry, ordered transport,
 * acknowledgement, materialization, and rendered settlement from React leaves.
 */
export function createProjectCatalogStore({
  operationId,
  port,
  maxRetainedUpdates = DEFAULT_MAX_RETAINED_UPDATES,
  trace,
}: {
  readonly operationId: () => string;
  readonly port: ProjectCatalogUpdatePort;
  readonly maxRetainedUpdates?: number;
  readonly trace?: RendererCausalTrace;
}): ProjectCatalogStore {
  const retainedLimit = Math.max(1, Math.floor(maxRetainedUpdates));
  const listeners = new Set<() => void>();
  const entries = new Map<string, ProjectUpdateEntry>();
  const retiredStoreEpochs = new Set<string>();
  const createTransportGeneration = (id: number): ProjectTransportGeneration => {
    let retire!: () => void;
    const retired = new Promise<void>((resolve) => {
      retire = resolve;
    });
    return { id, retired, retire, tails: new Map() };
  };
  let transportGeneration = createTransportGeneration(0);
  let canonicalStoreEpoch: string | null = null;
  let canonicalProjectionRevision = -1;
  let canonicalProjects = new Map<string, Project>();
  const confirmedProjects = new Map<string, Project>();
  const transportBindingRevisions = new Map<string, number>();
  let entrySequence = 0;
  let nextRenderToken = 0;
  let renderCandidate: RenderCandidate | null = null;
  let snapshot: ProjectCatalogStoreSnapshot = {
    revision: 0,
    pendingCount: 0,
    unknownOutcomeCount: 0,
    renderToken: null,
  };

  const sortedEntries = (): ProjectUpdateEntry[] =>
    [...entries.values()].sort((left, right) => left.sequence - right.sequence);

  const applyUpdates = (value: Project, updates: ProjectUpdateInput): Project => {
    const next: Project = {
      ...value,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.appearance !== undefined ? { appearance: updates.appearance } : {}),
      ...(updates.sources !== undefined
        ? { sources: updates.sources.map((root, order) => ({ root, order })) }
        : {}),
    };
    return next.name === value.name &&
      next.description === value.description &&
      next.appearance === value.appearance &&
      next.sources === value.sources
      ? value
      : next;
  };

  const project = (value: Project | null): Project | null => {
    if (!value) return null;
    let presented = value;
    for (const entry of sortedEntries()) {
      if (entry.projectId === value.id) presented = applyUpdates(presented, entry.updates);
    }
    return presented;
  };

  const equalAppearance = (left: Project["appearance"], right: Project["appearance"]): boolean => {
    if (left.color !== right.color || left.marker.kind !== right.marker.kind) return false;
    if (left.marker.kind === "icon") {
      return right.marker.kind === "icon" && left.marker.icon === right.marker.icon;
    }
    return right.marker.kind === "emoji" && left.marker.emoji === right.marker.emoji;
  };

  const equalSources = (left: Project["sources"], right: readonly string[]): boolean =>
    left.length === right.length &&
    left.every((source, index) => source.order === index && source.root === right[index]);

  const materializesUpdates = (canonical: Project, updates: ProjectUpdateInput): boolean =>
    (updates.name === undefined || canonical.name === updates.name) &&
    (updates.description === undefined || canonical.description === updates.description) &&
    (updates.appearance === undefined ||
      equalAppearance(canonical.appearance, updates.appearance)) &&
    (updates.sources === undefined || equalSources(canonical.sources, updates.sources));

  const presentationKeys = (updates: ProjectUpdateInput): readonly ProjectPresentationKey[] => {
    const keys: ProjectPresentationKey[] = [];
    if (updates.name !== undefined) keys.push("name");
    if (updates.description !== undefined) keys.push("description");
    if (updates.appearance !== undefined) keys.push("appearance");
    if (updates.sources !== undefined) keys.push("sources");
    return keys;
  };

  const materializesKey = (
    canonical: Project,
    entry: ProjectUpdateEntry,
    key: ProjectPresentationKey,
  ): boolean => {
    const updates = entry.updates;
    if (key === "name") return canonical.name === updates.name;
    if (key === "description") return canonical.description === updates.description;
    if (key === "appearance") {
      return (
        updates.appearance !== undefined &&
        equalAppearance(canonical.appearance, updates.appearance)
      );
    }
    return updates.sources !== undefined && equalSources(canonical.sources, updates.sources);
  };

  const directlyMaterializes = (entry: ProjectUpdateEntry): boolean => {
    if (!entry.acknowledgement || entry.phase !== "acknowledged") return false;
    const coordinate = acknowledgementCoordinate(entry.acknowledgement);
    if (coordinate.storeEpoch !== canonicalStoreEpoch) return false;
    if (canonicalProjectionRevision < coordinate.commitSeq) return false;
    const canonical = canonicalProjects.get(entry.projectId);
    return canonical !== undefined && materializesUpdates(canonical, entry.updates);
  };

  const materializedOperationIds = (): readonly string[] => {
    const ordered = sortedEntries();
    const directIndexes = ordered
      .map((entry, index) => (directlyMaterializes(entry) ? index : -1))
      .filter((index) => index >= 0);
    if (directIndexes.length === 0) return [];

    return ordered
      .filter((entry, index) => {
        const canonical = canonicalProjects.get(entry.projectId);
        if (!canonical) return false;
        const keys = presentationKeys(entry.updates);
        if (keys.length === 0) return directlyMaterializes(entry);
        const overwrittenByLaterMaterialization = (key: ProjectPresentationKey): boolean =>
          directIndexes.some((directIndex) => {
            if (directIndex <= index) return false;
            const later = ordered[directIndex];
            return (
              later?.projectId === entry.projectId && presentationKeys(later.updates).includes(key)
            );
          });
        if (entry.phase === "unknown") {
          return keys.every(overwrittenByLaterMaterialization);
        }
        if (entry.phase !== "acknowledged") return false;
        return keys.every(
          (key) => materializesKey(canonical, entry, key) || overwrittenByLaterMaterialization(key),
        );
      })
      .map((entry) => entry.operationId);
  };

  const candidateFingerprint = (operationIds: readonly string[]): string => {
    const candidateProjects = new Set(
      operationIds
        .map((candidateOperationId) => entries.get(candidateOperationId)?.projectId)
        .filter((projectId): projectId is string => projectId !== undefined),
    );
    const presentation = [...candidateProjects].sort().map((projectId) => {
      const canonical = canonicalProjects.get(projectId) ?? null;
      const presented = project(canonical);
      return presented
        ? [
            projectId,
            presented.name,
            presented.description,
            presented.appearance,
            presented.sources,
          ]
        : [projectId, null];
    });
    return JSON.stringify([operationIds, presentation]);
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = (): void => {
    const operationIds = materializedOperationIds();
    if (operationIds.length === 0) {
      renderCandidate = null;
    } else {
      const fingerprint = candidateFingerprint(operationIds);
      if (renderCandidate?.fingerprint !== fingerprint) {
        nextRenderToken += 1;
        renderCandidate = { fingerprint, operationIds, token: nextRenderToken };
        for (const candidateOperationId of operationIds) {
          const entry = entries.get(candidateOperationId);
          if (!entry || entry.phase !== "acknowledged") continue;
          recordRendererOwnerTrace(
            entry.trace,
            {
              kind: "materialized",
              reason: "canonical_observation",
              renderToken: renderCandidate.token,
            },
            trace,
          );
        }
      }
    }

    const next = {
      revision: snapshot.revision + 1,
      pendingCount: entries.size,
      unknownOutcomeCount: sortedEntries().filter((entry) => entry.phase === "unknown").length,
      renderToken: renderCandidate?.token ?? null,
    } satisfies ProjectCatalogStoreSnapshot;
    if (
      next.pendingCount === snapshot.pendingCount &&
      next.unknownOutcomeCount === snapshot.unknownOutcomeCount &&
      next.renderToken === snapshot.renderToken
    ) {
      return;
    }
    snapshot = next;
    notify();
  };

  const resetAuthority = (storeEpoch: string): void => {
    for (const entry of entries.values()) {
      recordRendererOwnerTrace(entry.trace, { kind: "revoked", reason: "store_reset" }, trace);
    }
    if (canonicalStoreEpoch && canonicalStoreEpoch !== storeEpoch) {
      retiredStoreEpochs.add(canonicalStoreEpoch);
      while (retiredStoreEpochs.size > MAX_RETIRED_STORE_EPOCHS) {
        const oldest = retiredStoreEpochs.values().next().value;
        if (oldest === undefined) break;
        retiredStoreEpochs.delete(oldest);
      }
    }
    canonicalStoreEpoch = storeEpoch;
    canonicalProjectionRevision = -1;
    canonicalProjects = new Map();
    confirmedProjects.clear();
    transportBindingRevisions.clear();
    entries.clear();
    const retiredTransportGeneration = transportGeneration;
    transportGeneration = createTransportGeneration(retiredTransportGeneration.id + 1);
    retiredTransportGeneration.retire();
    renderCandidate = null;
    refreshSnapshot();
  };

  const removeEntry = (entry: ProjectUpdateEntry): void => {
    if (entries.get(entry.operationId) !== entry) return;
    entries.delete(entry.operationId);
    refreshSnapshot();
  };

  const acceptAcknowledgement = (
    entry: ProjectUpdateEntry,
    result: Extract<ProjectCatalogUpdateTransportResult, { readonly kind: "acknowledged" }>,
  ): ProjectCatalogUpdateOutcome => {
    if (entries.get(entry.operationId) !== entry) return { kind: "superseded" };
    const coordinate = acknowledgementCoordinate(result.acknowledgement);
    if (retiredStoreEpochs.has(coordinate.storeEpoch)) {
      removeEntry(entry);
      return { kind: "superseded" };
    }
    if (canonicalStoreEpoch !== null && canonicalStoreEpoch !== coordinate.storeEpoch) {
      resetAuthority(coordinate.storeEpoch);
      return { kind: "superseded" };
    }
    canonicalStoreEpoch = coordinate.storeEpoch;
    entry.phase = "acknowledged";
    entry.acknowledgement = result.acknowledgement;
    recordRendererOwnerTrace(
      entry.trace,
      result.acknowledgement.status === "no_op"
        ? { kind: "no_op", reason: "no_op" }
        : { kind: "acknowledged", reason: "committed" },
      trace,
    );
    confirmedProjects.set(entry.projectId, result.project);
    transportBindingRevisions.set(entry.projectId, result.project.bindingRevision);
    refreshSnapshot();
    return { kind: "acknowledged", project: result.project };
  };

  const acceptTransportResult = (
    entry: ProjectUpdateEntry,
    result: ProjectCatalogUpdateTransportResult,
  ): ProjectCatalogUpdateOutcome => {
    if (entries.get(entry.operationId) !== entry) return { kind: "superseded" };
    if (result.kind === "acknowledged") return acceptAcknowledgement(entry, result);
    if (result.kind === "definitive_failure") {
      removeEntry(entry);
      return result;
    }
    entry.phase = "unknown";
    refreshSnapshot();
    return result;
  };

  const execute = async (entry: ProjectUpdateEntry): Promise<ProjectCatalogUpdateOutcome> => {
    if (entries.get(entry.operationId) !== entry) return { kind: "superseded" };
    try {
      const expectedBindingRevision =
        entry.updates.expectedBindingRevision ?? transportBindingRevisions.get(entry.projectId);
      if (expectedBindingRevision === undefined) {
        recordRendererOwnerTrace(entry.trace, { kind: "failed", reason: "domain_failure" }, trace);
        return acceptTransportResult(entry, {
          kind: "definitive_failure",
          failure: {
            code: "renderer_catalog_authority_missing",
            message: "The Project catalog has no canonical revision for this update",
          },
        });
      }
      entry.command ??= {
        operationId: entry.operationId,
        projectId: entry.projectId,
        updates: { ...entry.updates, expectedBindingRevision },
      };
      const result = await port.send(entry.command);
      return acceptTransportResult(entry, result);
    } catch (cause) {
      return acceptTransportResult(entry, {
        kind: "unknown_outcome",
        failure: transportFailure(cause),
      });
    }
  };

  const enqueue = (entry: ProjectUpdateEntry): Promise<ProjectCatalogUpdateOutcome> => {
    const generation = transportGeneration;
    const previous = generation.tails.get(entry.projectId) ?? Promise.resolve();
    const execution = previous.then(() => execute(entry));
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    generation.tails.set(entry.projectId, tail);
    void tail.then(() => {
      if (generation.tails.get(entry.projectId) === tail) generation.tails.delete(entry.projectId);
    });
    return execution;
  };

  const updateProject = (
    projectId: string,
    updates: ProjectUpdateInput,
  ): Promise<ProjectCatalogUpdateOutcome> => {
    if (entries.size >= retainedLimit) {
      return Promise.resolve({
        kind: "definitive_failure",
        failure: {
          code: "renderer_catalog_capacity",
          message: "Too many Project updates are awaiting settlement",
        },
      });
    }

    entrySequence += 1;
    const nextOperationId = operationId();
    const entry: ProjectUpdateEntry = {
      operationId: nextOperationId,
      projectId,
      updates,
      sequence: entrySequence,
      command: null,
      phase: "submitting",
      acknowledgement: null,
      trace: beginRendererOwnerTrace(
        {
          semanticKey: "workspace.project.update",
          operationIdentity: nextOperationId,
          owner: "project-catalog",
          protocol: "receipt_fenced_projection",
          scopeKind: "project",
        },
        trace,
      ),
    };
    entries.set(entry.operationId, entry);
    refreshSnapshot();
    recordRendererOwnerTrace(entry.trace, { kind: "local_intent", reason: "local_intent" }, trace);
    return enqueue(entry);
  };

  const renameProject = (projectId: string, name: string): Promise<ProjectCatalogUpdateOutcome> =>
    updateProject(projectId, { name });

  const retryProjectUpdate = (projectId: string): Promise<ProjectCatalogUpdateOutcome | null> => {
    const entry = sortedEntries()
      .reverse()
      .find((candidate) => candidate.projectId === projectId && candidate.phase === "unknown");
    if (!entry) return Promise.resolve(null);
    entry.phase = "submitting";
    refreshSnapshot();
    return enqueue(entry);
  };

  const waitForProjectUpdates = async (fallback: Project): Promise<Project> => {
    while (true) {
      const generation = transportGeneration;
      const tail = generation.tails.get(fallback.id);
      if (!tail) break;
      await Promise.race([tail, generation.retired]);
      if (transportGeneration !== generation) continue;
      if (generation.tails.get(fallback.id) === tail) break;
    }
    const confirmed = confirmedProjects.get(fallback.id);
    const canonical = canonicalProjects.get(fallback.id);
    const base =
      confirmed && (!canonical || confirmed.bindingRevision > canonical.bindingRevision)
        ? confirmed
        : (canonical ?? fallback);
    return project(base) ?? fallback;
  };

  const publishCanonical = (next: ProjectCatalogCanonicalSnapshot): void => {
    if (!validCanonicalSnapshot(next)) {
      throw new TypeError("Project catalog canonical authority is invalid");
    }
    if (retiredStoreEpochs.has(next.storeEpoch)) return;
    if (canonicalStoreEpoch !== null && canonicalStoreEpoch !== next.storeEpoch) {
      resetAuthority(next.storeEpoch);
    }
    if (
      canonicalStoreEpoch === next.storeEpoch &&
      next.projectionRevision < canonicalProjectionRevision
    ) {
      return;
    }

    canonicalStoreEpoch = next.storeEpoch;
    canonicalProjectionRevision = next.projectionRevision;
    canonicalProjects = new Map(next.projects.map((candidate) => [candidate.id, candidate]));
    for (const candidate of next.projects) {
      const currentRevision = transportBindingRevisions.get(candidate.id) ?? 0;
      if (candidate.bindingRevision >= currentRevision) {
        transportBindingRevisions.set(candidate.id, candidate.bindingRevision);
      }
    }
    refreshSnapshot();
  };

  const markRendered = (renderToken: number): void => {
    if (renderCandidate?.token !== renderToken) return;
    const operationIds = renderCandidate.operationIds;
    renderCandidate = null;
    for (const candidateOperationId of operationIds) {
      const entry = entries.get(candidateOperationId);
      if (!entry) continue;
      if (entry.phase === "unknown") {
        recordRendererOwnerTrace(
          entry.trace,
          { kind: "superseded", reason: "newer_intent" },
          trace,
        );
      } else {
        recordRendererOwnerTrace(
          entry.trace,
          { kind: "rendered", reason: "render_handoff", renderToken },
          trace,
        );
        recordRendererOwnerTrace(entry.trace, { kind: "settled", reason: "proof_complete" }, trace);
      }
      entries.delete(candidateOperationId);
    }
    refreshSnapshot();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    project,
    projects: (values) => {
      let changed = false;
      const presented = values.map((value) => {
        const next = project(value) ?? value;
        if (next !== value) changed = true;
        return next;
      });
      return changed ? presented : values;
    },
    renameProject,
    updateProject,
    retryProjectUpdate,
    waitForProjectUpdates,
    publishCanonical,
    markRendered,
  };
}
