import { getIntl } from "@/lib/i18n";
import type {
  DatabaseId,
  DatabaseViewId,
  DataSourceId,
  DataSourcePropertyId,
} from "../../../../shared/database-identities";

export type DatabaseSettingsRoute =
  | { readonly kind: "root"; readonly databaseId: DatabaseId; readonly viewId: DatabaseViewId }
  | {
      readonly kind: "create_view";
      readonly databaseId: DatabaseId;
      readonly dataSourceId: DataSourceId;
    }
  | { readonly kind: "view"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_layout"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_properties"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_group"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_subgroup"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_display"; readonly viewId: DatabaseViewId }
  | { readonly kind: "view_conditional_color"; readonly viewId: DatabaseViewId }
  | { readonly kind: "source_properties"; readonly dataSourceId: DataSourceId }
  | { readonly kind: "create_property"; readonly dataSourceId: DataSourceId }
  | {
      readonly kind: "property";
      readonly dataSourceId: DataSourceId;
      readonly propertyId: DataSourcePropertyId;
    }
  | {
      readonly kind: "property_type";
      readonly dataSourceId: DataSourceId;
      readonly propertyId: DataSourcePropertyId;
    }
  | {
      readonly kind: "property_options";
      readonly dataSourceId: DataSourceId;
      readonly propertyId: DataSourcePropertyId;
    }
  | { readonly kind: "deleted_properties"; readonly dataSourceId: DataSourceId }
  | { readonly kind: "page_layout"; readonly dataSourceId: DataSourceId };

export type DatabaseSettingsRouteStack = readonly [
  DatabaseSettingsRoute,
  ...DatabaseSettingsRoute[],
];

export const openDatabaseSettingsRoute = (
  route: DatabaseSettingsRoute,
): DatabaseSettingsRouteStack => [route];

export const pushDatabaseSettingsRoute = (
  stack: DatabaseSettingsRouteStack,
  route: DatabaseSettingsRoute,
): DatabaseSettingsRouteStack => [...stack, route];

export const replaceDatabaseSettingsRoute = (
  stack: DatabaseSettingsRouteStack,
  route: DatabaseSettingsRoute,
): DatabaseSettingsRouteStack => {
  const preceding = stack.slice(0, -1);
  return preceding.length === 0 ? [route] : [preceding[0]!, ...preceding.slice(1), route];
};

export const backDatabaseSettingsRoute = (
  stack: DatabaseSettingsRouteStack,
): DatabaseSettingsRouteStack | null => {
  if (stack.length === 1) return null;
  const [root, ...rest] = stack.slice(0, -1);
  return [root!, ...rest];
};

const isViewOwnedRoute = (route: DatabaseSettingsRoute): boolean =>
  route.kind === "root" ||
  route.kind === "view" ||
  route.kind === "view_layout" ||
  route.kind === "view_properties" ||
  route.kind === "view_group" ||
  route.kind === "view_subgroup" ||
  route.kind === "view_display" ||
  route.kind === "view_conditional_color";

const sourceIdForRoute = (route: DatabaseSettingsRoute): DataSourceId | null => {
  if (route.kind === "create_view") return route.dataSourceId;
  if (route.kind === "source_properties") return route.dataSourceId;
  if (route.kind === "create_property") return route.dataSourceId;
  if (route.kind === "property") return route.dataSourceId;
  if (route.kind === "property_type") return route.dataSourceId;
  if (route.kind === "property_options") return route.dataSourceId;
  if (route.kind === "deleted_properties") return route.dataSourceId;
  if (route.kind === "page_layout") return route.dataSourceId;
  return null;
};

/** Keeps a rail route attached to its authority when the exact Workbench View changes. */
export const reconcileDatabaseSettingsRouteStack = (input: {
  readonly stack: DatabaseSettingsRouteStack;
  readonly databaseId: DatabaseId;
  readonly previousViewId: DatabaseViewId;
  readonly nextViewId: DatabaseViewId;
  readonly previousDataSourceId: DataSourceId;
  readonly nextDataSourceId: DataSourceId;
}): DatabaseSettingsRouteStack => {
  if (input.previousViewId === input.nextViewId) return input.stack;
  const route = input.stack.at(-1)!;
  if (isViewOwnedRoute(route)) {
    return [{ kind: "view", viewId: input.nextViewId }];
  }
  const routeSourceId = sourceIdForRoute(route);
  if (
    routeSourceId === input.nextDataSourceId &&
    input.previousDataSourceId === input.nextDataSourceId
  ) {
    return input.stack;
  }
  return [
    { kind: "root", databaseId: input.databaseId, viewId: input.nextViewId },
    { kind: "view", viewId: input.nextViewId },
  ];
};

export const databaseSettingsRouteTitle = (
  route: DatabaseSettingsRoute,
  intl = getIntl(),
): string => {
  if (route.kind === "root")
    return intl.formatMessage({
      id: "settings.database.databaseSettings",
      defaultMessage: "Database settings",
    });
  if (route.kind === "create_view")
    return intl.formatMessage({ id: "settings.database.newViewTitle", defaultMessage: "New view" });
  if (route.kind === "view")
    return intl.formatMessage({
      id: "settings.database.viewSettings",
      defaultMessage: "View settings",
    });
  if (route.kind === "view_layout")
    return intl.formatMessage({ id: "settings.database.layout", defaultMessage: "Layout" });
  if (route.kind === "view_properties")
    return intl.formatMessage({
      id: "settings.database.propertyVisibility",
      defaultMessage: "Property visibility",
    });
  if (route.kind === "view_group")
    return intl.formatMessage({ id: "settings.database.group", defaultMessage: "Group" });
  if (route.kind === "view_subgroup")
    return intl.formatMessage({
      id: "settings.database.subGroup",
      defaultMessage: "Sub-group",
    });
  if (route.kind === "view_display")
    return intl.formatMessage({ id: "settings.database.layout", defaultMessage: "Layout" });
  if (route.kind === "view_conditional_color")
    return intl.formatMessage({
      id: "settings.database.conditionalColor",
      defaultMessage: "Conditional color",
    });
  if (route.kind === "source_properties")
    return intl.formatMessage({
      id: "settings.database.properties",
      defaultMessage: "Properties",
    });
  if (route.kind === "create_property")
    return intl.formatMessage({
      id: "settings.database.newProperty",
      defaultMessage: "New property",
    });
  if (route.kind === "property")
    return intl.formatMessage({
      id: "settings.database.editProperty",
      defaultMessage: "Edit property",
    });
  if (route.kind === "property_type")
    return intl.formatMessage({
      id: "settings.database.propertyType",
      defaultMessage: "Property type",
    });
  if (route.kind === "property_options")
    return intl.formatMessage({ id: "settings.database.options", defaultMessage: "Options" });
  if (route.kind === "deleted_properties")
    return intl.formatMessage({
      id: "settings.database.deletedProperties",
      defaultMessage: "Deleted properties",
    });
  return intl.formatMessage({
    id: "settings.database.pageLayout",
    defaultMessage: "Page layout",
  });
};
