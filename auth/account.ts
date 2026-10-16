import { DurableObject } from "cloudflare:workers";
import type { GatekeeperConnectCallback, GatekeeperUser } from "../src/host/gatekeeper";
import { McpClient, boundedText, object, string, type Data } from "../src/protocol";
import { RESOURCES } from "../src/core";
import { patterns } from "../src/grants";
import { connectHandoffPageHtml, htmlResponse } from "../src/connect-pages";
import { samePrincipal, type AccessPrincipal } from "../src/access";
import type { CredentialEnv } from "./index";

export type Env = CredentialEnv;
export type Credentials = { access_token: string; refresh_token?: string; expires_at: number; scope: string };
type Flow = { nonce: string; expires: number; patterns: string[]; reconnect: boolean; state?: string; verifier?: string; principal?: AccessPrincipal };
const LIFETIME = 10 * 60_000;
const ISSUER = "https://mcp.canva.com";
const RESOURCE = ISSUER + "/mcp";
const SCOPES = ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "folder:read", "folder:write", "brandtemplate:content:read", "brandtemplate:meta:read", "brandtemplate:content:write", "comment:read", "comment:write", "asset:read", "asset:write", "brandkit:read"];
function scopesFor(allowed: string[]): string[] {
  if (allowed.includes(RESOURCES[0].urlPattern)) return SCOPES;
  if (!allowed.length) return ["profile:read"];
  const design = ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "comment:read", "comment:write"];
  return allowed.includes(RESOURCES[1].urlPattern) ? [...design, "folder:read", "folder:write", "asset:read"] : design;
}
export const nonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
export function same(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
export function baseUrl(env: Env) {
  const u = new URL(env.BASE_URL);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("BASE_URL must use HTTPS");
  if (u.search || u.hash || u.pathname !== "/" || u.username || u.password) throw new Error("BASE_URL must be an origin");
  return u.origin;
}
export function decodeCredentials(data: Data, previous?: Credentials): Credentials {
  const expires = Number(data.expires_in);
  if (!Number.isFinite(expires) || expires <= 0 || data.token_type?.toLowerCase() !== "bearer") throw new Error("Invalid Canva token response");
  return { access_token: string(data.access_token), refresh_token: data.refresh_token === undefined ? previous?.refresh_token : string(data.refresh_token),
    scope: string(data.scope ?? previous?.scope ?? ""), expires_at: Date.now() + expires * 1000 };
}

export class UserAccount extends DurableObject<Env> {
  #refresh?: Promise<string>;
  #client = new McpClient(() => this.getAccessToken());
  async start(callback: Fetcher<GatekeeperConnectCallback>, allowed: string[], user: Fetcher<GatekeeperUser>): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("callback")) throw new Error("Account already initialized");
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("user", user);
    return this.begin(allowed, false);
  }
  async begin(allowed: string[], reconnect = true): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    const value = nonce();
    const flow: Flow = { nonce: value, expires: Date.now() + LIFETIME, patterns: patterns(allowed), reconnect };
    this.ctx.storage.kv.put("flow", flow);
    await this.ctx.storage.setAlarm(flow.expires);
    return { url: `${baseUrl(this.env)}/connect/${this.ctx.id}/${value}` };
  }
  async authorize(value: string, principal: AccessPrincipal): Promise<Response> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (!flow || flow.expires <= Date.now() || !same(flow.nonce, value) || flow.state) throw new Error("Invalid or expired connection link");
    const owner = this.ctx.storage.kv.get<AccessPrincipal>("owner");
    if (owner && !samePrincipal(owner, principal)) throw new Error("Connection belongs to another Access user");
    if (!this.env.CANVA_CLIENT_ID) throw new Error("Configure a Canva OAuth client before connecting");
    const verifier = nonce(), state = nonce();
    this.ctx.storage.kv.put("flow", { ...flow, nonce: "", verifier, state, principal });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const url = new URL(ISSUER + "/authorize");
    url.search = new URLSearchParams({ client_id: this.env.CANVA_CLIENT_ID, redirect_uri: `${baseUrl(this.env)}/callback`, response_type: "code",
      scope: scopesFor(flow.patterns).join(" "), resource: RESOURCE,
      code_challenge: challenge, code_challenge_method: "S256", state: `${this.ctx.id}.${state}` }).toString();
    return new Response(null, { status: 302, headers: { Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  async #token(parameters: Record<string, string>, previous?: Credentials): Promise<Credentials> {
    const form = new URLSearchParams({ ...parameters, client_id: this.env.CANVA_CLIENT_ID, resource: RESOURCE });
    if (this.env.CANVA_CLIENT_SECRET) form.set("client_secret", this.env.CANVA_CLIENT_SECRET);
    const response = await fetch(ISSUER + "/token", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Canva authorization failed (${response.status})`); }
    return decodeCredentials(object(JSON.parse(await boundedText(response, 64 * 1024))), previous);
  }
  async finish(state: string, code: string, principal: AccessPrincipal): Promise<Response> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (!flow?.state || flow.expires <= Date.now() || !same(flow.state, state) || !flow.verifier || !code) throw new Error("Invalid or expired OAuth callback");
    if (!flow.principal || !samePrincipal(flow.principal, principal)) throw new Error("Access user changed during authorization");
    const revision = this.ctx.storage.kv.get<number>("revision") ?? 0;
    this.ctx.storage.kv.delete("flow"); // One use, including failed exchanges.
    const credentials = await this.#token({ grant_type: "authorization_code", code, code_verifier: flow.verifier, redirect_uri: `${baseUrl(this.env)}/callback` });
    if (this.ctx.storage.kv.get("revoked") || revision !== (this.ctx.storage.kv.get<number>("revision") ?? 0)) throw new Error("Connection changed during authentication");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Connection expired");
    if (flow.reconnect) {
      const stageId = nonce();
      this.ctx.storage.kv.put("stage", { stageId, credentials, patterns: flow.patterns, expires: Date.now() + LIFETIME });
      await this.ctx.storage.setAlarm(Date.now() + LIFETIME);
      return htmlResponse(connectHandoffPageHtml(await callback.reconnectComplete(stageId)));
    }
    this.ctx.storage.kv.put("credentials", credentials);
    this.ctx.storage.kv.put("patterns", flow.patterns);
    this.ctx.storage.kv.put("owner", principal);
    try {
      const user = this.ctx.storage.kv.get<Fetcher<GatekeeperUser>>("user");
      if (!user) throw new Error("Connection expired");
      return htmlResponse(connectHandoffPageHtml(await callback.complete(user)));
    } catch (error) { this.ctx.storage.kv.delete("credentials"); throw error; }
  }
  async commitReconnect(stageId: string): Promise<void> {
    const stage = this.ctx.storage.kv.get<{ stageId: string; credentials: Credentials; patterns: string[]; expires: number }>("stage");
    if (this.ctx.storage.kv.get("revoked") || !stage || stage.expires <= Date.now() || !same(stage.stageId, stageId)) throw new Error("Reconnect stage is invalid or expired");
    this.ctx.storage.kv.put("revision", (this.ctx.storage.kv.get<number>("revision") ?? 0) + 1);
    this.ctx.storage.kv.put("credentials", stage.credentials);
    this.ctx.storage.kv.put("patterns", stage.patterns);
    this.ctx.storage.kv.delete("stage");
    this.ctx.storage.kv.delete("expired");
    this.#client = new McpClient(() => this.getAccessToken());
  }
  async getPatterns(): Promise<string[]> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    return this.ctx.storage.kv.get<string[]>("patterns") ?? [];
  }
  async checkGrant(pattern: string): Promise<void> {
    if (!(await this.getPatterns()).includes(pattern) || !this.ctx.storage.kv.get("credentials")) throw new Error("Resource type has not been granted or the connection has expired");
  }
  async #expired() {
    if (this.ctx.storage.kv.get("expired")) return;
    this.ctx.storage.kv.put("expired", true);
    await this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback")?.credentialsExpired();
  }
  async getAccessToken(): Promise<string> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    const old = this.ctx.storage.kv.get<Credentials>("credentials");
    if (!old) throw new Error("Canva is not connected");
    if (old.expires_at > Date.now() + 60_000) return old.access_token;
    if (this.#refresh) return this.#refresh;
    const revision = this.ctx.storage.kv.get<number>("revision") ?? 0;
    this.#refresh = (async () => {
      try {
        if (!old.refresh_token) throw new Error("Reconnect Canva to continue");
        const updated = await this.#token({ grant_type: "refresh_token", refresh_token: old.refresh_token }, old);
        if (this.ctx.storage.kv.get("revoked") || revision !== (this.ctx.storage.kv.get<number>("revision") ?? 0)) throw new Error("Connection changed during refresh");
        this.ctx.storage.kv.put("credentials", updated);
        if (this.ctx.storage.kv.get("expired")) {
          this.ctx.storage.kv.delete("expired");
          await this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback")?.credentialsRestored();
        }
        return updated.access_token;
      } catch (e) { await this.#expired(); throw e; }
      finally { this.#refresh = undefined; }
    })();
    return this.#refresh;
  }
  async call(tool: string, argsJson: string, pattern: string): Promise<string> {
    await this.checkGrant(pattern);
    if (typeof argsJson !== "string" || argsJson.length > 200_000) throw new Error("Invalid tool arguments");
    const args = object(JSON.parse(argsJson));
    try { return JSON.stringify(await this.#client.call(tool, args)); }
    catch (e) { if (e instanceof Error && e.message.includes("HTTP 401")) await this.#expired(); throw e; }
  }
  async revoke(): Promise<void> {
    const credentials = this.ctx.storage.kv.get<Credentials>("credentials");
    // Cut off all local capabilities before contacting the provider.
    this.ctx.storage.kv.put("revoked", true);
    this.ctx.storage.kv.put("revision", (this.ctx.storage.kv.get<number>("revision") ?? 0) + 1);
    for (const [key] of this.ctx.storage.kv.list()) {
      if (key !== "revoked" && key !== "revision") this.ctx.storage.kv.delete(key);
    }
    await this.ctx.storage.deleteAlarm();
    if (credentials) {
      const form = new URLSearchParams({ token: credentials.refresh_token ?? credentials.access_token, token_type_hint: credentials.refresh_token ? "refresh_token" : "access_token", client_id: this.env.CANVA_CLIENT_ID });
      if (this.env.CANVA_CLIENT_SECRET) form.set("client_secret", this.env.CANVA_CLIENT_SECRET);
      const response = await fetch(ISSUER + "/token", { method: "POST", redirect: "manual", body: form, signal: AbortSignal.timeout(30_000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Local access revoked; Canva token revocation failed. Remove the integration in Canva.");
    }
  }
  async alarm(): Promise<void> {
    // Keep the revocation tombstone even if an already-dispatched alarm arrives.
    if (this.ctx.storage.kv.get("revoked")) { await this.ctx.storage.deleteAlarm(); return; }
    for (const key of ["flow", "stage"]) {
      const value = this.ctx.storage.kv.get<{ expires: number }>(key);
      if (value && value.expires <= Date.now()) this.ctx.storage.kv.delete(key);
    }
    if (!this.ctx.storage.kv.get("credentials") && !this.ctx.storage.kv.get("flow") && !this.ctx.storage.kv.get("stage")) await this.ctx.storage.deleteAll();
    else {
      const deadlines = ["flow", "stage"].map(k => this.ctx.storage.kv.get<{ expires: number }>(k)?.expires).filter((x): x is number => x !== undefined);
      if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    }
  }
}
