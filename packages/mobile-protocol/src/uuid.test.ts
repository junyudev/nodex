import { expect, test } from "vite-plus/test";
import { createUuidV7 } from "./index";

test("mints a canonical timestamped UUID-v7 without mutating the random bytes", () => {
  const random = new Uint8Array(16).fill(0xff);
  const id = createUuidV7((length) => {
    expect(length).toBe(16);
    return random;
  }, 0x1234abcdef12 + 0.5);

  expect(id).toBe("1234abcd-ef12-7fff-bfff-ffffffffffff");
  expect(random).toEqual(new Uint8Array(16).fill(0xff));
});

test.each([-1, NaN, Infinity])("rejects an invalid UUID-v7 timestamp %s", (timestamp) => {
  expect(() => createUuidV7((length) => new Uint8Array(length), timestamp)).toThrow();
});
