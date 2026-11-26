import { useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { PageEmptyState } from "@/components/ui/section-header";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { ToolbarBreadcrumb } from "@/components/ui/toolbar-breadcrumb";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { openExternalUrl } from "@/lib/file-system-operations";
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
import type { PluginsSettingsNavigation } from "./plugins-settings-page";
import { SettingsNavigationRow } from "./settings-navigation-row";
import { DetailDialog } from "./detail-dialog";
import { SkillInstructions } from "./skill-preview-modal";
import { usePluginRowActions } from "./use-plugin-row-actions";

type PluginSkill = PluginDetailView["skills"][number];

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
  const intl = useIntl();
  const management = usePluginManagement(context);
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const name = skill.name.split(":").pop() || skill.name;
  const enabled = optimistic ?? skill.enabled;
  const setEnabled = async (next: boolean) => {
    setOptimistic(next);
    setUpdating(true);
    return runWithCleanup(
      async () => {
        const result = await management.setSkillEnabled(
          skill.name.includes(":") || skill.path == null
            ? { name: skill.name, enabled: next }
            : { path: skill.path, enabled: next },
        );
        if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
        toast.success(
          next
            ? intl.formatMessage(
                {
                  id: "plugins.pluginSettingsPage.skillEnabled",
                  defaultMessage: "{name} skill enabled",
                },
                { name },
              )
            : intl.formatMessage(
                {
                  id: "plugins.pluginSettingsPage.skillDisabled",
                  defaultMessage: "{name} skill disabled",
                },
                { name },
              ),
        );
      },
      {
        onError: () => {
          setOptimistic(null);
          toast.danger(
            intl.formatMessage({
              id: "plugins.pluginSettingsPage.updateSkillFailed",
              defaultMessage: "Failed to update skill",
            }),
          );
        },
        cleanup: () => {
          setUpdating(false);
        },
      },
    );
  };

  return (
    <>
      <SettingsNavigationRow
        label={name}
        description={skill.description}
        onOpen={() => setOpen(true)}
        actions={
          <NodexSwitch
            ariaLabel={intl.formatMessage(
              { id: "plugins.pluginSettingsPage.useSkill", defaultMessage: "Use {name}" },
              { name },
            )}
            checked={enabled}
            disabled={updating || !view.summary.installed}
            onCheckedChange={(next) => void setEnabled(next)}
          />
        }
      />
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
            {intl.formatMessage({
              id: "plugins.pluginSettingsPage.tryNow",
              defaultMessage: "Try now",
            })}
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
    <NodexSettingsRow label={label}>
      <span className="min-w-0 text-sm wrap-anywhere text-token-text-secondary">{children}</span>
    </NodexSettingsRow>
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

function PluginSettingsContent({
  view,
  context,
  navigation,
  onBack,
  backSlot,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
  readonly onBack: () => void;
  readonly backSlot: ReactNode;
}) {
  const intl = useIntl();
  const row = view.row;
  const actions = usePluginRowActions(context, navigation);
  const pending = usePendingPluginActions().get(row.stableIdentity);
  const meta = view.summary.interface;
  const version = (view.summary.localVersion ?? view.summary.version)?.trim();
  const installedAt = view.summary.installedAt;
  const name = pluginDisplayName(row);

  return (
    <NodexSettingsPageSurface
      title={name}
      subtitle={pluginTagline(view)}
      backSlot={backSlot}
      action={
        <div className="flex max-w-[42vw] flex-wrap justify-end gap-2">
          <NodexButton
            size="toolbar"
            variant="secondary"
            onClick={() => {
              const target = selectorToRouteTarget(row);
              rememberPluginTitle(target.pluginId, name);
              navigation.onOpenCustomize(buildPluginDetailPath(target));
            }}
          >
            {intl.formatMessage({
              id: "plugins.pluginSettingsPage.viewDetails",
              defaultMessage: "View details",
            })}
          </NodexButton>
          {row.canUninstall ? (
            <NodexButton
              size="toolbar"
              variant="destructive"
              disabled={pending === "uninstalling"}
              onClick={() => {
                void actions.uninstall(row).then(onBack);
              }}
            >
              {pending === "uninstalling"
                ? intl.formatMessage({
                    id: "plugins.pluginSettingsPage.uninstalling",
                    defaultMessage: "Uninstalling",
                  })
                : intl.formatMessage({
                    id: "plugins.pluginSettingsPage.uninstall",
                    defaultMessage: "Uninstall",
                  })}
            </NodexButton>
          ) : null}
        </div>
      }
    >
      {view.skills.length > 0 ? (
        <NodexSettingsSection
          title={intl.formatMessage({
            id: "plugins.pluginSettingsPage.skills",
            defaultMessage: "Skills",
          })}
        >
          {view.skills.map((skill) => (
            <PluginSkillSettingsRow
              key={skill.path ?? skill.name}
              view={view}
              skill={skill}
              context={context}
              navigation={navigation}
            />
          ))}
        </NodexSettingsSection>
      ) : null}
      <NodexSettingsSection
        title={intl.formatMessage({
          id: "plugins.pluginSettingsPage.about",
          defaultMessage: "About",
        })}
      >
        {installedAt == null ? null : (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.connectedOn",
              defaultMessage: "Connected on",
            })}
          >
            {intl.formatDate(installedAt * 1000, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </AboutRow>
        )}
        {meta?.developerName ? (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.developer",
              defaultMessage: "Developer",
            })}
          >
            {meta.developerName}
          </AboutRow>
        ) : null}
        {version ? (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.version",
              defaultMessage: "Version",
            })}
          >
            {version}
          </AboutRow>
        ) : null}
        {meta?.websiteUrl ? (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.website",
              defaultMessage: "Website",
            })}
          >
            <AboutLink href={meta.websiteUrl}>{meta.websiteUrl}</AboutLink>
          </AboutRow>
        ) : null}
        {meta?.privacyPolicyUrl ? (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.privacyPolicy",
              defaultMessage: "Privacy policy",
            })}
          >
            <AboutLink href={meta.privacyPolicyUrl}>
              {intl.formatMessage({
                id: "plugins.pluginSettingsPage.viewPrivacyPolicy",
                defaultMessage: "View privacy policy",
              })}
            </AboutLink>
          </AboutRow>
        ) : null}
        {meta?.termsOfServiceUrl ? (
          <AboutRow
            label={intl.formatMessage({
              id: "plugins.pluginSettingsPage.termsOfService",
              defaultMessage: "Terms of service",
            })}
          >
            <AboutLink href={meta.termsOfServiceUrl}>
              {intl.formatMessage({
                id: "plugins.pluginSettingsPage.viewTermsOfService",
                defaultMessage: "View terms of service",
              })}
            </AboutLink>
          </AboutRow>
        ) : null}
      </NodexSettingsSection>
    </NodexSettingsPageSurface>
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
  const intl = useIntl();
  const detail = usePluginDetail(context, routeTargetToSelector(target));
  const backSlot = (
    <ToolbarBreadcrumb
      variant="settings"
      ancestors={[
        {
          id: "plugin-settings",
          label: intl.formatMessage({
            id: "plugins.pluginSettingsPage.settings",
            defaultMessage: "Plugin settings",
          }),
          onSelect: onBack,
        },
      ]}
      current={detail.data ? pluginDisplayName(detail.data.row) : undefined}
    />
  );

  if (detail.data != null) {
    return (
      <PluginSettingsContent
        view={detail.data}
        context={context}
        navigation={navigation}
        onBack={onBack}
        backSlot={backSlot}
      />
    );
  }

  let content: ReactNode;
  if (detail.isError) {
    content = (
      <PageEmptyState
        title={intl.formatMessage({
          id: "plugins.pluginSettingsPage.loadFailed",
          defaultMessage: "Failed to load plugin",
        })}
        description={detail.error.message}
      />
    );
  } else {
    content = (
      <div
        role="status"
        className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
      >
        <ActivitySpinnerIcon className="icon-xs shrink-0" />
        {intl.formatMessage({
          id: "plugins.pluginSettingsPage.loading",
          defaultMessage: "Loading settings…",
        })}
      </div>
    );
  }

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "plugins.pluginSettingsPage.settings",
        defaultMessage: "Plugin settings",
      })}
      backSlot={backSlot}
    >
      {content}
    </NodexSettingsPageSurface>
  );
}
