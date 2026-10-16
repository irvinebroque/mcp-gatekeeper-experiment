# Canva Gatekeeper research and design constraints

Status: authenticated discovery complete; API explicitly approved and Gatekeeper
implemented. Unit tests, workerd scenarios, and nine live read calls passed. No
deployment or end-to-end host run has been performed. The original research
constraints below are retained; README records final behavior and limits.

## Sources and reproducibility

- Required workflow: https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md
- Canonical host contract: https://github.com/cloudflare/cloudflare-os/blob/main/packages/workshop-shared/src/gatekeeper.ts
- RPC model: https://github.com/cloudflare/capnweb/blob/main/README.md and its linked value/RpcTarget guides.
- Canva overview: https://www.canva.dev/docs/apps/mcp/
- OAuth/access: https://www.canva.dev/docs/apps/mcp/access-and-permissions/
- Quickstart: https://www.canva.dev/docs/apps/quickstart/
- Tool reference: https://www.canva.dev/docs/apps/mcp/tools/
- Cloudflare CLI: https://developers.cloudflare.com/cf/get-started/

The workspace began empty. Source references are snapshots in `upstream/`, retrieved
2026-10-16, not a local checkout of Cloudflare OS. The proposal must target the
actual OS contracts, not replace the approval queue with an invented stand-in.

## Direct observations so far

1. `https://mcp.canva.com/mcp` rejects unauthenticated requests with HTTP 401 and
   advertises OAuth protected-resource metadata in `WWW-Authenticate`.
2. The metadata advertises per-user OAuth, PKCE S256, refresh tokens, dynamic client
   registration, and client metadata documents. JSON snapshots are alongside this file.
3. Dynamic registration accepted this research client's own name and loopback
   callback (`http://127.0.0.1:8976/callback`) with HTTP 201. No other application's
   identity or redirect was reused. Registration success alone does not prove token
   issuance or MCP access.
4. A read-scope request redirected to Canva's own upstream consent flow requesting
   read AND write scopes. Requested, consented, and token-granted permissions must
   be tracked separately; never assume the requested list is the enforced list.
5. Local research uses PKCE, constant-time state validation, a loopback callback,
   and ignored files with mode 0600 for credentials. Sign-in and code exchange
   completed successfully. The resulting token reports exactly the ten requested
   read scopes, despite the broader upstream login/consent URL.
6. `cf` is installed (1.0.0-beta.17). It will be used for supported Cloudflare build,
   development, and deployment operations after the API review.
7. Authenticated initialization and catalog discovery succeeded: 48 tools, of which
   eight advertise output schemas. Nine read-only probes succeeded. See
   `api-proposal.md`, `tools.json`, and `probe-shapes.json` for results and limits.

## Capability boundaries to preserve

- A design object captures one design; its methods do not accept another design ID.
- A folder object may derive capabilities only from verified children. Receiving an
  arbitrary ID is not proof it belongs to the granted subtree. Revalidate membership
  before data disclosure and application of a queued mutation.
- Account-wide search belongs on an explicit library capability, never a design or
  folder capability. A shortlink resolver must canonicalize into the same boundary.
- Brand template and asset capabilities must not imply access to unrelated templates
  or assets. IDs mentioned in content do not independently grant general asset access.
- Cross-resource operations (move, merge, image replacement, autofill) require
  explicit source and destination capabilities, checked server-side for provenance,
  account compatibility, and allowed operations. TypeScript branding is insufficient.
- Pagination belongs to server-side cursors bound to the original query and scope;
  accepting arbitrary upstream cursors would weaken the resource boundary.
- Job, generation candidate, comment, and editing transaction handles retain the
  originating resource/account authority. No raw `callTool(name, arguments)` method.
- Unknown tools and newly introduced schema variants fail closed until reviewed.

## Actions, observation, and simulation

The skill requires every externally visible mutation to be queued and executed only
by `applyAction()`. Reads require `authorizeObservation()` before disclosure. Tool
annotations are hints; classification must follow actual behavior.

- Generating content, creating uploads, exporting designs, and starting editing
  transactions may consume quota or create server-side state. Treat these
  conservatively as actions until verified; never classify them by their names alone.
- Canva documentation says opening an editing transaction supplies editable element
  IDs. `get-design-content` supplies flattened text, not the element addresses needed
  for editing. This is a real obstacle to fully local editing simulation.
- An upstream uncommitted transaction is not automatically an acceptable local
  simulation: opening/applying drafts already contacts Canva and may create effects.
- Async handles can represent work whose result does not exist yet. They should
  report a normal processing state without fabricating generated content, exports,
  previews, or successful writes.
- Do not blindly retry non-idempotent tool calls after an ambiguous network failure.
  Persist the attempt and reconcile using an upstream job/resource ID where possible.
- Rejected provisional objects invalidate dependent work. Export/download URLs have
  short lifetimes; do not treat them as durable resource identifiers.

## Observer verification

Proposed default: library/folder bindings are private-only until a complete
per-resource access oracle is demonstrated. Single-design bindings can use an
observer's own token to check equivalent data access, but metadata access alone
does not establish permission to see content, comments, assets, or export bytes.
Do not enable collaborators based on the owner's successful fetch or an assumed
folder-inherited ACL. Unsupported observer verification must fail closed.

## Completed review checkpoint

The required skill says: “Do not proceed without operator approval.” The agent
presented the self-contained `src/types.d.ts` proposal before implementation. The
operator explicitly replied “i approve the api” and instructed the agent to finish
building and fulfill the goal before creating the public repository. That
instruction authorized completion of the security paths as well as the core.
