declare module "bun:test" {
  export const describe: (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;
  export const test: (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;
  export const expect: (value: unknown) => {
    toBe: (expected: unknown) => void;
    toBeTrue: () => void;
    toBeFalse: () => void;
    not: {
      toBeNull: () => void;
    };
  };
  export const mock: {
    module: (modulePath: string, factory: () => unknown) => void;
  };
}
