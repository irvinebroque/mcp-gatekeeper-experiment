# Canva MCP Gatekeeper experiment

This is a **one-shot using Astra to generate a Gatekeeper from an existing MCP
server, by first letting the agent log in and use the MCP server**. “One-shot”
describes one continuous experiment, including human sign-in, API review, and
follow-up instructions; it does not mean one model response or zero human input.

The result is an implemented Cloudflare Worker targeting the Cloudflare OS
Gatekeeper contracts. It turns Canva's authenticated MCP tools into scoped
TypeScript capabilities, with observations and actions mediated by the host's
approval queue. The implementation and local tests are complete. It has not been
deployed or tested inside a running Cloudflare OS installation.

## Original prompt

> your goal is to reverse engineer this MCP Server
>
> [https://www.canva.dev/docs/apps/mcp/](https://www.canva.dev/docs/apps/mcp/)
>
> to be a gatekeeper
>
> you should auth with my canva account in order to discover the tools
>
> you must use this skill for guidance on what makes a good Gatekeeper [https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md)

## What happened in this chat

1. The workspace started empty. The agent read the required
   [write-gatekeeper skill](research/upstream/write-gatekeeper-SKILL.md), the
   canonical Cloudflare OS interfaces, Cap'n Web documentation, and Canva's docs.
   The operator instructed it to use the Cloudflare CLI (`cf`).
2. The operator supplied a Canva account and completed its emailed sign-in code in
   the browser. The agent registered its own research OAuth client, used PKCE and
   a loopback callback, and connected to `https://mcp.canva.com/mcp`. Credentials
   and raw account responses stayed in ignored local files.
3. Authenticated `initialize` and `tools/list` returned **48 tools** and MCP
   protocol `2025-03-26`. The live catalog differed from the public tool table.
   Only eight tools had output schemas. Nine read-only probes exposed response
   shapes that also differed from documentation, including flattened design text.
4. The agent classified every tool and proposed a capability API for a library,
   folder tree, or single design. It stopped at the skill's API checkpoint. The
   operator explicitly replied **“i approve the api”**.
5. The operator requested a public repository named
   `irvinebroque/mcp-gatekeeper-experiment`, with the original prompt and this
   history. They then said **“please finish building and fulfill the goal before
   creating new github repo”**. Implementation and verification preceded creation
   of the remote repository.
6. The agent implemented OAuth account storage and reconnects, actual Workers RPC
   capabilities, resource selection, the approval journal, observation checks,
   caching, local simulation, and private-only observer policy. It checked these
   in workerd, rather than relying only on TypeScript interfaces. Live read tests
   against the implementation caught and corrected a flattened-text decoder bug.
7. A follow-up requested a branch investigating Cloudflare Access and managed
   OAuth, then a PR to `main`. The operator immediately said **“WAIT — before you
   take that step i want you to keep going on the original goal”**. That follow-up
   is deferred; this initial implementation retains its account OAuth code.
8. After publication, the operator explicitly allowed writes to the Canva account
   for testing. The agent obtained write scopes, imported a public one-page test
   PDF, copied it, and ran 14 approved actions covering 11 write tools. It verified
   committed text/title changes, cancelled changes, comments/replies, moves, and
   downloadable PDF bytes. Both test designs were moved to recoverable Trash and
   the empty test folder was removed. A Miniflare test harness issue with nested
   RPC returns was resolved by running the scenario controller inside workerd;
   no production adapter changes were needed for these write paths.

The initial pass used read-only live probes and synthetic write fixtures. The
subsequent authorized live write pass touched only newly created test content.
AI generation, asset uploads, brand publication, and the other untested write
paths remain covered by synthetic fixtures only.

## The Gatekeeper

| Grant | Session | Authority |
| --- | --- | --- |
| `https://www.canva.com/` | `CanvaLibrarySession` | Explicit account-wide discovery, creation, composition, and accessible content. |
| `https://www.canva.com/folder/:folderId` | `CanvaFolderSession` | The selected folder and verified current descendants. |
| `https://www.canva.com/design/:designId/*` | `CanvaDesignEditor` | Read and edit one design, including comments and exports. |

The approved [agent-facing API](src/types.d.ts) exposes resource objects, private
cursors, drafts, and jobs. A folder-derived design exposes fewer methods than a
library-derived design. These are separate RPC implementations: changing a
TypeScript type cannot reveal a hidden copy, resize, or publishing method.

**41 tools are mapped**: 20 observations and 21 actions. The seven exclusions are
legacy generation tools, raw upload capabilities, generic help, and internal
telemetry/widget helpers. The complete decisions are in the
[tool map](research/tool-map.md). Unknown tools and unreviewed schema variants
fail closed.

- Read results, including cached data, job results, and previews, require
  `authorizeObservation()` before disclosure. Folder ancestry and membership are
  checked again after reads and before writes. Revocation also blocks cached reads.
- Every mutation is journaled through `submitAction()`. Only the privileged host's
  `applyAction()` dispatches it upstream. No action is automatically approved.
  Exact arguments are included in its review description.
- The durable journal tracks dependencies and attempted writes. An ambiguous
  network outcome becomes `unknown` and is never blindly replayed. Partial edit
  failures block dependent commits. There is no generic automatic undo.
- Pending comments, replies, folders, text/title edits, and page changes have local
  overlays. Provisional objects resolve to real IDs only after application. Draft
  snapshots simulate supported edits. AI output, exports, render previews, and
  initial editable element IDs wait for real results. Pending moves temporarily
  make folder listing report processing because a reliable source snapshot is
  unavailable. Rejected actions invalidate dependent work.
- Observer attachment is denied for all grants. Equivalent access to all content,
  comments, and exports has not been proven under a collaborator's own token.
- OAuth tokens stay in a per-account Durable Object. Connection links and state
  are one-use and expiring; reconnects stage credentials until the host commits
  the exact stage; refreshes are serialized; revocation retains a local tombstone.

## Run locally

Requires Node.js **22.18+**. The lockfile pins the tested dependency versions.

```sh
npm ci
npm run generate
npm run typecheck
npm test
npm run test:runtime
npm run build
npm run dev
```

`generate` builds the pinned schema validators, embeds the resource selector, and
generates Workers types with `cf`. Build and dev run it automatically. No Cloudflare
account or Canva credentials are needed for the unit/runtime tests or local build.
`GET http://localhost:8787/health` checks the HTTP entrypoint. The resource API is
Workers RPC, not a public HTTP tool endpoint.

### Connect it to Cloudflare OS

The host should bind the `GatekeeperVendor` named entrypoint of the deployed
`canva-gatekeeper` Worker as `GATEKEEPER_CANVA` and register it in its vendor list.
For example, in a host's `cloudflare.config.ts` worker environment:

```ts
GATEKEEPER_CANVA: bindings.worker({
  worker: "canva-gatekeeper",
  exportName: "GatekeeperVendor",
})
```

The host drives `connectAccount()`, redeems the connection handoff, obtains the
resource class from `getGatekeeperClassFor()`, and creates its per-resource,
per-Gadget DO facet. It supplies the canonical `ApprovalQueue` to `startSession()`.
The browser resource selector uses the host's MessagePort handshake. No alternate
approval server or HTTP bearer bypass is included.

This standalone repository compiles against the pinned
[Cloudflare OS contract snapshot](research/upstream/gatekeeper.ts). Host registration
and an end-to-end Workshop run remain integration work; this repository does not
modify the Cloudflare OS monorepo.

### Canva OAuth configuration

The implementation deliberately targets the **researched legacy endpoint**
`https://mcp.canva.com/mcp` and its advertised authorization server. Configure an
approved client for that endpoint with callback `<BASE_URL>/callback`. Set the
`BASE_URL` binding in [cloudflare.config.ts](cloudflare.config.ts) to the Worker's
public HTTPS origin before deployment. For local testing, use ignored `.dev.vars`:

```dotenv
CANVA_CLIENT_ID=your-client-id
CANVA_CLIENT_SECRET=your-client-secret
```

A registered public PKCE client uses an empty client secret. The Worker does not
dynamically register production clients or import the research account's tokens.
Manage deployed secrets through `cf` and discover the current commands with
`cf cli search "Worker secrets"`. See the
[Cloudflare CLI setup](https://developers.cloudflare.com/cf/get-started/).

Canva's [current access guidance](https://www.canva.dev/docs/apps/mcp/access-and-permissions/)
directs new integrations to its self-serve Developer Portal and
`https://api.canva.com/connect/v1/mcp`; legacy access is subject to approval.
Successful research registration is not evidence of production approval. The new
endpoint's OAuth behavior is not implemented or verified here. Switching only the
URL would not be a verified migration.

## Verification and limits

- **17 unit tests** cover journal behavior, concurrency, ambiguous outcomes,
  membership changes, cache authorization, response parsing, and chunked storage.
- **45 workerd runtime checks** exercise all 41 mapped tools with synthetic
  fixtures, real Workers RPC objects, SQLite Durable Objects, and mocked Canva
  responses. They include missing-method attacks, scoped child capabilities,
  draft simulation, OAuth refresh, one-use connect links, staged reconnects, and
  revocation after a cleanup alarm.
- **Nine real read-only calls** passed through the implemented transport and
  decoders. The [sanitized report](research/live-verification.json) records the
  tools and time, with no account content.
- **14 real actions across 11 write tools** passed through the production sessions,
  protocol adapter, and executor inside workerd. The
  [live write report](research/live-write-verification.json) records the checks,
  fixture counts, and verified cleanup. [Sanitized response shapes](research/write-probe-shapes.json)
  omit resource IDs, author identities, content values, and temporary URLs.
- Type checking, the `cf build` production bundle, and local HTTP startup are
  checked. Other write tools and editing variants, paid-plan permissions, provider
  revocation semantics, the new self-serve MCP endpoint, browser UI inside Workshop,
  and deployed host integration remain unverified. Source schemas and fixture
  tests cannot establish those behaviors.

### Repeat discovery or live read verification

```sh
node scripts/discover-canva.mjs
# Open http://127.0.0.1:8976/login and finish Canva sign-in.
node scripts/discover-canva.mjs --reuse --probe
node scripts/summarize-catalog.mjs
npm run test:live
```

Discovery requests read scopes and uses an explicit read-tool allowlist. Raw probe
responses and credentials stay under ignored `.local/`, with credential files
mode 0600. The live smoke test refreshes that local research token when needed and
records only the pass/fail tool inventory. These files are separate from the
Worker's connected-account storage.

### Repeat the opt-in live write test

This creates one folder, an imported design, and a design copy. Only run with the
account owner's authorization. It uses a separate write-scoped research token:

```sh
node scripts/discover-canva.mjs --write
# Complete Canva consent at http://127.0.0.1:8976/login.
npm run test:live:write -- --execute
```

The test-only Worker is never imported by the production configuration. The local
approval queue records submissions; the scenario explicitly applies each action.
Private credentials, durable state, transcripts, fixture IDs, and preview URLs
remain in ignored `.local/live-write/` and `.local/oauth-write-tokens.json`.

If interrupted, inspect the private manifest and transcript before using
`--execute --resume`. Never replay an ambiguous write. The runner refuses to start
a duplicate run over an existing manifest, and refuses to resume cleaned-up
fixtures. Archive that private manifest/state before a separately authorized new
run. It does not automatically delete fixtures: Canva MCP has no delete tool.
After testing, move only the exact test designs to Trash in Canva's UI, remove the
empty test folder, and record cleanup in the private manifest. Do not empty Trash.

## Evidence and source layout

- [Retrospective feedback on the write-gatekeeper skill](research/write-gatekeeper-skill-feedback.md).
- [API decisions](research/api-proposal.md) and [design constraints](research/design-notes.md).
- [Authenticated catalog](research/tools.json), [tool mapping](research/tool-map.md),
  and [sanitized probe shapes](research/probe-shapes.json).
- [Protocol adapter](src/protocol.ts), [policy/journal engine](src/core.ts),
  [resource capabilities](src/sessions.ts), [OAuth account](src/oauth.ts), and
  [Worker entrypoints](src/index.ts).
- [Pinned upstream hashes](research/upstream-sha256.json) and [third-party notices](NOTICE).

Licensed under Apache-2.0; vendored Cap'n Web documentation retains its MIT license.
