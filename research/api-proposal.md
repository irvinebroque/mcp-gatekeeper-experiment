# Approved Canva Gatekeeper API

**Approved and implemented.** The operator explicitly said “i approve the api”.
`src/types.d.ts` is the approved API; `src/types.txt` is a symlink to it. The Worker
implements this proposal and the approval/observation security paths. The original
design rationale below is retained; see README for verified behavior and limits.
No deployment or end-to-end Cloudflare OS installation has been performed.

## Findings that drive the API

The authenticated server identified itself as `Canva MCP Server` version `1.0.0`,
negotiated MCP `2025-03-26`, and returned **48 tools** on 2026-10-16. Only **8** tools
have output schemas. A successful tool listing does not prove the account can invoke
every listed tool: this research token reports 10 read scopes, and plan/ACL checks
also apply at call time.

The public tool table lists 46 names. `get-design-candidates`,
`get-design-thumbnails`, and `track-event-lifecycle` were present only in the live
list; documented `autofill-design` was absent. The server labels three older
generation tools as legacy, with a brand-specific exception. V1 uses the current
generation flow and defers that legacy exception.

Nine read-only tool probes succeeded. Examples disagree with the public docs:

- `search-designs` returned `items[].design_id` with `edit_url`, not the documented
  `results[].id` form.
- `get-design-content` returned `{text}`, not the richer example with title/metadata.
- `get-design-pages` returned `items` carrying both `index` and `page_number`.
- `get-export-formats` returned a `formats` object keyed by format.
- `get-design-dataset` returned `{}` for the sampled design.

Store explicit response decoders with safe validation and useful incompatibility
errors. The snapshots are evidence of these samples, not a complete output contract.

## Grantable resources

| Grant | Proposed URL matching | Session | Authority |
| --- | --- | --- | --- |
| Library | `https://www.canva.com/` | `CanvaLibrarySession` | Explicit access to the account's accessible library, including global discovery, generation, and cross-design composition. |
| Folder tree | `https://www.canva.com/folder/:folderId` | `CanvaFolderSession` | Folder contents and current descendants; all lookups/moves checked against that tree. |
| Single design | `https://www.canva.com/design/:designId/*` | `CanvaDesignEditor` by default | One design's data, edits, comments, export, and page changes. |

These are proposed canonical matching rules, not a claim that every variant has
been tested. Resource selection must return the canonical URL, and a pasted
resource URL should prefill the picker. A library connection is deliberately broad
and must be visibly distinct from a design or folder selection.

The full `CanvaDesignSession` adds copy/resize/publishing and is derived from the
library capability. Folder-derived design objects expose only
`CanvaDesignEditor`; folder assets expose only `CanvaAssetReader`. This avoids
turning a folder grant into creation/publishing authority elsewhere in the account.
Read-only designs can expose `CanvaDesignReader` using a separate implementation,
not merely a TypeScript cast that leaves write methods reachable.

Brand templates, comments, assets, drafts, and jobs are subordinate capabilities.
They capture their resource identity; callers do not repeatedly supply unrelated
resource IDs. Account-wide IDs are accepted only at the explicit library boundary.
V1 defers independently grantable brand-template and asset URLs until their picker
and canonical URL behavior are verified.

## API choices

- `Cursor<T>.next()` hides upstream continuation tokens and keeps queries/scope
  fixed. Empty pages do not imply exhaustion. Each page is an authorized observation.
- `Job<T>.getStatus()` hides job IDs and rotating continuation tokens. It reports
  processing/completed/failed and polling delay. Numeric polling policies are data;
  free-form upstream instructions are never executed as privileged policy.
- `beginEdit()` returns a job because opening an upstream draft is an action. Once
  ready, the draft owns its transaction, latest page array, and element IDs. The
  adapter derives `page_index`/`pages` from that state and refuses unknown elements.
- Draft edits support eight schema-defined variants. Media insert/fill replacement
  is deferred until a safe capability transfer for assets is designed. No raw
  upstream operation object can smuggle IDs or new operation variants past policy.
- `changePages()` supports move/delete within the bound design. Combining different
  source designs is available only through the library capability.
