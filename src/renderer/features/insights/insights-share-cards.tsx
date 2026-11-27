import { defineMessage, getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useEffect, useState } from "react";

import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexCompactFramedInput } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { darkAppearanceScope } from "@/lib/appearance-scope";

import { loadShareCardFonts, renderCardPng, svgImageSource } from "./insights-card-export";
import {
  renderShareCard,
  shareFileName,
  shareMessage,
  type ShareCardFonts,
  type ShareCardKind,
  type ShareCardOptions,
} from "./insights-cards";
import type { InsightsView } from "./insights-model";
import {
  copyCardImage,
  openPostComposer,
  readCardName,
  saveCardImage,
  writeCardName,
} from "./use-insights";

const CARDS: readonly { readonly kind: ShareCardKind; readonly name: MessageDescriptor }[] = [
  {
    kind: "skyline",
    name: defineMessage({ id: "insights.insightsShareCards.skyline", defaultMessage: "Skyline" }),
  },
  {
    kind: "receipt",
    name: defineMessage({ id: "insights.insightsShareCards.receipt", defaultMessage: "Receipt" }),
  },
];

type ShareAction = "copy" | "save" | "post";

/** Fonts come from the app bundle asynchronously; the cards draw once they settle. */
function useShareCardFonts() {
  const [fonts, setFonts] = useState<{ readonly value: ShareCardFonts | null } | null>(null);
  useEffect(() => {
    let current = true;
    void loadShareCardFonts().then((value) => {
      if (current) setFonts({ value });
    });
    return () => {
      current = false;
    };
  }, []);
  return fonts;
}

async function shareCard(
  view: InsightsView,
  kind: ShareCardKind,
  svg: string,
  action: ShareAction,
) {
  const intl = getIntl();
  const png = await renderCardPng(svg);
  if (action === "save") {
    const { status } = await saveCardImage(png, shareFileName(view, kind));
    if (status === "saved")
      toast.success(
        intl.formatMessage({
          id: "insights.insightsShareCards.saved",
          defaultMessage: "Card saved",
        }),
      );
    return;
  }
  const copied = await copyCardImage(png);
  if (!copied.ok) throw new Error(copied.message);
  if (action === "copy") {
    toast.success(
      intl.formatMessage({
        id: "insights.insightsShareCards.copied",
        defaultMessage: "Image copied",
      }),
    );
    return;
  }
  await openPostComposer(shareMessage(view));
  toast.info(
    intl.formatMessage({
      id: "insights.insightsShareCards.copiedForPost",
      defaultMessage: "Image copied. Paste it into your post.",
    }),
  );
}

function ShareCard({
  view,
  name,
  svg,
  disabled,
  onShare,
}: {
  readonly view: InsightsView;
  readonly name: string;
  readonly svg: string | null;
  readonly disabled: boolean;
  readonly onShare: (svg: string, action: ShareAction) => void;
}) {
  const intl = useIntl();
  const actions: readonly { readonly action: ShareAction; readonly label: string }[] = [
    {
      action: "copy",
      label: intl.formatMessage({
        id: "insights.insightsShareCards.copy",
        defaultMessage: "Copy image",
      }),
    },
    {
      action: "save",
      label: intl.formatMessage({
        id: "insights.insightsShareCards.savePng",
        defaultMessage: "Save PNG",
      }),
    },
    {
      action: "post",
      label: intl.formatMessage({
        id: "insights.insightsShareCards.post",
        defaultMessage: "Post on X",
      }),
    },
  ];
  return (
    <figure aria-label={name} className="group relative m-0 min-w-0">
      {/* The page shows the exported picture itself, so what you see is what is shared. */}
      {svg === null ? (
        <div aria-hidden="true" className="aspect-[4/5] w-full rounded-xl bg-[#08080a]" />
      ) : (
        <img
          src={svgImageSource(svg)}
          alt={intl.formatMessage(
            {
              id: "insights.insightsShareCards.cardAlt",
              defaultMessage: "{name} card: {summary}",
            },
            { name, summary: shareMessage(view, intl) },
          )}
          className="block aspect-[4/5] w-full rounded-xl shadow-md ring-[0.5px] ring-(--color-border-default)"
        />
      )}
      <div
        {...darkAppearanceScope(
          "absolute inset-x-0 bottom-4 flex justify-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <div className="mx-2 flex flex-wrap items-center justify-center gap-0.5 rounded-xl bg-[#1d1d21]/85 p-1 shadow-lg ring-[0.5px] ring-white/12 backdrop-blur-md">
          {actions.map(({ action, label }) => (
            <NodexButton
              key={action}
              variant="ghost"
              size="toolbar"
              disabled={svg === null || disabled}
              onClick={() => {
                if (svg !== null) onShare(svg, action);
              }}
            >
              {label}
            </NodexButton>
          ))}
        </div>
      </div>
    </figure>
  );
}

/** Both cards for the period on the page, each ready to copy, save or post as it stands. */
export function InsightsShareCards({ view }: { readonly view: InsightsView }) {
  const intl = useIntl();
  const fonts = useShareCardFonts();
  const [showCost, setShowCost] = useState(true);
  const [name, setName] = useState(readCardName);
  const [busy, setBusy] = useState(false);
  const options: Omit<ShareCardOptions, "kind"> = { showCost, name };

  const share = (kind: ShareCardKind, svg: string, action: ShareAction) => {
    setBusy(true);
    void shareCard(view, kind, svg, action)
      .catch(() =>
        toast.danger(
          getIntl().formatMessage({
            id: "insights.insightsShareCards.generateFailed",
            defaultMessage: "Could not make the image",
          }),
        ),
      )
      .finally(() => setBusy(false));
  };

  const showCostLabel = intl.formatMessage({
    id: "insights.insightsShareCards.showCost",
    defaultMessage: "Show cost",
  });
  return (
    <section
      aria-label={intl.formatMessage({
        id: "insights.insightsShareCards.label",
        defaultMessage: "Cards to share",
      })}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-2 gap-4">
        {CARDS.map(({ kind, name: cardName }) => (
          <ShareCard
            key={kind}
            view={view}
            name={intl.formatMessage(cardName)}
            svg={fonts === null ? null : renderShareCard(view, { kind, ...options }, fonts.value)}
            disabled={busy || view.tokens === 0}
            onShare={(svg, action) => share(kind, svg, action)}
          />
        ))}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-x-6 gap-y-2 text-xs text-tertiary">
        <label className="flex items-center gap-2">
          {intl.formatMessage({
            id: "insights.insightsShareCards.cardName",
            defaultMessage: "Name on card",
          })}
          <NodexCompactFramedInput
            className="w-40 text-xs"
            value={name}
            maxLength={32}
            placeholder={intl.formatMessage({
              id: "insights.insightsShareCards.optional",
              defaultMessage: "Optional",
            })}
            onChange={(event) => {
              setName(event.target.value);
              writeCardName(event.target.value);
            }}
          />
        </label>
        {view.costUsd > 0 ? (
          <span className="flex items-center gap-2">
            {showCostLabel}
            <NodexSwitch
              size="compact"
              ariaLabel={showCostLabel}
              checked={showCost}
              onCheckedChange={setShowCost}
            />
          </span>
        ) : null}
        <p className="ml-auto">
          {intl.formatMessage({
            id: "insights.insightsShareCards.localOnly",
            defaultMessage: "Made on this device. Nothing is uploaded unless you post it.",
          })}
        </p>
      </div>
    </section>
  );
}
