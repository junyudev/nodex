import { useIntl } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ExternalLinkIcon } from "@/components/shared/icons/plugin-detail-icons";
import { DetailProperty, DetailSection } from "@/components/ui/detail-page";
import { openExternalUrl } from "@/lib/file-system-operations";
import { includesGoogleApp, pluginLegalNoticeVariant } from "../model/plugin-detail-model";
import { pluginDisplayName } from "../model/plugin-labels";
import type { PluginDetailView } from "../plugin-management";

const CLAMP_CLASS = "line-clamp-3";

function openInBrowser(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault();
  void openExternalUrl(href);
}

/** A 20px link glyph whose hover plate reaches 4px past it. */
function ExternalLinkIconButton({
  label,
  href,
}: {
  readonly label: string;
  readonly href: string;
}) {
  return (
    <a
      aria-label={label}
      href={href}
      className="relative isolate inline-flex size-5 cursor-interaction items-center justify-center rounded-md text-token-foreground! outline-none before:absolute before:-inset-1 before:-z-10 before:rounded-md before:content-[''] hover:before:bg-token-list-hover-background focus-visible:before:ring-1 focus-visible:before:ring-token-focus-border"
      onClick={(event) => openInBrowser(event, href)}
    >
      <ExternalLinkIcon className="icon-xs" />
    </a>
  );
}

/** Capabilities fold to three lines with a "Show more" toggle when they run longer. */
function CollapsibleCapabilities({ text }: { readonly text: string }) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element == null) return;
    const update = () => {
      const clamped = element.classList.contains(CLAMP_CLASS);
      element.classList.remove(CLAMP_CLASS);
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
      const next = element.scrollHeight > lineHeight * 3 + 0.5;
      if (clamped) element.classList.add(CLAMP_CLASS);
      setOverflows(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div>
      <div ref={ref} className={overflows && !expanded ? CLAMP_CLASS : undefined}>
        {text}
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1.5 inline-flex cursor-interaction items-center gap-1 self-start text-base text-token-description-foreground select-none hover:text-token-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? intl.formatMessage({
                id: "plugins.pluginInformation.showLess",
                defaultMessage: "Show less",
              })
            : intl.formatMessage({
                id: "plugins.pluginInformation.showMore",
                defaultMessage: "Show more",
              })}
        </button>
      ) : null}
    </div>
  );
}

/** Capabilities, developer, category, version, and the plugin's links. Website always shows. */
export function PluginInformation({ view }: { readonly view: PluginDetailView }) {
  const intl = useIntl();
  const meta = view.summary.interface;
  if (meta == null) return null;
  const capabilities = meta.capabilities.join(", ");
  const developer = meta.developerName?.trim();
  const category = meta.category?.trim();
  const version = (view.summary.localVersion ?? view.summary.version)?.trim();
  if (
    !capabilities &&
    !developer &&
    !category &&
    !version &&
    !meta.websiteUrl &&
    !meta.privacyPolicyUrl &&
    !meta.termsOfServiceUrl
  ) {
    return null;
  }
  return (
    <DetailSection
      id="plugin-information"
      title={intl.formatMessage({
        id: "plugins.pluginInformation.information",
        defaultMessage: "Information",
      })}
    >
      <dl>
        {capabilities ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.capabilities",
              defaultMessage: "Capabilities",
            })}
            align="start"
          >
            <CollapsibleCapabilities text={capabilities} />
          </DetailProperty>
        ) : null}
        {developer ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.developer",
              defaultMessage: "Developer",
            })}
          >
            {developer}
          </DetailProperty>
        ) : null}
        {category ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.category",
              defaultMessage: "Category",
            })}
          >
            {category}
          </DetailProperty>
        ) : null}
        {version ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.version",
              defaultMessage: "Version",
            })}
          >
            {version}
          </DetailProperty>
        ) : null}
        <DetailProperty
          label={intl.formatMessage({
            id: "plugins.pluginInformation.website",
            defaultMessage: "Website",
          })}
        >
          {meta.websiteUrl ? (
            <ExternalLinkIconButton
              label={intl.formatMessage({
                id: "plugins.pluginInformation.website",
                defaultMessage: "Website",
              })}
              href={meta.websiteUrl}
            />
          ) : (
            intl.formatMessage({
              id: "plugins.pluginInformation.unavailable",
              defaultMessage: "Unavailable",
            })
          )}
        </DetailProperty>
        {meta.privacyPolicyUrl ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.privacyPolicy",
              defaultMessage: "Privacy Policy",
            })}
          >
            <ExternalLinkIconButton
              label={intl.formatMessage({
                id: "plugins.pluginInformation.privacyPolicy",
                defaultMessage: "Privacy Policy",
              })}
              href={meta.privacyPolicyUrl}
            />
          </DetailProperty>
        ) : null}
        {meta.termsOfServiceUrl ? (
          <DetailProperty
            label={intl.formatMessage({
              id: "plugins.pluginInformation.termsOfService",
              defaultMessage: "Terms of Service",
            })}
          >
            <ExternalLinkIconButton
              label={intl.formatMessage({
                id: "plugins.pluginInformation.termsOfService",
                defaultMessage: "Terms of Service",
              })}
              href={meta.termsOfServiceUrl}
            />
          </DetailProperty>
        ) : null}
      </dl>
    </DetailSection>
  );
}

