import type { ComponentProps } from "react";
import type { NfmTableLayout } from "@/lib/nfm-table-layout";

type NfmReadonlyTableProps = ComponentProps<"table"> & {
  readonly layout: NfmTableLayout;
  readonly columns: readonly (number | undefined)[];
};

export function NfmReadonlyTable({ children, layout, columns, ...props }: NfmReadonlyTableProps) {
  return (
    <div className="nfm-table-scroll my-3">
      <table {...props} className="nfm-table" data-nfm-table-layout={layout}>
        <colgroup>
          {columns.map((width, index) => (
            <col key={index} style={width === undefined ? undefined : { width }} />
          ))}
        </colgroup>
        {children}
      </table>
    </div>
  );
}
