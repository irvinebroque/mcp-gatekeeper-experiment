import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import type { GatekeeperVendor as Vendor, GatekeeperUser, GatekeeperUserVerifier, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, ApprovalQueue, ResourceConfiguratorFrame, AccountDescription } from "./host/gatekeeper";
import { Engine, RESOURCES, parseResource, resourceFor, scopeUrl, type Scope } from "./core";
import { createSession } from "./sessions";
import { JsonStore } from "./storage";
import { object } from "./protocol";
import { patterns } from "./grants";
import { accessPrincipal, accessDenied } from "./access";
import TYPES from "./types.txt?raw";
import CONFIGURATOR from "./generated/configurator.txt?raw";
type Env = Cloudflare.Env;

type UserProps = { userObjectId: string };
type GatekeeperProps = UserProps & { scope: Scope };
const supported = RESOURCES.map(r => ({ ...r, grantable: true }));
const avatar = { url: "https://www.canva.com/favicon.ico" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try { await accessPrincipal(ctx, env.ACCESS_AUDIENCE); }
    catch { return accessDenied(); }
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return Response.json({ service: "canva-gatekeeper", status: "ok" });
    return new Response("Not found", { status: 404 });
  },
};

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe() { return { displayName: "Canva", url: "https://www.canva.com/", logo: avatar, color: "#7d2ae8", tagline: "Read, create, and edit Canva designs", description: "Connect a design, folder, or your Canva library. Work through resource-scoped capabilities with reviewable actions." }; }
  async getSupportedResources() { return supported; }
  async getTypeScriptTypes() { return TYPES; }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions) {
    const userObjectId = await this.env.CREDENTIALS.allocateAccount();
    const account = await this.env.CREDENTIALS.getAccount(userObjectId);
    return account.start(callback, patterns(options?.resourceUrlPatterns), this.ctx.exports.CanvaUser({ props: { userObjectId } }));
  }
}

export class CanvaUser extends WorkerEntrypoint<Env, UserProps> implements GatekeeperUser {
  #account() { return this.env.CREDENTIALS.getAccount(this.ctx.props.userObjectId); }
  async describe(): Promise<AccountDescription> { return { displayName: "Canva account", avatar, grantedResourceUrlPatterns: await (await this.#account()).getPatterns() }; }
  async getSupportedResources() { return supported; }
  async getGatekeeperClassFor(url: string): ReturnType<GatekeeperUser["getGatekeeperClassFor"]> {
    const scope = parseResource(url), resource = resourceFor(scope);
    if (!(await (await this.#account()).getPatterns()).includes(resource.urlPattern)) throw new Error("This resource type needs an account grant");
    return { class: this.ctx.exports.CanvaGatekeeper({ props: { ...this.ctx.props, scope } }), resource };
  }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    patterns([pattern]);
    return { iframeHtml: CONFIGURATOR, ui: new RpcStub(new Configurator(pattern)) };
  }
  async revoke() { await (await this.#account()).revoke(); }
  async reconnect() { const account = await this.#account(); return account.begin(await account.getPatterns()); }
  async commitReconnect(stageId: string) { await (await this.#account()).commitReconnect(stageId); }
  async getAuthenticatedEmail() { return null; }
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.CanvaVerifier({ props: this.ctx.props }); }
  async ensureResources(requested: string[]) {
    const account = await this.#account();
    const existing = await account.getPatterns(), wanted = patterns(requested);
    if (wanted.every(p => existing.includes(p))) return {};
    return account.begin([...new Set([...existing, ...wanted])]);
  }
}
class Configurator extends RpcTarget {
  #pattern: string;
  constructor(pattern: string) { super(); this.#pattern = pattern; }
  async pattern() { return this.#pattern; }
  async validate(url: string) {
    const scope = parseResource(url.trim());
    if (resourceFor(scope).urlPattern !== this.#pattern) throw new Error("Choose a URL of the selected resource type");
    // Preserve collaboration tokens only inside the host's private resource locator.
    return scope.kind === "design" ? scope.locator : scopeUrl(scope);
  }
}
export class CanvaVerifier extends WorkerEntrypoint<Env, UserProps> implements GatekeeperUserVerifier {}

export class CanvaGatekeeper extends DurableObject<Env, GatekeeperProps> implements Gatekeeper<ReturnType<typeof createSession>> {
  #engine?: Engine;
  #getEngine() {
    if (!this.#engine) {
      const account = () => this.env.CREDENTIALS.getAccount(this.ctx.props.userObjectId);
      const pattern = resourceFor(this.ctx.props.scope).urlPattern;
      this.#engine = new Engine(new JsonStore(this.ctx.storage.kv), { call: async (name, args) => object(JSON.parse(await (await account()).call(name, JSON.stringify(args), pattern))), ensureActive: async () => (await account()).checkGrant(pattern) }, this.ctx.props.scope);
    }
    return this.#engine;
  }
  async describe() {
    const scope = this.ctx.props.scope, resource = resourceFor(scope);
    return { url: scopeUrl(scope), title: resource.title, snippet: resource.description,
      suggestedBindingName: `CANVA_${scope.kind.toUpperCase()}`,
      tsType: scope.kind === "library" ? "CanvaLibrarySession" : scope.kind === "folder" ? "CanvaFolderSession" : "CanvaDesignEditor" };
  }
  async getTypeScriptTypes() { return TYPES; }
  async getAutoApprovableActions() { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>) { return createSession({ engine: this.#getEngine(), queue }); }
  async applyAction(action: number) { await this.#getEngine().apply(action); }
  async rejectAction(action: number) { return this.#getEngine().reject(action); }
  async revertAction(_action: number) { return { message: "Canva does not provide a reliable undo for these operations. Review the design in Canva.", canRetry: false }; }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error("Canva grants are private-only: equivalent collaborator access cannot be verified for all returned content."); }
  async removeObserver(_id: string): Promise<void> {}
}
