const BASE_URL = "https://statsigapi.net/console/v1";

export interface ConsoleResponse {
  readonly status: number;
  readonly body: { readonly data?: unknown; readonly message?: string; readonly errors?: unknown };
}

/** Thin Console API client. The key arrives through the environment and is never logged. */
export const statsigConsole = (apiKey = process.env.STATSIG_CONSOLE_API_KEY) => {
  if (!apiKey) throw new Error("STATSIG_CONSOLE_API_KEY is required.");
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ConsoleResponse> => {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "STATSIG-API-KEY": apiKey,
        "STATSIG-API-VERSION": "20240601",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: ConsoleResponse["body"];
    try {
      parsed = JSON.parse(text) as ConsoleResponse["body"];
    } catch {
      parsed = { message: text.slice(0, 300) };
    }
    return { status: response.status, body: parsed };
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body: unknown) => request("POST", path, body),
    put: (path: string, body: unknown) => request("PUT", path, body),
    patch: (path: string, body: unknown) => request("PATCH", path, body),
  };
};

export const requireSuccess = (label: string, response: ConsoleResponse): unknown => {
  if (response.status >= 200 && response.status < 300) return response.body.data;
  throw new Error(`${label} failed (${response.status}): ${JSON.stringify(response.body)}`);
};
