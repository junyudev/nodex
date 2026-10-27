import { startTransition, useOptimistic, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon, PluginsIcon } from "@/components/shared/icons";
import { ChevronRightMdIcon, PlusIcon20 } from "@/components/shared/icons/customize-action-icons";
import { BrowseTabs } from "@/components/ui/browse-tabs";
import { PageSearchInput } from "@/components/ui/page-search-input";
import { SearchablePageLayout } from "@/components/ui/searchable-page-layout";
import { toast } from "@/components/ui/toast";
import type { MarketplaceAddParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddParams";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  usePersonalPlugins,
  usePluginCategory,
  usePluginManagement,
  usePluginSearch,
  usePublicPluginSections,
  useCreatedPlugins,
  useSharedPlugins,
  type PersonalPlugins,
  type PluginContext,
  type PluginRow,
} from "../plugin-management";
import { buildPluginDirectoryPath, type PluginDirectoryTab } from "../plugins-routes";
import { AddMarketplaceDialog } from "./add-marketplace-dialog";
import { CustomizeHeaderActions } from "./customize-header-actions";
import { usePluginHelperActions } from "./use-plugin-helper-actions";
import { PluginBrowseContext } from "./plugin-browse-context";
import {
  LoadMoreSentinel,
  NoPluginsFound,
  PluginGrid,
  PluginGridLoading,
  PluginsLoadError,
  PluginsSection,
} from "./plugin-grid";
import { PluginListingCard } from "./plugin-listing-card";
import { pluginLogoSource, PluginLogoImage } from "./plugin-logo";
import { pluginDisplayName } from "../model/plugin-labels";

const HOME_SECTION_ROW_LIMIT = 6;
const CREATED_BY_YOU_ID = "plugins-created-by-you";
const SHARED_WITH_YOU_ID = "plugins-shared-with-you";
const MARKETPLACE_PREFIX = "plugins-marketplace-";

interface DirectoryProps {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}

