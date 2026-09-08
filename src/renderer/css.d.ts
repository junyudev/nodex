declare module "*.css";
declare module "*.svg?raw" {
  const source: string;
  export default source;
}
declare module "*.svg" {
  const source: string;
  export default source;
}
