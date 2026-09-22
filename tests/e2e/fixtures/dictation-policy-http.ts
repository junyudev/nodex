import type { ElectronApplication } from "playwright";

interface DictationPolicyHttpEvidence {
  readonly bootstrapRequests: number;
  readonly settingsRequests: number;
  readonly transcriptionBytes: readonly number[];
  readonly invalidRequests: readonly string[];
}

/** An account-matched HTTP response at Electron's network edge; the real policy owner decodes it. */
export async function installDictationPolicyHttpFixture(
  application: ElectronApplication,
  options: { readonly streaming?: boolean; readonly transcription?: string } = {},
): Promise<void> {
  await application.evaluate(({ net }, options) => {
    const originalFetch = net.fetch.bind(net);
    const evidence = {
      bootstrapRequests: 0,
      settingsRequests: 0,
      transcriptionBytes: [] as number[],
      invalidRequests: [] as string[],
    };
    Object.assign(globalThis, { dictationPolicyHttpEvidence: evidence });
    const accountId = "queue-scenario";
    const userId = "queue-user";
    const token = `fixture.${Buffer.from(
      JSON.stringify({
        exp: 4102444800,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: userId },
      }),
    ).toString("base64url")}.unsigned`;
    net.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const bootstrap = url.pathname === "/backend-api/wham/statsig/bootstrap";
      const settings = url.pathname === "/backend-api/settings/user";
      const transcription =
        options.transcription !== undefined && url.pathname === "/backend-api/transcribe";
      if (url.origin !== "https://chatgpt.com" || (!bootstrap && !settings && !transcription))
        return originalFetch(input, init);
      const headers = new Headers(init?.headers);
      const expectedMethod = bootstrap || transcription ? "POST" : "GET";
      if (
        (init?.method ?? "GET") !== expectedMethod ||
        headers.get("authorization") !== `Bearer ${token}` ||
        headers.get("chatgpt-account-id") !== accountId
      ) {
        evidence.invalidRequests.push(`Unexpected account or method: ${url.pathname}`);
        return Response.json({ error: "Fixture identity mismatch" }, { status: 403 });
      }
      if (bootstrap) {
        evidence.bootstrapRequests += 1;
        const metadata =
          typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (
          metadata.brand_name !== "chatgpt" ||
          metadata.window_type !== "electron" ||
          typeof metadata.app_version !== "string" ||
          headers.get("x-openai-expected-account-id") !== accountId
        ) {
          evidence.invalidRequests.push("Unexpected bootstrap metadata or expected-account header");
          return Response.json({ error: "Fixture bootstrap mismatch" }, { status: 400 });
        }
        return Response.json({
          statsigPayload: JSON.stringify({
            has_updates: true,
            hash_used: "none",
            user: { userID: userId, customIDs: { account_id: accountId } },
            feature_gates: {
              "4100906017": { value: true },
              "1244621283": { value: false },
              "770071981": { value: false },
              "codex-app-dictation-streaming": { value: options.streaming ?? false },
              "codex-app-dictation-sounds": { value: true },
            },
            dynamic_configs: {
              "3845962714": { value: { dictation_custom_dictionary_enabled: false } },
            },
          }),
        });
      }
      if (transcription) {
        const payload = init?.body instanceof ArrayBuffer ? Buffer.from(init.body) : Buffer.alloc(0);
        const mediaOffset = payload.indexOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        if (
          headers.has("x-codex-base64") ||
          !headers.get("content-type")?.startsWith("multipart/form-data; boundary=") ||
          mediaOffset < 0 ||
          !payload.includes(Buffer.from('name="file"')) ||
          payload.includes(Buffer.from('name="language"'))
        ) {
          evidence.invalidRequests.push(
            "Expected the native WebM recorder multipart payload without a language override",
          );
          return Response.json({ error: "Invalid recording" }, { status: 400 });
        }
        evidence.transcriptionBytes.push(payload.byteLength - mediaOffset);
        return Response.json({ text: options.transcription });
      }
      evidence.settingsRequests += 1;
      return Response.json({ settings: { voice_main_language: "auto" } });
    };
  }, options);
}

export async function readDictationPolicyHttpEvidence(
  application: ElectronApplication,
): Promise<DictationPolicyHttpEvidence> {
  return application.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          dictationPolicyHttpEvidence: DictationPolicyHttpEvidence;
        }
      ).dictationPolicyHttpEvidence,
  );
}