/** "Plugins" with the Public / Personal tabs, search, and category listings. */
export function PluginsDirectoryPage({
  context,
  navigation,
  tab,
  category,
  search,
}: DirectoryProps & {
  readonly tab: PluginDirectoryTab;
  readonly category: string | null;
  readonly search: string;
}) {
  const [optimisticSearch, setOptimisticSearch] = useOptimistic(search);
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const management = usePluginManagement(context);
  const helpers = usePluginHelperActions(context, navigation);

  const onSearchQueryChange = (value: string) =>
    startTransition(() => {
      setOptimisticSearch(value);
      // The first keystroke adds a history entry; later edits replace it.
      navigation.onNavigate(
        buildPluginDirectoryPath({
          tab,
          category: tab === "openai" ? category : value.length > 0 ? null : category,
          search: value,
        }),
        { replace: search.trim().length > 0 },
      );
    });

  const addMarketplace = async (params: MarketplaceAddParams) => {
    const result = await management.addMarketplace(params);
    if (!pluginMutationSucceeded(result)) {
      throw new Error(result.error.message);
    }
    const { marketplaceName, alreadyAdded } = result.value;
    if (alreadyAdded) toast.info(`${marketplaceName} is already added`);
    else if (result.refreshFailures.includes("plugins"))
      toast.warning(
        `${marketplaceName} marketplace is configured, but failed to refresh the plugin list`,
      );
    else toast.success(`${marketplaceName} marketplace added`);
    navigation.onNavigate(buildPluginDirectoryPath({ tab: "personal" }));
  };

  const searching = search.trim().length > 0;
  let overrideContent: ReactNode = null;
  if (tab === "openai" && category != null) {
    overrideContent = (
      <CategoryPluginsView
        context={context}
        navigation={navigation}
        slug={category}
        search={search}
      />
    );
  } else if (searching) {
    overrideContent = (
      <PluginSearchResults context={context} navigation={navigation} term={search} />
    );
  } else if (category != null) {
    overrideContent = (
      <PersonalCategoryView context={context} navigation={navigation} categoryId={category} />
    );
  }

  return (
    <>
      <SearchablePageLayout
        contentClassName="pt-2"
        title={
          category == null ? (
            "Plugins"
          ) : (
            <PluginCategoryTitle context={context} category={category} tab={tab} />
          )
        }
        subtitle={
          category == null ? (
            "Connect plugins to let Codex work across your tools"
          ) : tab === "openai" ? (
            <PublicCategoryDescription context={context} category={category} />
          ) : null
        }
        search={
          <PageSearchInput
            id="plugins-store-page-search"
            label="Search plugins"
            placeholder="Search plugins"
            autoFocus
            className="min-w-0 flex-1"
            searchQuery={optimisticSearch}
            onSearchQueryChange={onSearchQueryChange}
            trailingControl={
              searching ? <SearchFetchingIndicator context={context} term={search} /> : undefined
            }
          />
        }
        headerAction={
          <CustomizeHeaderActions
            context={context}
            onManage={navigation.onOpenSettings}
            addActions={[
              {
                id: "plugin",
                label: "Create plugin",
                icon: <PluginsIcon />,
                disabled: helpers.createPlugin.disabled,
                onSelect: helpers.createPlugin.run,
              },
              {
                id: "marketplace",
                label: "Add a marketplace",
                icon: <PlusIcon20 />,
                onSelect: () => setAddMarketplaceOpen(true),
              },
            ]}
          />
        }
        stickyControls={
          overrideContent == null ? (
            <BrowseTabs
              ariaLabel="Plugin directory"
              tabs={[
                { key: "openai", name: "Public" },
                { key: "personal", name: "Personal" },
              ]}
              selectedKey={tab}
              onSelect={(key) => navigation.onNavigate(buildPluginDirectoryPath({ tab: key }))}
            />
          ) : undefined
        }
      >
        <div className="-mx-2 flex min-h-0 flex-1 flex-col gap-8">
          <PluginBrowseContext value={{ tab, category, search }}>
            {overrideContent ??
              (tab === "personal" ? (
                <PersonalDirectory context={context} navigation={navigation} />
              ) : (
                <PublicDirectory context={context} navigation={navigation} />
              ))}
          </PluginBrowseContext>
        </div>
      </SearchablePageLayout>
      <AddMarketplaceDialog
        open={addMarketplaceOpen}
        onOpenChange={setAddMarketplaceOpen}
        onAddMarketplace={addMarketplace}
      />
    </>
  );
}

function SearchFetchingIndicator({
  context,
  term,
}: {
  readonly context: PluginContext;
  readonly term: string;
}) {
  const results = usePluginSearch(context, term);
  if (!results.isFetching) return null;
  return <ActivitySpinnerIcon className="icon-xs text-(--color-text-secondary)" />;
}

/** Refresh, Manage, and the Add menu. */
function PublicDirectory({ context, navigation }: DirectoryProps) {
  const sections = usePublicPluginSections(context);
  if (sections.isPending) {
    return (
      <PluginsSection
        id="plugins-featured"
        title={
          <div
            aria-hidden="true"
            className="h-3 w-20 rounded bg-text/10 motion-safe:animate-pulse"
          />
        }
      >
        <PluginGridLoading />
      </PluginsSection>
    );
  }
  if (sections.error) {
    return (
      <PluginsLoadError
        error={sections.error}
        retrying={sections.isFetching}
        onRetry={() => void sections.refetch()}
      />
    );
  }
  return (
    <>
      {sections.data.sections.map((section) => (
        <PluginsSection
          key={section.id}
          id={section.id}
          title={
            section.urlSlug == null ? (
              section.title
            ) : (
              <CategoryTitleLink
                title={section.title}
                onOpen={() =>
                  navigation.onNavigate(buildPluginDirectoryPath({ category: section.urlSlug }))
                }
              />
            )
          }
        >
          <PluginGrid>
            {section.plugins.slice(0, HOME_SECTION_ROW_LIMIT).map((row) => (
              <PluginListingCard
                key={row.stableIdentity}
                row={row}
                context={context}
                navigation={navigation}
              />
            ))}
          </PluginGrid>
        </PluginsSection>
      ))}
    </>
  );
}

