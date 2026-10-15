import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import type { DatabasePropertyOption } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { MAX_DATA_SOURCE_PROPERTY_OPTIONS } from "../../../shared/data-source-option-registry";
import { matchBuiltInDataSourceProperty } from "../../../shared/data-source-built-ins";
import { readDatabasePropertyOptions } from "@/lib/database-view-authoring";
import {
  mergePropertyOptionPages,
  propertyOptionWindowMatchesProjection,
  readPropertyOptionWindow,
} from "@/lib/database-property-options-runtime";
import type { DataSourcePropertyOptionRegistryState } from "./data-source-property-editor-binding";

interface PropertyOptionRegistryEntry {
  readonly options: readonly DatabasePropertyOption[];
  readonly state: DataSourcePropertyOptionRegistryState;
  readonly nextCursor: string | null;
  readonly projectionRevision: number | null;
  readonly seenCursors: readonly string[];
  readonly loadingMore: boolean;
}

const EMPTY_REQUIRED_OPTION_IDS: Readonly<Record<string, readonly string[]>> = {};

const isOptionProperty = (property: DataSourcePropertyRecordV2): boolean =>
  property.lifecycle === "active" &&
  (property.valueType === "select" || property.valueType === "multi_select");

const isCompactSemanticRegistry = (property: DataSourcePropertyRecordV2): boolean => {
  const role = matchBuiltInDataSourceProperty(property);
  return role === "status" || role === "priority" || role === "estimate";
};

const initialEntry = (property: DataSourcePropertyRecordV2): PropertyOptionRegistryEntry => {
  const options = readDatabasePropertyOptions(property);
  return {
    options,
    state: options.length >= property.optionCount ? "ready" : "idle",
    nextCursor: null,
    projectionRevision: null,
    seenCursors: [],
    loadingMore: false,
  };
};

