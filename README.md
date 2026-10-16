# Canva Gatekeeper

A Cloudflare Workers adapter for Canva's MCP server. It gives Cloudflare OS
resource-scoped access to a Canva library, folder, or design through Workers RPC.
The public API is in [src/types.d.ts](src/types.d.ts).

Reads require observation authorization. Writes enter an approval queue before
execution. Folder and design capabilities enforce their resource boundaries, and
ambiguous write outcomes are never automatically replayed. The supported tool
schemas and action/observation classifications live in [schemas/canva.json](schemas/canva.json).
Unknown tools are rejected.

Two Workers make up the server:

- `canva-gatekeeper` implements the resource API, approvals, and action journal.
- `canva-credentials` owns Canva consent, tokens, refresh, and revocation in
  per-account Durable Objects. The Gatekeeper calls it through a private service
  binding; resource sessions never receive tokens.

Cloudflare Access protects public HTTP routes. The native Workers Access context
binds connection and callback requests to the same user. Access managed OAuth
can authenticate clients to these Workers; Canva authorization still requires a
separate delegated grant. The resource API is Workers RPC, with HTTP routes for
connection callbacks and health checks.

## Development

Use Node.js 22.18 or newer and install both locked packages:

```sh
npm ci
npm ci --prefix auth
npm test
npm run typecheck
npm run build
```

Build, test, typecheck, and dev commands generate schema validators,
the browser resource selector, and Workers types automatically. Generated files
are ignored by Git. Tests use synthetic Canva responses and need no account or
credentials. `npm test` includes unit tests and workerd integration checks for
capability boundaries, approvals, account lifecycle, and the two Workers.

Run these in separate terminals:

```sh
npm run dev:auth -- --mode access-dev
npm run dev -- --mode access-dev
```

The explicit `access-dev` mode supplies a fictional local identity. Health routes
are `http://localhost:8788/health` for credentials and
`http://localhost:8787/health` for the Gatekeeper. Without Access context, HTTP
requests return 403.

## Configuration and deployment

Use the [Cloudflare CLI](https://developers.cloudflare.com/cf/get-started/) (`cf`)
for builds, deployment, secrets, and Access resource management. Discover current
commands with `cf cli search` and command help.

1. In [auth/cloudflare.config.ts](auth/cloudflare.config.ts), set `BASE_URL` to the
   credential Worker's public HTTPS origin. Register `<BASE_URL>/callback` with
   Canva and configure `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` only on
   `canva-credentials`. A public PKCE client uses an empty client secret. Local
   secrets belong in ignored `auth/.dev.vars`:

   ```dotenv
   CANVA_CLIENT_ID=your-client-id
   CANVA_CLIENT_SECRET=your-client-secret
   ```

2. Deploy the credential Worker before the Gatekeeper. Configure one self-hosted
   Access application targeting both Workers by Worker ID, including previews.
   [infra/access-application.example.json](infra/access-application.example.json)
   supplies the application shape; replace its placeholders and select the
   operator policy and allowed OAuth redirect URIs. The example does not provision
   Access. Discover the command with `cf cli search "create Access application"`
   and inspect `cf zero-trust access applications create --help`.
3. Set `accessAudience` in `auth/cloudflare.config.ts` to that application's
   audience tag, then rebuild and redeploy both Workers. The placeholder audience
   fails closed until configured.
4. In the Cloudflare OS host, bind the deployed Gatekeeper's named entrypoint:

   ```ts
   GATEKEEPER_CANVA: bindings.worker({
     worker: "canva-gatekeeper",
     exportName: "GatekeeperVendor",
   })
   ```

The host completes the connection handoff, obtains the resource class through
`getGatekeeperClassFor()`, and creates a per-resource, per-Gadget Durable Object
facet. It supplies the canonical `ApprovalQueue` to `startSession()`. The browser
resource selector uses the host's MessagePort handshake. The pinned host contract
is [src/host/gatekeeper.ts](src/host/gatekeeper.ts).

This implementation targets `https://mcp.canva.com/mcp` and its authorization
server. It requires a client approved for that endpoint. Canva's newer
`https://api.canva.com/connect/v1/mcp` endpoint is not implemented or verified here.

Local builds and simulated runtime checks do not establish deployed Access login,
managed OAuth, or end-to-end Cloudflare OS integration. Moving an existing
installation's account Durable Objects between Workers also requires a credential
migration or fresh connections; matching object IDs do not transfer storage.

Licensed under Apache-2.0. See [NOTICE](NOTICE) and [licenses/](licenses/) for
third-party attribution.