/** An always-underlined link that opens in the browser, or plain text without a URL. */
function LegalLink({
  href,
  children,
}: {
  readonly href: string | null;
  readonly children: ReactNode;
}) {
  if (href == null) return <>{children}</>;
  return (
    <a
      href={href}
      className="cursor-interaction text-info! underline! underline-offset-2"
      onClick={(event) => openInBrowser(event, href)}
    >
      {children}
    </a>
  );
}

const MEMORY_FAQ_URL = "https://help.openai.com/en/articles/8590148-memory-faq";
const ELEVATED_RISK_URL = "https://help.openai.com/en/articles/20001062-elevated-risk-labels";
const APPS_LEARN_MORE_URL = "https://help.openai.com/en/articles/11487775-apps-in-chatgpt";
const GOOGLE_APPS_URL =
  "https://help.openai.com/en/articles/10408842-google-app-for-chatgpt-data-controls-faq";

/** How connected apps may use chat data, shown under plugins that include apps. */
export function PluginLegalNotice({ view }: { readonly view: PluginDetailView }) {
  const intl = useIntl();
  const variant = pluginLegalNoticeVariant(view.apps.length);
  if (variant === "none") return null;
  const meta = view.summary.interface;
  const name = pluginDisplayName(view);
  const shared = intl.formatMessage(
    {
      id: "plugins.pluginInformation.memoryPrivacy",
      defaultMessage:
        "If you have <memory>Memory</memory> enabled, data from the app may be used to proactively provide helpful information or suggestions. ChatGPT always respects your training data preferences, including for data from connected apps. Use of apps may come with <risk>elevated risk</risk>. You can manage your preferences or disconnect from apps anytime in your settings. <learn>Learn more</learn>",
    },
    {
      memory: (chunks) => <LegalLink href={MEMORY_FAQ_URL}>{chunks}</LegalLink>,
      risk: (chunks) => <LegalLink href={ELEVATED_RISK_URL}>{chunks}</LegalLink>,
      learn: (chunks) => <LegalLink href={APPS_LEARN_MORE_URL}>{chunks}</LegalLink>,
    },
  );
  return (
    <div className="flex flex-col gap-3 px-(--detail-page-inline-inset) text-sm leading-5 text-tertiary select-text">
      <p>
        {variant === "single" ? (
          <>
            {intl.formatMessage(
              {
                id: "plugins.pluginInformation.singleAppPrivacy",
                defaultMessage:
                  "When connected to {name}, ChatGPT may share relevant chats and memories with this app to help provide context for your requests. {name}’s use of this data is subject to their <terms>terms</terms> and <policy>privacy policy</policy>.",
              },
              {
                name,
                terms: (chunks) => (
                  <LegalLink href={meta?.termsOfServiceUrl ?? null}>{chunks}</LegalLink>
                ),
                policy: (chunks) => (
                  <LegalLink href={meta?.privacyPolicyUrl ?? null}>{chunks}</LegalLink>
                ),
              },
            )}{" "}
          </>
        ) : (
          <>
            {intl.formatMessage({
              id: "plugins.pluginInformation.privacyMultipleApps",
              defaultMessage:
                "This plugin may contain one or more apps, as listed above. When connected to an app, ChatGPT may share relevant chats and memories with the app to help provide context for your requests. An app’s use of this data is subject to their terms and privacy policy, which can be found on the app’s page.",
            })}{" "}
          </>
        )}
        {shared}
      </p>
      {includesGoogleApp(view.apps) ? (
        <p>
          {intl.formatMessage({
            id: "plugins.pluginInformation.privacyGoogleApps",
            defaultMessage:
              "Note on Google apps: This plugin may contain one or more Google apps, as listed above. Any data synced from these apps may be used to provide you with relevant and personalized information. We do not train generalized models on this data or derivations of it, except those submitted in feedback or included in ChatGPT’s response. You can delete your conversations, which will also delete any app data used in those conversations.",
          })}{" "}
          <LegalLink href={GOOGLE_APPS_URL}>
            {intl.formatMessage({
              id: "plugins.pluginInformation.learnMore",
              defaultMessage: "Learn more",
            })}
          </LegalLink>
        </p>
      ) : null}
    </div>
  );
}
