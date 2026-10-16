import { DurableObject } from "cloudflare:workers";
import type { GatekeeperConnectCallback, GatekeeperUser } from "../src/host/gatekeeper";
import { CanvaRestClient, CanvaApiError } from "../src/canva/client";
import { object } from "../src/json";
import { patterns } from "../src/grants";
import { connectHandoffPageHtml, htmlResponse } from "../src/connect-pages";
import { samePrincipal, type AccessPrincipal } from "../src/access";
import { CanvaOAuth, baseUrl, nonce, sameSecret, type Credentials } from "./oauth";
import type { CredentialEnv } from "./index";

type Flow = {
  nonce: string;
  expires: number;
  patterns: string[];
  reconnect: boolean;
  state?: string;
  verifier?: string;
  principal?: AccessPrincipal;
};
const FLOW_LIFETIME_MS = 10 * 60_000;

export class UserAccount extends DurableObject<CredentialEnv> {
  #refresh?: Promise<string>;
  #oauth = new CanvaOAuth(this.env);
  #client = new CanvaRestClient(() => this.getAccessToken());
  async start(
    callback: Fetcher<GatekeeperConnectCallback>,
    allowed: string[],
    user: Fetcher<GatekeeperUser>,
  ): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("callback")) throw new Error("Account already initialized");
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("user", user);
    return this.begin(allowed, false);
  }
  async begin(allowed: string[], reconnect = true): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    const value = nonce();
    const flow: Flow = {
      nonce: value,
      expires: Date.now() + FLOW_LIFETIME_MS,
      patterns: patterns(allowed),
      reconnect,
    };
    this.ctx.storage.kv.put("flow", flow);
    await this.ctx.storage.setAlarm(flow.expires);
    return { url: `${baseUrl(this.env)}/connect/${this.ctx.id}/${value}` };
  }
  async authorize(value: string, principal: AccessPrincipal): Promise<Response> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (!flow || flow.expires <= Date.now() || !sameSecret(flow.nonce, value) || flow.state)
      throw new Error("Invalid or expired connection link");
    const owner = this.ctx.storage.kv.get<AccessPrincipal>("owner");
    if (owner && !samePrincipal(owner, principal))
      throw new Error("Connection belongs to another Access user");
    const verifier = nonce(),
      state = nonce();
    this.ctx.storage.kv.put("flow", { ...flow, nonce: "", verifier, state, principal });
    const url = await this.#oauth.authorizationUrl(
      `${this.ctx.id}.${state}`,
      verifier,
      flow.patterns,
    );
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  async finish(state: string, code: string, principal: AccessPrincipal): Promise<Response> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (
      !flow?.state ||
      flow.expires <= Date.now() ||
      !sameSecret(flow.state, state) ||
      !flow.verifier ||
      !code
    )
      throw new Error("Invalid or expired OAuth callback");
    if (!flow.principal || !samePrincipal(flow.principal, principal))
      throw new Error("Access user changed during authorization");
    const revision = this.ctx.storage.kv.get<number>("revision") ?? 0;
    this.ctx.storage.kv.delete("flow"); // One use, including failed exchanges.
    const credentials = await this.#oauth.exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: flow.verifier,
      redirect_uri: `${baseUrl(this.env)}/callback`,
    });
    if (
      this.ctx.storage.kv.get("revoked") ||
      revision !== (this.ctx.storage.kv.get<number>("revision") ?? 0)
    )
      throw new Error("Connection changed during authentication");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Connection expired");
    if (flow.reconnect) {
      const stageId = nonce();
      this.ctx.storage.kv.put("stage", {
        stageId,
        credentials,
        patterns: flow.patterns,
        expires: Date.now() + FLOW_LIFETIME_MS,
      });
      await this.ctx.storage.setAlarm(Date.now() + FLOW_LIFETIME_MS);
      return htmlResponse(connectHandoffPageHtml(await callback.reconnectComplete(stageId)));
    }
    this.ctx.storage.kv.put("credentials", credentials);
    this.ctx.storage.kv.put("patterns", flow.patterns);
    this.ctx.storage.kv.put("owner", principal);
    try {
      const user = this.ctx.storage.kv.get<Fetcher<GatekeeperUser>>("user");
      if (!user) throw new Error("Connection expired");
      return htmlResponse(connectHandoffPageHtml(await callback.complete(user)));
    } catch (error) {
      this.ctx.storage.kv.delete("credentials");
      throw error;
    }
  }
  async commitReconnect(stageId: string): Promise<void> {
    const stage = this.ctx.storage.kv.get<{
      stageId: string;
      credentials: Credentials;
      patterns: string[];
      expires: number;
    }>("stage");
    if (
      this.ctx.storage.kv.get("revoked") ||
      !stage ||
      stage.expires <= Date.now() ||
      !sameSecret(stage.stageId, stageId)
    )
      throw new Error("Reconnect stage is invalid or expired");
    this.ctx.storage.kv.put("revision", (this.ctx.storage.kv.get<number>("revision") ?? 0) + 1);
    this.ctx.storage.kv.put("credentials", stage.credentials);
    this.ctx.storage.kv.put("patterns", stage.patterns);
    this.ctx.storage.kv.delete("stage");
    this.ctx.storage.kv.delete("expired");
  }
  async getPatterns(): Promise<string[]> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    return this.ctx.storage.kv.get<string[]>("patterns") ?? [];
  }
  async checkGrant(pattern: string): Promise<void> {
    if (
      !(await this.getPatterns()).includes(pattern) ||
      this.ctx.storage.kv.get<Credentials>("credentials")?.provider !== "canva-rest"
    )
      throw new Error(
        "Resource type has not been granted or the connection needs REST authorization",
      );
  }
  async #expired() {
    if (this.ctx.storage.kv.get("expired")) return;
    this.ctx.storage.kv.put("expired", true);
    await this.ctx.storage.kv
      .get<Fetcher<GatekeeperConnectCallback>>("callback")
      ?.credentialsExpired();
  }
  async getAccessToken(): Promise<string> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Connection revoked");
    const old = this.ctx.storage.kv.get<Credentials>("credentials");
    if (!old) throw new Error("Canva is not connected");
    if (old.provider !== "canva-rest")
      throw new Error("Reconnect Canva using the REST API application");
    if (old.expires_at > Date.now() + 60_000) return old.access_token;
    if (this.#refresh) return this.#refresh;
    const revision = this.ctx.storage.kv.get<number>("revision") ?? 0;
    this.#refresh = (async () => {
      try {
        if (!old.refresh_token) throw new Error("Reconnect Canva to continue");
        const updated = await this.#oauth.exchange(
          { grant_type: "refresh_token", refresh_token: old.refresh_token },
          old,
        );
        if (
          this.ctx.storage.kv.get("revoked") ||
          revision !== (this.ctx.storage.kv.get<number>("revision") ?? 0)
        )
          throw new Error("Connection changed during refresh");
        this.ctx.storage.kv.put("credentials", updated);
        if (this.ctx.storage.kv.get("expired")) {
          this.ctx.storage.kv.delete("expired");
          await this.ctx.storage.kv
            .get<Fetcher<GatekeeperConnectCallback>>("callback")
            ?.credentialsRestored();
        }
        return updated.access_token;
      } catch (e) {
        await this.#expired();
        throw e;
      } finally {
        this.#refresh = undefined;
      }
    })();
    return this.#refresh;
  }
  async call(operation: string, argsJson: string, pattern: string): Promise<string> {
    await this.checkGrant(pattern);
    if (typeof argsJson !== "string" || argsJson.length > 200_000)
      throw new Error("Invalid API arguments");
    const args = object(JSON.parse(argsJson));
    try {
      return JSON.stringify(await this.#client.call(operation, args));
    } catch (e) {
      if (e instanceof CanvaApiError && e.status === 401) await this.#expired();
      throw e;
    }
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
      try {
        await this.#oauth.revoke(credentials);
      } catch {
        throw new Error(
          "Local access revoked; Canva token revocation failed. Remove the integration in Canva.",
        );
      }
    }
  }
  async alarm(): Promise<void> {
    // Keep the revocation tombstone even if an already-dispatched alarm arrives.
    if (this.ctx.storage.kv.get("revoked")) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    for (const key of ["flow", "stage"]) {
      const value = this.ctx.storage.kv.get<{ expires: number }>(key);
      if (value && value.expires <= Date.now()) this.ctx.storage.kv.delete(key);
    }
    if (
      !this.ctx.storage.kv.get("credentials") &&
      !this.ctx.storage.kv.get("flow") &&
      !this.ctx.storage.kv.get("stage")
    )
      await this.ctx.storage.deleteAll();
    else {
      const deadlines = ["flow", "stage"]
        .map((k) => this.ctx.storage.kv.get<{ expires: number }>(k)?.expires)
        .filter((x): x is number => x !== undefined);
      if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    }
  }
}
