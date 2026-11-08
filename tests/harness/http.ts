export type ApiOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export type ApiResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

export async function api(
  baseUrl: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.body === undefined ? {} : {
      body: typeof options.body === "string" ? options.body : JSON.stringify(options.body),
    }),
  });

  const text = await response.text();
  let body: unknown = text;
  if (text === "") body = null;
  else {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, headers: response.headers, body };
}
