declare module "*.css";
declare module "*.css?inline" {
  const stylesheet: string;
  export default stylesheet;
}
declare module "*.svg?raw" {
  const source: string;
  export default source;
}
declare module "*.svg" {
  const source: string;
  export default source;
}
