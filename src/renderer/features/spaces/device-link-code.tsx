import { encode } from "uqr";

export function DeviceLinkCode({ uri }: { readonly uri: string }) {
  // A screen doesn't get scuffed, so the lowest correction level buys a coarser, easier-to-scan code.
  const { data, size } = encode(uri, { ecc: "L", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((filled, x) => {
      if (filled) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      aria-label="Device link code"
      className="size-60 shrink-0 rounded-lg bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