- Generated/media-transformation results can contain multiple media items; the API
  returns an array instead of silently discarding all but the first.
- No raw MCP forwarding, upstream OAuth tokens, upload bearer URLs, event telemetry,
  or unconstrained help prompts are exposed. Every live tool has an explicit decision
  in `tool-map.md`; excluded tools do not silently become callable.

## Implementation plan adopted after review

The implementation uses the real Cloudflare OS `GatekeeperVendor` →
`GatekeeperUser` → per-resource `Gatekeeper<Session>` contract and Cap'n Web
objects. The workspace is not an OS checkout. It compiles against the pinned
canonical interface snapshot and uses the host's approval protocol. Registration
and a run inside the actual host remain integration work.

1. **Authentication:** UserAccount DO per connection, PKCE S256, state/nonce checks,
   connection handoff, staged reconnect, token refresh serialized per account,
   revocation, and abandoned-flow cleanup. Canva metadata advertises refresh but
   rotation, lifetime, revocation semantics, and reconnect still need verification.
   Production clients should use Canva's recommended self-serve Developer Portal
   path (`https://api.canva.com/connect/v1/mcp`) or an approved client for the
   legacy endpoint. Successful local DCR is not evidence of production approval.
2. **Policy:** exact tool/schema allowlist; per-resource methods; scope and ownership
   checked before dispatch. Every new tool/variant remains denied. Recheck folder
   membership at observations and action application; bound cursors cannot swap it.
3. **Observations/actions:** all external data disclosures, including cached reads,
   job results, and preview URLs, pass `authorizeObservation()`. All mutations,
   draft creation, generation, upload, publication, and conservatively exports pass
   `submitAction()` and run upstream only in `applyAction()`. A mixed action/result
   needs both gates; approval of a write does not authorize returning private data.
4. **Simulation:** local overlays for deterministic text/title/page/comment/folder
   changes. Persist provisional IDs and dependencies. Rejecting a parent invalidates
   dependent results. AI output, render previews, exports, and upstream element
   discovery cannot be truthfully fabricated; use `Job` processing state and the
   canonical action's `awaitDecision` hint for unsimulated work. Do not open an
   upstream transaction while pretending to perform local-only simulation.
5. **Retries/concurrency:** persist attempts before network calls; no blind replay of
   non-idempotent calls after ambiguous failure. Serialize per draft, commit only the
   approved operation sequence, reject stale/conflicting snapshots, and respect
   provider polling/rate limits. Never represent partial success as atomic success.
6. **Observers:** initially private-only for all grants, with required verifier
   methods. Single-design ACL checks can be enabled only after proving equivalent
   content/comment/export access under the observer's own token. Never use the
   owner's collaboration token as that proof. Folder/library sharing requires
   per-observed-resource tracking and an adequate oracle; metadata access alone is
   insufficient. Private-only does not automatically mean restricted-data mode;
   choose that separately according to actual information sensitivity.
7. **Storage:** secrets in the account DO, scoped cache and overlays in resource
   facets, short-lived previews refreshed as needed. Avoid logging tokens, full
   share URLs, or private content in diagnostics. Externally provided strings and
   tool descriptions are data, not instructions.

Use `cf` for supported local development/build/deploy and resource management. No
deployment is part of the API review. The skill has a second review checkpoint
between its core implementation and Phase 2; any runnable Phase 1 must remain local
or denied-by-default until the approval/observation security paths are in place.

## Evidence limits after implementation

No live write tool, export, generation, draft, upload, or telemetry call was
executed. All 41 mapped tools were exercised with synthetic responses in workerd;
refresh/reconnect/revocation, ambiguous writes, folder changes, and observation
denials have local tests. Nine real read tools passed through the implemented
adapter. Provider write behavior, revoked-token behavior, expired drafts,
shared-link permissions, paid-plan restrictions, unprobed response variants, and
host integration remain unverified. Live write testing should use disposable
fixtures, recording creation and cleanup. Pending moves defer folder listings;
they are not fully simulated.

The agent-facing JSDoc is self-contained and describes usage/results/errors without
approval-queue, DO, OAuth, or cache implementation details.