/** A section title that opens the category's complete listing; its chevron nudges on hover. */
function CategoryTitleLink({
  title,
  onOpen,
}: {
  readonly title: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="group/category no-drag flex cursor-interaction items-center gap-1 border-0 p-0 whitespace-nowrap select-none hover:text-token-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border"
      onClick={onOpen}
    >
      {title}
      <ChevronRightMdIcon
        data-rtl-flip=""
        className="text-tertiary transition-transform duration-150 ease-out motion-reduce:transition-none motion-safe:group-hover/category:ltr:translate-x-0.5 motion-safe:group-hover/category:rtl:-translate-x-0.5"
      />
    </button>
  );
}

interface PersonalSection {
  readonly id: string;
  readonly title: string;
  readonly plugins: readonly PluginRow[];
}

/** Created by you, Shared with you, then each third-party marketplace with plugins. */
export function personalSections(personal: PersonalPlugins): PersonalSection[] {
  const sections: PersonalSection[] = [];
  if (personal.createdByYou.length > 0)
    sections.push({
      id: CREATED_BY_YOU_ID,
      title: "Created by you",
      plugins: personal.createdByYou,
    });
  if (personal.sharedWithYou.length > 0)
    sections.push({
      id: SHARED_WITH_YOU_ID,
      title: "Shared with you",
      plugins: personal.sharedWithYou,
    });
  for (const group of personal.marketplaces) {
    if (group.plugins.length === 0) continue;
    sections.push({
      id: `${MARKETPLACE_PREFIX}${encodeURIComponent(group.identity.path ?? group.identity.name)}`,
      title: group.label,
      plugins: group.plugins,
    });
  }
  return sections;
}

function PersonalDirectory({ context, navigation }: DirectoryProps) {
  const personal = usePersonalPlugins(context);
  if (personal.isPending) return <PluginGridLoading />;
  if (personal.error) {
    return (
      <PluginsLoadError
        error={personal.error}
        retrying={personal.isFetching}
        onRetry={() => void personal.refetch()}
      />
    );
  }
  const sections = personalSections(personal.data);
  if (sections.length === 0) return <NoPluginsFound />;
  return (
    <>
      {sections.map((section) => (
        <PluginsSection key={section.id} id={section.id} title={section.title}>
          <PluginGrid>
            {section.plugins.slice(0, HOME_SECTION_ROW_LIMIT).map((row) => (
              <PluginListingCard
                key={row.stableIdentity}
                row={row}
                context={context}
                navigation={navigation}
              />
            ))}
          </PluginGrid>
          {section.plugins.length > HOME_SECTION_ROW_LIMIT ? (
            <SeeMoreLink
              plugins={section.plugins.slice(HOME_SECTION_ROW_LIMIT)}
              onOpen={() =>
                navigation.onNavigate(
                  buildPluginDirectoryPath({ tab: "personal", category: section.id }),
                )
              }
            />
          ) : null}
        </PluginsSection>
      ))}
    </>
  );
}

