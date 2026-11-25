import { cn } from "../../lib/utils";
import { NODEX_LOGO_MASK_IMAGE } from "../../../shared/nodex-logo";

const MASK_STYLE = {
  WebkitMaskImage: NODEX_LOGO_MASK_IMAGE,
  maskImage: NODEX_LOGO_MASK_IMAGE,
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
  maskSize: "contain",
} as const;

export function NodexLogoShimmer({ className }: { readonly className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative inline-flex size-14 shrink-0", className)}>
      <div className="nodex-logo-shimmer-base absolute inset-0" style={MASK_STYLE} />
      <div
        className="nodex-logo-shimmer-overlay pointer-events-none absolute inset-0"
        style={MASK_STYLE}
      >
        <span className="nodex-logo-shimmer-sweep absolute inset-y-0 block" />
      </div>
    </div>
  );
}
