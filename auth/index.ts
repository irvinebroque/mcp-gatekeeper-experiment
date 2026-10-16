import { WorkerEntrypoint } from "cloudflare:workers";
import type { InferEnv, UnwrapConfig } from "cf/config";
import type { credentialWorker } from "./cloudflare.config";
import { UserAccount } from "./account";
import { accessPrincipal, accessDenied } from "../src/access";
import { htmlResponse, errorPageHtml } from "../src/connect-pages";
export { UserAccount };

export type CredentialEnv = InferEnv<UnwrapConfig<typeof credentialWorker>>;

function accounts(env: CredentialEnv): DurableObjectNamespace<UserAccount> {
  // The configuration binds this namespace to this Worker's UserAccount export.
  return env.ACCOUNTS as DurableObjectNamespace<UserAccount>;
}

export default {
  async fetch(request: Request, env: CredentialEnv, ctx: ExecutionContext): Promise<Response> {
    let principal;
    try {
      principal = await accessPrincipal(ctx, env.ACCESS_AUDIENCE);
    } catch {
      return accessDenied();
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({ service: "canva-credentials", status: "ok" });
    try {
      const namespace = accounts(env);
      const match = /^\/connect\/([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(url.pathname);
      if (match)
        return await namespace.get(namespace.idFromString(match[1])).authorize(match[2], principal);
      if (url.pathname === "/callback") {
        const state = /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(url.searchParams.get("state") ?? "");
        if (!state || url.searchParams.has("error"))
          throw new Error("Authorization cancelled or invalid");
        return await namespace
          .get(namespace.idFromString(state[1]))
          .finish(state[2], url.searchParams.get("code") ?? "", principal);
      }
    } catch {
      return htmlResponse(
        errorPageHtml(
          "Connection failed",
          "This connection link has expired, the Access user changed, or Canva authorization could not finish. Start the connection again.",
        ),
        400,
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

/** Private service binding only. Access context is not propagated over RPC. */
export class CredentialBroker extends WorkerEntrypoint<CredentialEnv> {
  async allocateAccount(): Promise<string> {
    return accounts(this.env).newUniqueId().toString();
  }
  async getAccount(id: string): Promise<DurableObjectStub<UserAccount>> {
    const namespace = accounts(this.env);
    return namespace.get(namespace.idFromString(id));
  }
}