/** Opens a section's complete listing, previewing up to three of the remaining logos. */
function SeeMoreLink({
  plugins,
  onOpen,
}: {
  readonly plugins: readonly PluginRow[];
  readonly onOpen: () => void;
}) {
  const withLogos = plugins
    .filter((row) => row.logoUrl != null || row.logoDarkUrl != null)
    .slice(0, 3);
  const names = plugins.slice(0, 2).map(pluginDisplayName).join(", ");
  return (
    <button
      type="button"
      className="mt-4 flex min-h-(--height-token-row) w-full cursor-interaction items-center gap-3 rounded-(--radius-token-row) px-(--padding-row-x) py-(--padding-row-y) text-start text-sm leading-relaxed font-normal text-token-description-foreground outline-hidden hover:text-token-foreground focus-visible:text-token-foreground"
      onClick={onOpen}
    >
      {withLogos.length > 0 ? (
        <span className="ms-0.5 shrink-0">
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {withLogos.map((row) => (
              <span
                key={row.stableIdentity}
                className="-ms-1.5 flex size-6 items-center justify-center overflow-hidden rounded-md bg-surface ring-1 ring-token-border ring-inset first:ms-0"
              >
                <PluginLogoImage source={pluginLogoSource(row)} className="size-full rounded-2xs" />
              </span>
            ))}
          </span>
        </span>
      ) : null}
      <span>
        {plugins.length === 0
          ? "See more"
          : `See ${names}${plugins.length > 1 ? ", and more" : " and more"}`}
      </span>
    </button>
  );
}

/** Rows with their error, loading, empty, and next-page states. */
function PluginListing({
  context,
  navigation,
  rows,
  error,
  isLoading,
  isFetching,
  hasNextPage,
  isFetchingNextPage,
  showDeveloper = false,
  onRetry,
  onLoadNextPage,
}: DirectoryProps & {
  readonly rows: readonly PluginRow[] | undefined;
  readonly error: Error | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly showDeveloper?: boolean;
  readonly onRetry: () => void;
  readonly onLoadNextPage?: () => void;
}) {
  if (error != null && (rows == null || rows.length === 0)) {
    return <PluginsLoadError error={error} retrying={isFetching} onRetry={onRetry} />;
  }
  if (isLoading) return <PluginGridLoading />;
  if (rows == null) return null;
  if (rows.length === 0 && !hasNextPage) return <NoPluginsFound />;
  return (
    <>
      <PluginGrid>
        {rows.map((row) => (
          <PluginListingCard
            key={row.stableIdentity}
            row={row}
            context={context}
            navigation={navigation}
            showDeveloper={showDeveloper}
          />
        ))}
      </PluginGrid>
      {error == null ? null : (
        <PluginsLoadError error={error} retrying={isFetching} onRetry={onRetry} />
      )}
      {error == null && onLoadNextPage != null ? (
        <LoadMoreSentinel
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadNextPage={onLoadNextPage}
        />
      ) : null}
    </>
  );
}

function CategoryPluginsView({
  context,
  navigation,
  slug,
  search,
}: DirectoryProps & { readonly slug: string; readonly search: string }) {
  const category = usePluginCategory(context, { slug, search: search.trim() });
  return (
    <PluginListing
      context={context}
      navigation={navigation}
      rows={category.rows}
      error={category.error}
      isLoading={category.isLoading}
      isFetching={category.isFetching}
      hasNextPage={category.hasNextPage}
      isFetchingNextPage={category.isFetchingNextPage}
      onRetry={() => void category.refetch()}
      onLoadNextPage={() => void category.fetchNextPage()}
    />
  );
}

function PluginSearchResults({
  context,
  navigation,
  term,
}: DirectoryProps & { readonly term: string }) {
  const results = usePluginSearch(context, term);
  return (
    <PluginListing
      context={context}
      navigation={navigation}
      rows={results.data == null ? undefined : results.rows}
      error={results.error}
      isLoading={results.isLoading}
      isFetching={results.isFetching}
      hasNextPage={results.hasNextPage}
      isFetchingNextPage={results.isFetchingNextPage}
      showDeveloper
      onRetry={() => void results.refetch()}
      onLoadNextPage={() => void results.fetchNextPage()}
    />
  );
}

