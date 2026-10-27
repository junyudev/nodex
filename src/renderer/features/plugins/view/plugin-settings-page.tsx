import { useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { ChevronRightMdIcon } from "@/components/shared/icons/customize-action-icons";
import { NodexSwitch } from "@/components/ui/button";
import { DetailLogo } from "@/components/ui/detail-page";
import { PageEmptyState } from "@/components/ui/section-header";
import { CODEX_SETTINGS_SHELL_STYLE } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { ToolbarBreadcrumb } from "@/components/ui/toolbar-breadcrumb";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { openExternalUrl } from "@/lib/file-system-operations";
import { cn } from "@/lib/utils";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { pluginTagline, skillShortDescription } from "../model/plugin-detail-model";
import { pluginDisplayName } from "../model/plugin-labels";
import { usePendingPluginActions } from "../model/install-sessions";
import { rememberPluginTitle } from "../model/plugin-title-hints";
import { skillTryPrompt } from "../model/skill-model";
import {
  routeTargetToSelector,
  selectorToRouteTarget,
  usePluginDetail,
  usePluginManagement,
  type PluginContext,
  type PluginDetailView,
  type PluginRouteTarget,
} from "../plugin-management";
import { buildPluginDetailPath } from "../plugins-routes";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";
import type { PluginsSettingsNavigation } from "./plugins-settings-page";
import { DetailDialog } from "./detail-dialog";
import { SkillInstructions } from "./skill-preview-modal";
import { usePluginRowActions } from "./use-plugin-row-actions";

type PluginSkill = PluginDetailView["skills"][number];

const CARD_CLASS =
  "flex flex-col overflow-hidden rounded-2xl ring-1 ring-(--color-border) ring-inset [&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4 [&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px [&>*:not(:last-child)]:after:bg-(--color-border) [&>*:not(:last-child)]:after:content-['']";
const CARD_STYLE = {
  backgroundColor: "var(--color-background-panel, var(--color-background-primary-soft-alpha))",
};

/** A compact settings section: a 16px title over a card of rows. */
function SettingsCardSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between gap-4 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">
          <h2 className="text-lg leading-5 font-medium text-token-foreground">{title}</h2>
        </div>
      </div>
      <div className={CARD_CLASS} style={CARD_STYLE}>
        {children}
      </div>
    </section>
  );
}

/** One of the plugin's skills: its name and description, its switch, and its contents. */
function PluginSkillSettingsRow({
  view,
  skill,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly skill: PluginSkill;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
}) {
  const management = usePluginManagement(context);
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const name = skill.name.split(":").pop() || skill.name;
  const enabled = optimistic ?? skill.enabled;
  const setEnabled = async (next: boolean) => {
    setOptimistic(next);
    setUpdating(true);
    try {
      const result = await management.setSkillEnabled(
        skill.name.includes(":") || skill.path == null
          ? { name: skill.name, enabled: next }
          : { path: skill.path, enabled: next },
      );
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      toast.success(next ? `${name} skill enabled` : `${name} skill disabled`);
    } catch {
      setOptimistic(null);
      toast.danger("Failed to update skill");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <>
      <div className="group grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 focus-within:bg-token-list-hover-background hover:bg-token-list-hover-background">
        <button
          type="button"
          className="col-span-full row-start-1 grid min-w-0 flex-1 cursor-interaction grid-cols-subgrid items-center gap-2 rounded-[inherit] px-4 py-3 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border"
          onClick={() => setOpen(true)}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="min-w-0 text-sm leading-4.5 font-medium break-words text-token-foreground">
              {name}
            </div>
            <div className="min-w-0 text-xs leading-4 text-wrap break-words text-(--color-text-secondary)">
              {skill.description}
            </div>
          </div>
          <div className="col-start-3 flex shrink-0 items-center gap-2">
            <ChevronRightMdIcon className="text-tertiary" />
          </div>
        </button>
        <div className="relative col-start-2 row-start-1 flex shrink-0 items-center gap-1">
          <NodexSwitch
            ariaLabel={`Use ${name}`}
            checked={enabled}
            disabled={updating || !view.summary.installed}
            onCheckedChange={(next) => void setEnabled(next)}
          />
        </div>
      </div>
      <DetailDialog
        iconShape="rounded"
        open={open}
        onOpenChange={setOpen}
        title={name}
        titleText={name}
        description={skillShortDescription(skill)}
        footer={
          <ToolbarButton
            color="primary"
            className="rounded-full"
            disabled={!enabled || updating}
            onClick={() => navigation.onStartChat(skillTryPrompt(skill))}
          >
            Try now
          </ToolbarButton>
        }
      >
        <SkillInstructions
          context={context}
          selector={
            skill.path != null
              ? { path: skill.path }
              : view.summary.remotePluginId == null
                ? null
                : {
                    remoteMarketplaceName: view.row.marketplace.name,
                    remotePluginId: view.summary.remotePluginId,
                    skillName: skill.name,
                  }
          }
        />
      </DetailDialog>
    </>
  );
}

/** A label and its value, side by side once there is room. */
function AboutRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-h-14 items-center gap-1 px-4 py-2 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-6">
      <div className="min-w-0 text-sm text-(--color-text-secondary)">{label}</div>
      <div className="min-w-0 text-sm break-words whitespace-normal text-token-foreground">
        {children}
      </div>
    </div>
  );
}

function AboutLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      className="cursor-interaction hover:underline"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const INSTALLED_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function PluginSettingsContent({
  view,
  context,
  navigation,
  onBack,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
  readonly onBack: () => void;
}) {
  const row = view.row;
  const actions = usePluginRowActions(context, navigation);
  const pending = usePendingPluginActions().get(row.stableIdentity);
  const meta = view.summary.interface;
  const version = (view.summary.localVersion ?? view.summary.version)?.trim();
  const installedAt = view.summary.installedAt;
  const name = pluginDisplayName(row);

  return (
    <div className="flex flex-col gap-[22px]">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <DetailLogo>
            <PluginLogoImage source={pluginLogoSource(row)} className="size-full rounded-2xs" />
          </DetailLogo>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="heading-base break-words text-token-foreground">{name}</h1>
            <div className="text-xs leading-4 text-(--color-text-secondary)">
              <div className="line-clamp-3 w-full">{pluginTagline(view)}</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ToolbarButton
            color="outline"
            onClick={() => {
              const target = selectorToRouteTarget(row);
              rememberPluginTitle(target.pluginId, name);
              navigation.onOpenCustomize(buildPluginDetailPath(target));
            }}
          >
            View details
          </ToolbarButton>
          {row.canUninstall ? (
            <ToolbarButton
              color="outline"
              disabled={pending === "uninstalling"}
              className="border-(--color-text-danger) bg-transparent text-(--color-text-danger)"
              onClick={() => {
                void actions.uninstall(row).then(onBack);
              }}
            >
              {pending === "uninstalling" ? "Uninstalling" : "Uninstall"}
            </ToolbarButton>
          ) : null}
        </div>
      </header>
      {view.skills.length > 0 ? (
        <SettingsCardSection title="Skills">
          {view.skills.map((skill) => (
            <PluginSkillSettingsRow
              key={skill.path ?? skill.name}
              view={view}
              skill={skill}
              context={context}
              navigation={navigation}
            />
          ))}
        </SettingsCardSection>
      ) : null}
      <SettingsCardSection title="About">
        {installedAt == null ? null : (
          <AboutRow label="Connected on">{INSTALLED_DATE.format(installedAt * 1000)}</AboutRow>
        )}
        {meta?.developerName ? <AboutRow label="Developer">{meta.developerName}</AboutRow> : null}
        {version ? <AboutRow label="Version">{version}</AboutRow> : null}
        {meta?.websiteUrl ? (
          <AboutRow label="Website">
            <AboutLink href={meta.websiteUrl}>{meta.websiteUrl}</AboutLink>
          </AboutRow>
        ) : null}
        {meta?.privacyPolicyUrl ? (
          <AboutRow label="Privacy policy">
            <AboutLink href={meta.privacyPolicyUrl}>View privacy policy</AboutLink>
          </AboutRow>
        ) : null}
        {meta?.termsOfServiceUrl ? (
          <AboutRow label="Terms of service">
            <AboutLink href={meta.termsOfServiceUrl}>View terms of service</AboutLink>
          </AboutRow>
        ) : null}
      </SettingsCardSection>
    </div>
  );
}

/**
 * One installed plugin in Settings › Plugins: its skills with their switches and what is known
 * about it, with a way back to its details and to uninstall it.
 */
export function PluginSettingsPage({
  target,
  context,
  navigation,
  onBack,
}: {
  readonly target: PluginRouteTarget;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
  readonly onBack: () => void;
}) {
  const detail = usePluginDetail(context, routeTargetToSelector(target));
  const title = detail.data == null ? null : pluginDisplayName(detail.data.row);

  let content: ReactNode;
  if (detail.data != null) {
    content = (
      <PluginSettingsContent
        view={detail.data}
        context={context}
        navigation={navigation}
        onBack={onBack}
      />
    );
  } else if (detail.isError) {
    content = <PageEmptyState title="Failed to load plugin" description={detail.error.message} />;
  } else {
    content = (
      <div
        role="status"
        className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
      >
        <ActivitySpinnerIcon className="icon-xs shrink-0" />
        Loading settings…
      </div>
    );
  }

  return (
    <main className="flex h-full min-h-0 w-full flex-col" style={CODEX_SETTINGS_SHELL_STYLE}>
      <div className="flex h-toolbar items-center px-panel">
        <ToolbarBreadcrumb
          ancestors={[{ id: "plugin-settings", label: "Plugin settings", onSelect: onBack }]}
          current={title ?? undefined}
        />
      </div>
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          data-density="compact"
          className={cn(
            "group/settings mx-auto flex w-full max-w-3xl flex-col px-panel pt-panel pb-panel",
          )}
        >
          {content}
        </div>
      </div>
    </main>
  );
}
