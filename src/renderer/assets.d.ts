declare module "*?url" {
  const url: string;
  export default url;
}

/** An asset served as its own file, never inlined into the importing chunk. */
declare module "*?url&no-inline" {
  const url: string;
  export default url;
}