function PersonalCategoryView({
  context,
  navigation,
  categoryId,
}: DirectoryProps & { readonly categoryId: string }) {
  if (categoryId === CREATED_BY_YOU_ID)
    return <CreatedFeedView context={context} navigation={navigation} />;
  if (categoryId === SHARED_WITH_YOU_ID)
    return <SharedFeedView context={context} navigation={navigation} />;
  return (
    <MarketplaceCategoryView context={context} navigation={navigation} categoryId={categoryId} />
  );
}

function CreatedFeedView({ context, navigation }: DirectoryProps) {
  return (
    <PersonalFeedListing
      context={context}
      navigation={navigation}
      page={useCreatedPlugins(context)}
    />
  );
}

function SharedFeedView({ context, navigation }: DirectoryProps) {
  return (
    <PersonalFeedListing
      context={context}
      navigation={navigation}
      page={useSharedPlugins(context)}
    />
  );
}

function PersonalFeedListing({
  context,
  navigation,
  page,
}: DirectoryProps & { readonly page: ReturnType<typeof useCreatedPlugins> }) {
  return (
    <PluginListing
      context={context}
      navigation={navigation}
      rows={page.data == null ? undefined : page.rows}
      error={page.error}
      isLoading={page.isLoading}
      isFetching={page.isFetching}
      hasNextPage={page.hasNextPage}
      isFetchingNextPage={page.isFetchingNextPage}
      onRetry={() => void page.refetch()}
      onLoadNextPage={() => void page.fetchNextPage()}
    />
  );
}

function MarketplaceCategoryView({
  context,
  navigation,
  categoryId,
}: DirectoryProps & { readonly categoryId: string }) {
  const personal = usePersonalPlugins(context);
  const section = personal.data
    ? personalSections(personal.data).find((candidate) => candidate.id === categoryId)
    : undefined;
  return (
    <PluginListing
      context={context}
      navigation={navigation}
      rows={personal.data == null ? undefined : (section?.plugins ?? [])}
      error={personal.error}
      isLoading={personal.isPending}
      isFetching={personal.isFetching}
      hasNextPage={false}
      isFetchingNextPage={false}
      onRetry={() => void personal.refetch()}
    />
  );
}

const CATEGORY_TITLE_FALLBACKS: Record<string, string> = {
  [CREATED_BY_YOU_ID]: "Created by you",
  [SHARED_WITH_YOU_ID]: "Shared with you",
  featured: "Popular",
  "education-and-research": "Education",
};

function startCase(slug: string): string {
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

/** A directory category's title: its catalog title, or a readable name for its slug. */
export function PluginCategoryTitle({
  context,
  category,
  tab,
}: {
  readonly context: PluginContext;
  readonly category: string;
  readonly tab: PluginDirectoryTab;
}) {
  if (tab === "personal") return <PersonalCategoryTitle context={context} category={category} />;
  return <PublicCategoryTitle context={context} category={category} />;
}

function PersonalCategoryTitle({
  context,
  category,
}: {
  readonly context: PluginContext;
  readonly category: string;
}) {
  const personal = usePersonalPlugins(context);
  const fallback = CATEGORY_TITLE_FALLBACKS[category];
  if (fallback) return <>{fallback}</>;
  const section = personal.data
    ? personalSections(personal.data).find((candidate) => candidate.id === category)
    : undefined;
  return <>{section?.title ?? "Marketplace"}</>;
}

function PublicCategoryTitle({
  context,
  category,
}: {
  readonly context: PluginContext;
  readonly category: string;
}) {
  const categoryPage = usePluginCategory(context, { slug: category });
  return (
    <>{categoryPage.category?.title ?? CATEGORY_TITLE_FALLBACKS[category] ?? startCase(category)}</>
  );
}

function PublicCategoryDescription({
  context,
  category,
}: {
  readonly context: PluginContext;
  readonly category: string;
}) {
  const categoryPage = usePluginCategory(context, { slug: category });
  return <>{categoryPage.category?.description ?? null}</>;
}
