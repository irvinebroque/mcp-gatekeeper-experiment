# Canva Gatekeeper

A Cloudflare Workers Gatekeeper that uses [Canva's REST API](https://www.canva.dev/docs/apps/rest-apis/)
directly. It gives Cloudflare OS resource-scoped access to a Canva library, folder,
or design through Workers RPC. It does not connect to or wrap Canva's MCP server.
The caller-facing API is [src/types.d.ts](src/types.d.ts).

Reads require observation authorization. Writes enter an approval queue and run
only when the host applies the action. Folder and design capabilities enforce
resource boundaries, including after cached reads and when objects move. An
uncertain write outcome is recorded and never automatically replayed.

## Structure

Two Workers separate resource policy from credentials:

| Location                            | Responsibility                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                      | Vendor, connected user, and per-resource Gatekeeper entrypoints                             |
| `src/sessions/`                     | Small RPC capabilities for libraries, designs, folders, assets, comments, cursors, and jobs |
| `src/engine/`                       | Approval journal, dependencies, scope checks, local previews, caching, and REST job polling |
| `src/canva/`                        | Fixed-origin REST transport and reviewed operation validation                               |
| `src/resources.ts`, `src/decode.ts` | Resource locators and conversion to the public API's data shapes                            |
| `auth/account.ts`                   | Per-account flow state, Access ownership, credential storage, refresh, and revocation       |
| `auth/oauth.ts`                     | Canva REST OAuth protocol and scope selection                                               |
| `schemas/canva-rest.json`           | Reviewed endpoints and their transitive schemas from Canva's OpenAPI description            |
| `src/host/gatekeeper.ts`            | Unmodified, pinned Cloudflare OS host contract                                              |

The `canva-gatekeeper` Worker calls `canva-credentials` through a private service
binding. Sessions receive neither tokens nor raw request capabilities. Their
internal context stays outside the RPC surface.

Cloudflare Access protects public HTTP routes. Native Workers Access context
binds the connection and callback to the same user. Access managed OAuth can
provide client authentication to these Workers; Canva's delegated REST consent
still needs its own app and tokens. The resource API is Workers RPC; public HTTP
routes serve connection callbacks and health checks.

## REST coverage and behavior

The reviewed registry contains 35 operations, including job status endpoints.
It covers design search and metadata, pages, export formats and datasets; folders;
assets; comment threads and replies; brand templates; copying, imports, exports,
resizing, merging pages, design and image generation, and background removal.
Inputs and responses are validated against the pinned schemas. Unknown
operations are rejected, and requests go only to `https://api.canva.com/rest`.

The REST API is not identical to the MCP tool surface. This implementation omits
MCP editing transactions, arbitrary element editing, flattened text and speaker
notes, folder search, brand-kit listing, shortlink resolution, layer separation,
and template drafts because the reviewed REST spec has no equivalent endpoint.
Use full Canva design URLs or IDs. Imports return an array of designs, and page
changes return a job. Design generation accepts documents or presentations;
image generation accepts square, landscape, or portrait output.

Some of these endpoints are Canva previews and require particular plans, app
capabilities, or scopes. Preview flags are recorded in the registry. Canva
[does not recommend preview APIs for production](https://www.canva.dev/docs/apps/rest-apis/#preview-apis).
Supporting a method does not establish that a particular account can use it.

Pending folder creation, comments, and replies have local previews. Page changes
and moves block affected listings until their outcome is known. Asynchronous
REST writes remain `running` in the journal until a status read confirms success;
dependent writes cannot run earlier. Jobs never retry a mutation. Collaborator
observers are refused because equivalent access cannot be verified for all
returned content.

Existing MCP credentials cannot be reused: reconnect with a Canva REST app.
Old action journals are refused; create fresh resource connections rather than
replaying them against different endpoints.

## Development

Use Node.js 22.18 or newer and install both locked packages:

```sh
npm ci
npm ci --prefix auth
npm test
npm run typecheck
npm run build
npm run format:check
```

These commands generate schema validators, the browser resource selector, and
Workers types automatically. Generated files are ignored by Git. Tests require
no account: they use OpenAPI-validated synthetic REST responses and workerd to
check all reviewed operations, RPC boundaries, approvals, job dependencies, and
the two-Worker Access and credential lifecycle.

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

1. Create or configure a Canva Developer Portal app with REST API capabilities.
   Register `<BASE_URL>/callback` and enable the scopes needed by the selected
   operations. See [Canva authentication](https://www.canva.dev/docs/apps/rest-apis/authentication/).
   The credential Worker uses authorization code with PKCE and client-secret
   authentication. Both `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` are required.
2. In [auth/cloudflare.config.ts](auth/cloudflare.config.ts), set `BASE_URL` to
   the credential Worker's public HTTPS origin. Configure Canva credentials only
   on `canva-credentials`. Local secrets belong in ignored `auth/.dev.vars`:

   ```dotenv
   CANVA_CLIENT_ID=your-client-id
   CANVA_CLIENT_SECRET=your-client-secret
   ```

3. Deploy credentials before the Gatekeeper. Configure a self-hosted Access
   application targeting both Workers by Worker ID, including previews.
   [infra/access-application.example.json](infra/access-application.example.json)
   supplies the application shape; replace placeholders and select the operator
   policy and allowed OAuth redirect URIs. The example does not provision Access.
   Discover commands with `cf cli search "create Access application"` and inspect
   `cf zero-trust access applications create --help`.
4. Set `accessAudience` in `auth/cloudflare.config.ts` to that application's
   audience tag, then rebuild and deploy both Workers. The placeholder fails
   closed until configured.
5. In the Cloudflare OS host, bind the deployed Gatekeeper's named entrypoint:

   ```ts
   GATEKEEPER_CANVA: bindings.worker({
     worker: "canva-gatekeeper",
     exportName: "GatekeeperVendor",
   });
   ```

The host completes the connection handoff, obtains the resource class through
`getGatekeeperClassFor()`, and creates a per-resource, per-Gadget Durable Object
facet. It supplies the canonical `ApprovalQueue` to `startSession()`. The browser
resource selector uses the host's MessagePort handshake.

Local builds and simulated checks do not establish live REST authorization,
deployed Access login, managed OAuth, or end-to-end Cloudflare OS integration.
Moving an installation's account Durable Objects between Workers also requires
fresh connections; matching object IDs do not transfer storage.

Licensed under Apache-2.0. See [NOTICE](NOTICE) and [licenses/](licenses/) for
third-party attribution.
