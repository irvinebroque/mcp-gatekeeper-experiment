import { boundedText, clean, object, parseJson, string, type Data } from "../json";
import { operationFor, validateOperation } from "./operations";

const API_ORIGIN = "https://api.canva.com";
const API_PREFIX = "/rest";

export interface ApiClient {
  call(operation: string, input: Data): Promise<Data>;
  ensureActive?(): Promise<void>;
}

export class CanvaApiError extends Error {
  constructor(readonly status: number) {
    super(`Canva REST HTTP ${status}`);
  }
}

/** Fixed-origin REST transport. It never follows redirects or retries writes. */
export class CanvaRestClient implements ApiClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async call(name: string, input: Data): Promise<Data> {
    const args = clean(input);
    validateOperation(name, args);
    const operation = operationFor(name);
    const path = operation.path.replace(/\{(\w+)\}/g, (_, key) =>
      encodeURIComponent(string(args.path[key])),
    );
    const url = new URL(API_PREFIX + path, API_ORIGIN);

    for (const parameter of operation.queryParameters) {
      const value = args.query?.[parameter.name];
      if (value === undefined) continue;
      if (Array.isArray(value) && parameter.explode) {
        for (const item of value) url.searchParams.append(parameter.name, String(item));
      } else {
        url.searchParams.set(
          parameter.name,
          Array.isArray(value) ? value.join(",") : String(value),
        );
      }
    }

    const response = await this.request(url, {
      method: operation.method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        ...(args.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CanvaApiError(response.status);
    }
    const data = response.status === 204 ? {} : object(parseJson(await boundedText(response)));
    validateOperation(name, data, true);
    return data;
  }
}
