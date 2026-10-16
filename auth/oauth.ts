import { boundedText, object, string, type Data } from "../src/json";
import { RESOURCES } from "../src/resources";
import routes from "../src/generated/operations.json";
import type { CredentialEnv } from "./index";

const AUTHORIZATION_URL = "https://www.canva.com/api/oauth/authorize";
const TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const REVOCATION_URL = "https://api.canva.com/rest/v1/oauth/revoke";

export type Credentials = {
  provider: "canva-rest";
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
};

export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function sameSecret(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return (
    a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b))
  );
}
export function baseUrl(env: Pick<CredentialEnv, "BASE_URL">): string {
  const url = new URL(env.BASE_URL);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error("BASE_URL must use HTTPS");
  if (url.search || url.hash || url.pathname !== "/" || url.username || url.password)
    throw new Error("BASE_URL must be an origin");
  return url.origin;
}

export function scopesFor(allowed: string[]): string[] {
  if (allowed.includes(RESOURCES[0].urlPattern))
    return [
      ...new Set(["profile:read", ...Object.values(routes).flatMap((route) => route.scopes)]),
    ];
  if (!allowed.length) return ["profile:read"];
  const design = [
    "profile:read",
    "design:meta:read",
    "design:content:read",
    "design:content:write",
    "comment:read",
    "comment:write",
  ];
  return allowed.includes(RESOURCES[1].urlPattern)
    ? [...design, "folder:read", "folder:write", "asset:read"]
    : design;
}

function decodeCredentials(data: Data, previous?: Credentials): Credentials {
  const expires = Number(data.expires_in);
  if (!Number.isFinite(expires) || expires <= 0 || data.token_type?.toLowerCase() !== "bearer")
    throw new Error("Invalid Canva token response");
  return {
    provider: "canva-rest",
    access_token: string(data.access_token),
    refresh_token:
      data.refresh_token === undefined ? previous?.refresh_token : string(data.refresh_token),
    scope: string(data.scope ?? previous?.scope ?? ""),
    expires_at: Date.now() + expires * 1000,
  };
}

/** Provider protocol only. UserAccount owns flow state, concurrency, and stored credentials. */
export class CanvaOAuth {
  constructor(private readonly env: CredentialEnv) {}

  async authorizationUrl(state: string, verifier: string, allowed: string[]): Promise<string> {
    this.#authorization();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: this.env.CANVA_CLIENT_ID,
      redirect_uri: `${baseUrl(this.env)}/callback`,
      response_type: "code",
      scope: scopesFor(allowed).join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    return url.href;
  }

  #authorization(): string {
    if (!this.env.CANVA_CLIENT_ID || !this.env.CANVA_CLIENT_SECRET)
      throw new Error("Configure a Canva REST OAuth client ID and secret before connecting");
    return `Basic ${btoa(`${this.env.CANVA_CLIENT_ID}:${this.env.CANVA_CLIENT_SECRET}`)}`;
  }

  async #post(url: string, parameters: Record<string, string>): Promise<Response> {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: this.#authorization(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Canva authorization failed (${response.status})`);
    }
    return response;
  }

  async exchange(parameters: Record<string, string>, previous?: Credentials): Promise<Credentials> {
    const response = await this.#post(TOKEN_URL, parameters);
    return decodeCredentials(object(JSON.parse(await boundedText(response, 64 * 1024))), previous);
  }

  async revoke(credentials: Credentials): Promise<void> {
    const response = await this.#post(REVOCATION_URL, {
      token: credentials.refresh_token ?? credentials.access_token,
    });
    await response.body?.cancel();
  }
}
