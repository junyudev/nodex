/** JSON Schema uniqueItems uses value equality; these tool arrays contain scalar identities. */
export const uniqueScalarValues = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;
