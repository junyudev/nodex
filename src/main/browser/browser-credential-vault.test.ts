import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BrowserCredentialVault } from "./browser-credential-vault";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createVault(available = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-vault-"));
  roots.push(root);
  return new BrowserCredentialVault({
    filePath: path.join(root, "secrets", "browser-credentials.v1.json"),
    encryption: {
      isAvailable: () => available,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString().slice("encrypted:".length),
    },
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
}

describe("BrowserCredentialVault", () => {
  test("persists encrypted secrets while exposing summary-only listings", async () => {
    const vault = createVault();
    const summary = await vault.save({
      origin: "https://example.com/login?next=private",
      username: "person@example.com",
      password: "correct horse battery staple",
    });

    expect(await vault.listForOrigin("https://example.com/other")).toEqual([summary]);
    const raw = fs.readFileSync(
      path.join(roots[0]!, "secrets", "browser-credentials.v1.json"),
      "utf8",
    );
    expect(raw).not.toContain("correct horse battery staple");
    if (process.platform !== "win32") {
      expect(
        fs.statSync(path.join(roots[0]!, "secrets", "browser-credentials.v1.json")).mode & 0o077,
      ).toBe(0);
    }
    expect((await vault.get(summary.id))?.password).toBe("correct horse battery staple");
  });

  test("uses origin and username as the idempotent credential key", async () => {
    const vault = createVault();
    const first = await vault.save({
      origin: "https://example.com",
      username: "person",
      password: "first-secret",
    });
    const second = await vault.save({
      origin: "https://example.com/settings",
      username: "person",
      password: "replacement-secret",
    });

    expect(second.id).toBe(first.id);
    expect(await vault.list()).toHaveLength(1);
    expect((await vault.get(first.id))?.password).toBe("replacement-secret");
    expect(
      await vault.matches({
        origin: "https://example.com",
        username: "person",
        password: "replacement-secret",
      }),
    ).toBe(true);
  });

  test("fails closed when secure storage is unavailable", async () => {
    const vault = createVault(false);
    expect(vault.capability()).toMatchObject({
      available: false,
      provider: "unavailable",
    });
    expect(() =>
      vault.save({
        origin: "https://example.com",
        username: "person",
        password: "secret",
      }),
    ).toThrow("unavailable");
  });

  test("generates passwords with every required character class", () => {
    const password = createVault().generate(32);
    expect(password).toHaveLength(32);
    expect(password).toMatch(/[a-z]/u);
    expect(password).toMatch(/[A-Z]/u);
    expect(password).toMatch(/[0-9]/u);
    expect(password).toMatch(/[!@#$%^&*()\-_=+]/u);
  });

  test("encrypts contact info and supports id-preserving edits", async () => {
    const vault = createVault();
    const first = await vault.saveContactInfo({
      label: "Home",
      fullName: "Example Person",
      email: "person@example.com",
      phone: "",
      addressLine1: "1 Private Street",
      addressLine2: "",
      city: "Shanghai",
      region: "",
      postalCode: "200000",
      country: "China",
    });
    const updated = await vault.saveContactInfo({
      id: first.id,
      label: "Primary",
      fullName: first.fullName,
      email: first.email,
      phone: first.phone,
      addressLine1: first.addressLine1,
      addressLine2: first.addressLine2,
      city: "Hangzhou",
      region: first.region,
      postalCode: first.postalCode,
      country: first.country,
    });

    expect(updated.id).toBe(first.id);
    expect(await vault.listContactInfo()).toEqual([updated]);
    const raw = fs.readFileSync(
      path.join(roots[0]!, "secrets", "browser-credentials.v1.json"),
      "utf8",
    );
    expect(raw).not.toContain("person@example.com");
    expect(raw).not.toContain("Private Street");
    await vault.removeContactInfo(updated.id);
    expect(await vault.listContactInfo()).toEqual([]);
  });
});
