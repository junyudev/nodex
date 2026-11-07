import { useEffect, useState } from "react";

import { BrowseTabs } from "@/components/ui/browse-tabs";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

import { loadShareCardFonts, renderCardPng, svgImageSource } from "./insights-card-export";
import {
  renderShareCard,
  shareFileName,
  shareMessage,
  type ShareCardFonts,
  type ShareCardKind,
} from "./insights-cards";
import { INSIGHTS_PERIODS, type InsightsPeriod, type InsightsView } from "./insights-model";
import {
  copyCardImage,
  openPostComposer,
  readCardName,
  saveCardImage,
  writeCardName,
} from "./use-insights";

const CARD_TABS: readonly { readonly key: ShareCardKind; readonly name: string }[] = [
  { key: "skyline", name: "Skyline" },
  { key: "receipt", name: "Receipt" },
];

export function InsightsShareDialog({
  onClose,
  viewFor,
  initialPeriod,
}: {
  readonly onClose: () => void;
  readonly viewFor: (period: InsightsPeriod) => InsightsView;
  readonly initialPeriod: InsightsPeriod;
}) {
  const [kind, setKind] = useState<ShareCardKind>("skyline");
  const [period, setPeriod] = useState<InsightsPeriod>(initialPeriod);
  const [showCost, setShowCost] = useState(true);
  const [name, setName] = useState(readCardName);
  const [fonts, setFonts] = useState<{ readonly value: ShareCardFonts | null } | null>(null);
  const [busy, setBusy] = useState(false);

  // Fonts come from the app bundle asynchronously; the card draws once they settle.
  useEffect(() => {
    let current = true;
    void loadShareCardFonts().then((value) => {
      if (current) setFonts({ value });
    });
    return () => {
      current = false;
    };
  }, []);

  const view = viewFor(period);
  const svg = fonts === null ? null : renderShareCard(view, { kind, showCost, name }, fonts.value);
  const canPublish = svg !== null && view.tokens > 0;

  const publish = async (action: (png: string) => Promise<void>) => {
    if (svg === null) return;
    setBusy(true);
    await renderCardPng(svg)
      .then(action)
      .catch(() => toast.danger("Could not make the image"));
    setBusy(false);
  };

  const copy = async (png: string) => {
    const result = await copyCardImage(png);
    if (!result.ok) throw new Error(result.message);
  };

  return (
    <NodexDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <NodexDialogContent size="large" className="w-[860px] max-w-[92vw] overflow-hidden p-0">
        <div className="flex max-h-[86vh] min-h-0">
          <div className="flex min-w-0 flex-1 items-center justify-center bg-[#08080a] p-5">
            {svg === null ? (
              <div className="aspect-[4/5] h-[640px] max-h-[78vh]" />
            ) : (
              <img
                src={svgImageSource(svg)}
                alt={`${kind === "skyline" ? "Skyline" : "Receipt"} card: ${shareMessage(view)}`}
                className="aspect-[4/5] h-[640px] max-h-[78vh] rounded-md object-contain shadow-lg"
              />
            )}
          </div>
          <div className="flex w-[280px] shrink-0 flex-col gap-5 p-5">
            <NodexDialogTitle>Share your numbers</NodexDialogTitle>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs text-tertiary">Card</h3>
              <BrowseTabs ariaLabel="Card" tabs={CARD_TABS} selectedKey={kind} onSelect={setKind} />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs text-tertiary">Period</h3>
              <BrowseTabs
                ariaLabel="Card period"
                className="flex-wrap"
                tabs={INSIGHTS_PERIODS.map(({ id, label }) => ({ key: id, name: label }))}
                selectedKey={period}
                onSelect={setPeriod}
              />
            </section>
            <div className="flex items-center justify-between gap-3 text-sm text-(--color-text)">
              Show cost
              <NodexSwitch ariaLabel="Show cost" checked={showCost} onCheckedChange={setShowCost} />
            </div>
            <label className="flex flex-col gap-2 text-xs text-tertiary">
              Name on card
              <Input
                value={name}
                maxLength={32}
                placeholder="Optional"
                onChange={(event) => {
                  setName(event.target.value);
                  writeCardName(event.target.value);
                }}
              />
            </label>
            <div className="mt-auto flex flex-col gap-2">
              <NodexButton
                variant="primary"
                disabled={!canPublish || busy}
                onClick={() =>
                  void publish(async (png) => {
                    await copy(png);
                    toast.success("Image copied");
                  })
                }
              >
                Copy image
              </NodexButton>
              <NodexButton
                variant="outline"
                disabled={!canPublish || busy}
                onClick={() =>
                  void publish(async (png) => {
                    const { status } = await saveCardImage(png, shareFileName(view, kind));
                    if (status === "saved") toast.success("Card saved");
                  })
                }
              >
                Save PNG
              </NodexButton>
              <NodexButton
                variant="outline"
                disabled={!canPublish || busy}
                onClick={() =>
                  void publish(async (png) => {
                    await copy(png);
                    await openPostComposer(shareMessage(view));
                    toast.info("Image copied. Paste it into your post.");
                  })
                }
              >
                Post on X
              </NodexButton>
              <p className="pt-1 text-xs text-tertiary">
                Made on this device. Nothing is uploaded unless you post it.
              </p>
            </div>
          </div>
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}