/** Shared, picker-driven option-window authority for Page Stage and Database View. */
export function usePropertyOptionRegistries({
  routingContext,
  properties,
  requiredOptionIds = EMPTY_REQUIRED_OPTION_IDS,
}: {
  readonly routingContext: ContentRoutingContext;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  /** Selected identities whose labels are visible before a picker opens. */
  readonly requiredOptionIds?: Readonly<Record<string, readonly string[]>>;
}) {
  const [entries, setEntries] = useState<Readonly<Record<string, PropertyOptionRegistryEntry>>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const propertiesRef = useRef(properties);
  propertiesRef.current = properties;
  const generationRef = useRef(0);
  const loadsRef = useRef(new Map<string, Promise<void>>());
  const propertyAuthorityKey = JSON.stringify([
    routingContext.kind === "project" ? ["project", routingContext.projectId] : ["library"],
    properties.map((property) => [
      property.dataSourceId,
      property.propertyId,
      property.revision,
      property.lifecycle,
      property.optionCount,
    ]),
  ]);

  useLayoutEffect(() => {
    generationRef.current += 1;
    loadsRef.current.clear();
    setEntries(
      Object.fromEntries(
        propertiesRef.current
          .filter(isOptionProperty)
          .map((property) => [property.propertyId, initialEntry(property)]),
      ),
    );
  }, [propertyAuthorityKey]);

  const load = useCallback(
    (property: DataSourcePropertyRecordV2, continuation: boolean) => {
      if (!isOptionProperty(property)) return;
      const propertyId = property.propertyId;
      const current = entriesRef.current[propertyId] ?? initialEntry(property);
      if (loadsRef.current.has(propertyId)) return;
      if (continuation && (!current.nextCursor || current.state !== "ready")) return;
      if (!continuation && current.state === "ready") return;
      const after = continuation ? current.nextCursor : null;
      const generation = generationRef.current;
      setEntries((all) => ({
        ...all,
        [propertyId]: {
          ...(all[propertyId] ?? current),
          state: continuation ? "ready" : "loading",
          loadingMore: continuation,
        },
      }));

      const read = async () => {
        let replace = after === null;
        let page;
        try {
          page = await readPropertyOptionWindow(routingContext, property, after);
        } catch (cause) {
          if (after === null) throw cause;
          page = await readPropertyOptionWindow(routingContext, property, null);
          replace = true;
        }
        const latest = entriesRef.current[propertyId] ?? current;
        if (
          after !== null &&
          !propertyOptionWindowMatchesProjection(latest.projectionRevision, page.projectionRevision)
        ) {
          page = await readPropertyOptionWindow(routingContext, property, null);
          replace = true;
        }
        const seenCursors = replace ? [] : latest.seenCursors;
        if (page.nextCursor && seenCursors.includes(page.nextCursor)) {
          throw new Error("Property option registry returned a repeated cursor");
        }
        const options = replace
          ? page.options
          : mergePropertyOptionPages(latest.options, page.options);
        // optionCount belongs to the descriptor snapshot; this window may be newer.
        if (
          property.optionCount > MAX_DATA_SOURCE_PROPERTY_OPTIONS ||
          options.length > MAX_DATA_SOURCE_PROPERTY_OPTIONS
        ) {
          throw new Error("Property option registry exceeded its declared bound");
        }
        if (generationRef.current !== generation) return;
        setEntries((all) => ({
          ...all,
          [propertyId]: {
            options,
            state: "ready",
            nextCursor: page.nextCursor,
            projectionRevision: page.projectionRevision,
            seenCursors: page.nextCursor ? [...seenCursors, page.nextCursor] : seenCursors,
            loadingMore: false,
          },
        }));
      };
      const request = read()
        .catch((cause: unknown) => {
          if (generationRef.current !== generation) return;
          console.error("Failed to load property options", cause);
          setEntries((all) => ({
            ...all,
            [propertyId]: {
              ...(all[propertyId] ?? current),
              state: "error",
              loadingMore: false,
            },
          }));
        })
        .finally(() => {
          if (loadsRef.current.get(propertyId) === request) {
            loadsRef.current.delete(propertyId);
          }
        });
      loadsRef.current.set(propertyId, request);
    },
    [routingContext],
  );

  const requestOptions = useCallback(
    (property: DataSourcePropertyRecordV2) => load(property, false),
    [load],
  );
  const requestMoreOptions = useCallback(
    (property: DataSourcePropertyRecordV2) => load(property, true),
    [load],
  );
  const requiredOptionEntries = useMemo(
    () =>
      Object.entries(requiredOptionIds).map(
        ([propertyId, optionIds]) => [propertyId, [...new Set(optionIds)]] as const,
      ),
    [requiredOptionIds],
  );

  useEffect(() => {
    const propertyById = new Map<string, DataSourcePropertyRecordV2>(
      propertiesRef.current.map((property) => [String(property.propertyId), property]),
    );
    for (const [propertyId, requiredIds] of requiredOptionEntries) {
      if (requiredIds.length === 0) continue;
      const property = propertyById.get(propertyId);
      if (!property || !isOptionProperty(property)) continue;
      const entry = entriesRef.current[property.propertyId] ?? initialEntry(property);
      const presentIds = new Set(entry.options.map((option) => option.id));
      if (requiredIds.every((optionId) => presentIds.has(optionId))) continue;
      if (entry.state === "idle") {
        load(property, false);
        continue;
      }
      if (entry.state === "ready" && entry.nextCursor !== null) {
        load(property, true);
      }
    }
  }, [entries, load, requiredOptionEntries]);

  useEffect(() => {
    for (const property of propertiesRef.current) {
      if (!isCompactSemanticRegistry(property)) continue;
      const entry = entriesRef.current[property.propertyId] ?? initialEntry(property);
      if (entry.state === "idle") load(property, false);
    }
  }, [entries, load]);

  return useMemo(
    () => ({
      options: Object.fromEntries(
        Object.entries(entries).map(([propertyId, entry]) => [propertyId, entry.options]),
      ) as Readonly<Record<string, readonly DatabasePropertyOption[]>>,
      states: Object.fromEntries(
        Object.entries(entries).map(([propertyId, entry]) => [propertyId, entry.state]),
      ) as Readonly<Record<string, DataSourcePropertyOptionRegistryState>>,
      hasMore: Object.fromEntries(
        Object.entries(entries).map(([propertyId, entry]) => [
          propertyId,
          entry.nextCursor !== null,
        ]),
      ) as Readonly<Record<string, boolean>>,
      loadingMore: Object.fromEntries(
        Object.entries(entries).map(([propertyId, entry]) => [propertyId, entry.loadingMore]),
      ) as Readonly<Record<string, boolean>>,
      requestOptions,
      requestMoreOptions,
    }),
    [entries, requestMoreOptions, requestOptions],
  );
}
