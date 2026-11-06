import { ClaudeIcon, OpenAIIcon } from "@/components/shared/icons";
import { NodexSettingsSection } from "@/components/ui/settings";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  formatNodexCreditPrice,
  formatNodexMultiplier,
  formatNodexTokenUnit,
  formatNodexUsdPrice,
  hasNodexListPriceRow,
  nodexModelPriceRows,
  visibleNodexPriceColumns,
  type NodexPriceKey,
  type NodexPriceRow,
} from "@/lib/nodex-model-prices";
import { cn } from "@/lib/utils";
import type { NodexModelPricing } from "../../../shared/nodex-account";

/** The rate is the same mark wherever it appears: this table, Models settings and the picker. */
export function NodexRateMark({ multiplier }: { readonly multiplier: number }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1 text-xs tabular-nums",
        multiplier < 1
          ? "bg-(--green-text)/12 text-(--green-text)"
          : "bg-token-foreground/[0.07] text-token-text-secondary",
      )}
    >
      {formatNodexMultiplier(multiplier)}
    </span>
  );
}

function ProviderMark({ provider }: { readonly provider: string }) {
  if (provider === "openai") return <OpenAIIcon className="size-3.5" />;
  if (provider === "anthropic") return <ClaudeIcon className="size-3.5" />;
  return <span aria-hidden="true" className="size-3.5 shrink-0" />;
}

const PRICE_ROW_GRID = "grid items-center gap-x-4 px-4";

function PriceCell({
  row,
  column,
  creditsPerUsd,
}: {
  readonly row: NodexPriceRow;
  readonly column: NodexPriceKey;
  readonly creditsPerUsd: number;
}) {
  const value = row.effective[column];
  const reference = row.reference[column];
  const price = (
    <span
      className={cn(
        value === null
          ? "text-token-description-foreground"
          : row.multiplier !== null && row.multiplier < 1
            ? "text-(--green-text)"
            : "text-token-text-primary",
      )}
    >
      {formatNodexCreditPrice(value, creditsPerUsd)}
    </span>
  );
  return (
    <span role="cell" className="flex flex-col items-end text-sm tabular-nums">
      {value === null ? (
        price
      ) : (
        <NodexTooltip tooltipContent={formatNodexUsdPrice(value)}>{price}</NodexTooltip>
      )}
      {row.crossesOutReference && reference !== null ? (
        <s className="text-xs leading-4 text-token-description-foreground">
          {formatNodexCreditPrice(reference, creditsPerUsd)}
        </s>
      ) : null}
    </span>
  );
}

/**
 * What credits buy, read straight from the server. Each row is something a person can actually
 * run. Unmarked rows bill at the API list price; a marked row states its rate, and crosses out
 * the list price unless a row of the same model already shows it.
 */
export function NodexModelPrices({
  pricing,
  creditsPerUsd,
  unavailableModels,
  onManageModels,
}: {
  readonly pricing: NodexModelPricing;
  readonly creditsPerUsd: number;
  readonly unavailableModels: readonly string[];
  readonly onManageModels: (() => void) | undefined;
}) {
  const columns = visibleNodexPriceColumns(pricing);
  const gridStyle = {
    gridTemplateColumns: `minmax(0, 1fr) repeat(${columns.length}, 4.75rem)`,
  };
  const models = nodexModelPriceRows(pricing);
  if (models.length === 0) return null;
  const describedGroups = pricing.groups.filter((group) => group.description);
  return (
    <section aria-labelledby="nodex-model-prices-title" className="flex flex-col">
      <div className="flex min-h-toolbar items-baseline justify-between gap-3 pb-1.5">
        <h2 id="nodex-model-prices-title" className="text-base font-medium text-token-text-primary">
          Model prices
        </h2>
        <span className="text-xs text-token-description-foreground">
          Credits per {formatNodexTokenUnit(pricing.perTokens)} tokens
        </span>
      </div>
      <NodexSettingsSection>
        <div
          role="row"
          className={cn(PRICE_ROW_GRID, "min-h-9 py-1.5 text-xs text-token-description-foreground")}
          style={gridStyle}
        >
          <span role="columnheader" className="flex min-w-0 items-center gap-1.5">
            {hasNodexListPriceRow(models) ? (
              <>
                <NodexRateMark multiplier={1} />
                <span className="truncate">API list price</span>
              </>
            ) : (
              <span className="truncate">Model</span>
            )}
          </span>
          {columns.map((column) => (
            <span key={column.key} role="columnheader" className="text-end">
              {column.label}
            </span>
          ))}
        </div>
        {models.map((model) => {
          const unavailable = unavailableModels.includes(model.id);
          return (
            <div
              key={model.id}
              role="rowgroup"
              className={cn("flex flex-col py-1", unavailable && "opacity-45")}
            >
              {model.rows.map((row, index) => (
                <div
                  key={row.key}
                  role="row"
                  className={cn(PRICE_ROW_GRID, "min-h-8 py-0.5", !row.available && "opacity-45")}
                  style={gridStyle}
                >
                  <span role="rowheader" className="flex min-w-0 items-center gap-2">
                    {index === 0 ? (
                      <ProviderMark provider={model.provider} />
                    ) : (
                      <span aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    {index === 0 ? (
                      <span className="truncate text-sm text-token-text-primary">
                        {model.label}
                      </span>
                    ) : null}
                    {row.multiplier !== null ? <NodexRateMark multiplier={row.multiplier} /> : null}
                    {row.groupLabel ? (
                      <span className="truncate text-sm text-token-text-secondary">
                        {row.groupLabel}
                      </span>
                    ) : null}
                    {!row.available || (index === 0 && unavailable) ? (
                      <span className="shrink-0 text-xs text-token-description-foreground">
                        Unavailable
                      </span>
                    ) : null}
                  </span>
                  {columns.map((column) => (
                    <PriceCell
                      key={column.key}
                      row={row}
                      column={column.key}
                      creditsPerUsd={creditsPerUsd}
                    />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </NodexSettingsSection>
      <div className="flex flex-col gap-1 px-1 pt-2.5 text-xs leading-4 text-token-description-foreground">
        {describedGroups.map((group) => (
          <p key={group.id} className="m-0">
            <span className="text-token-text-secondary">{group.label}.</span> {group.description}
          </p>
        ))}
        <p className="m-0">
          Charged to your credits as you use each model.
          {pricing.notes.length > 0 ? ` ${pricing.notes.join(" ")}` : ""}
          {onManageModels ? (
            <>
              {" "}
              <button
                type="button"
                onClick={onManageModels}
                className="cursor-interaction text-token-text-secondary underline-offset-2 hover:text-token-text-primary hover:underline"
              >
                Choose which models can spend credits
              </button>
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}
