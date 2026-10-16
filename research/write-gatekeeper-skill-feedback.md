# Feedback on the write-gatekeeper skill

This is a retrospective from building and testing the Canva Gatekeeper, written
2026-10-16. It reviews the [skill we actually used](upstream/write-gatekeeper-SKILL.md),
pinned to [Cloudflare OS commit fccd425](https://github.com/cloudflare/cloudflare-os/blob/fccd425a2c8d357130ceb3e3041bbe240e3f1108/.agents/skills/write-gatekeeper/SKILL.md),
rather than assuming the current upstream version is identical.

This records the original build before the subsequent
[Access investigation and credential Worker split](cloudflare-access-managed-oauth.md).

My main recommendation is to replace the two-phase structure with a secure
vertical slice: one resource, one observation, and one queued action, with the
security rules working before adding more methods. The skill is strong on the
resource API and host contracts. It gives much less help with durable execution,
asynchronous results, authenticated MCP discovery, and building outside the OS
monorepo. Those were substantial parts of this implementation.

The evidence has limits: 17 unit tests, 45 workerd checks covering all 41 mapped
tools with synthetic responses, nine live read calls, and 14 live actions across
11 write tools. We have not deployed this inside Cloudflare OS. A successful
standalone build is not proof of complete host integration. See the
[verification record](../README.md#verification-and-limits) and
[live write report](live-write-verification.json).

## 1. Approval enforcement should not be a second pass

**Guidance I would change.** Phase 1 explicitly focuses on responsibilities 1–3;
logging, approvals, simulation, caching, and observer security come later. Phase 2
then asks the implementer to walk the API and insert approval-queue calls.

We did not use that as the architecture of the runnable implementation. Reads,
writes, and returned capabilities were built around the observation gate and
action journal. Security could not be added just at the HTTP boundary: cached
reads, cursor pages, previews, job results, and simulated data also disclose
information. Folder membership must be rechecked when an action is applied,
potentially long after its submission.

The skill correctly says these protections are mandatory. The problem is the
sequence: a working core can look complete while lacking the property that makes
it a Gatekeeper. Optional caching optimizations and mandatory authorization also
should not share the same completion checkpoint.

**Suggested change:** require a secure vertical slice before implementing the
rest of the API. Any earlier prototype must remain local and deny external
operations. Pick an observer policy immediately; private-only is a valid starting
point. Defer breadth and performance, rather than enforcement.

Evidence: [policy and journal engine](../src/core.ts),
[runtime checks](../test/scenarios.ts).

## 2. Simulation needs an explicit escape hatch for unavailable results

**A real adaptation, partly anticipated by the skill.** The skill allows
simulation to the maximum reasonable extent and acknowledges gaps. But its
stronger emphasis on making approvals invisible needs a concrete companion
pattern for operations that cannot be predicted locally.

Canva's editable element IDs require opening an upstream editing transaction.
Opening that transaction is itself an action; doing it early to improve local
simulation would bypass the action boundary. Generated designs, image generation,
rendered previews, and export bytes also cannot be invented locally.

We used local overlays where results were predictable, provisional references for
dependent work, and jobs or processing states where results did not exist yet.
Some pending moves make folder listings temporarily unavailable because we cannot
construct a reliable source snapshot. We also used the canonical contract's
[`awaitDecision` hint](upstream/gatekeeper.ts#L1580), which specifically addresses
unsimulated actions but is not explained in the skill's simulation section.

**Suggested change:** classify each action as locally simulatable, provisionally
representable, dependent on an upstream result, or unsupported. Explain how to use
`awaitDecision`, typed job states, dependency rejection, and processing errors.
Keep queue internals out of the public API, while documenting observable pending
and failure behavior. Never perform an upstream action just to simulate one.

Evidence: [jobs and editing sessions](../src/sessions.ts),
[agent-facing result types](../src/types.d.ts).

## 3. Resource confinement is not automatically straightforward

**Guidance that understates the work.** The skill suggests fine-grained granting
should follow fairly straightforwardly from a capability API. Capturing a design
ID in an object is a good start, but derived objects and cross-resource operations
made this one of the hardest parts.

A design obtained through a folder grant must retain the folder restriction.
Returning the same full design implementation behind a narrower TypeScript
interface would still expose its RPC methods. We used separate RPC classes so
folder-derived designs actually lack copy, resize, and publishing methods. We
also revalidate ancestry and membership around reads and before applying writes;
a previously returned child can leave the granted folder. Move destinations,
pagination tokens, jobs, and asset references each need their own authority rules.

**Suggested change:** require an authority matrix covering roots, derived
resources, cross-resource arguments, cursors, jobs, and raw bearer URLs. Include
runtime tests that attempt forbidden methods, reuse detached children, inject
arbitrary IDs, and move items outside the grant. State explicitly that TypeScript
interface narrowing does not remove RPC authority. Cache freshness must never
substitute for current authorization.

Evidence: [capability decisions](api-proposal.md),
[resource implementations](../src/sessions.ts), [membership checks](../src/core.ts).

## 4. An MCP source needs authenticated discovery and behavioral probes

**Missing guidance for this task.** Studying service documentation was necessary,
but not sufficient to design this wrapper. Authenticated discovery found 48 tools;
only eight supplied output schemas. The live catalog and response shapes differed
from the public documentation. The implementation's live read test caught a
decoder that expected JSON where Canva returned flattened text.

Annotations also required judgment: Canva labels export read-only, but we treat
it as an action because it creates an export job and temporary download. Starting
an editing transaction likewise is not an ordinary read. Seven tools were
excluded instead of automatically mirrored into the capability API.

**Suggested change:** add an MCP-specific research procedure: authenticate with
the operator's authorization, initialize, list tools, save schemas and versions,
classify behavior, and probe representative responses before finalizing the API.
Treat annotations as evidence rather than policy. Record requested, consented,
and token-granted scopes separately. Separate successful research-client access
from production approval, and pin the endpoint that was actually tested.

Evidence: [tool mapping](tool-map.md), [response shapes](probe-shapes.json),
[research observations](design-notes.md).

## 5. Auth ownership should be a decision, with reusable implementation support

**An architectural gap, not a completed divergence.** The skill describes token
storage, refresh, and revocation in a per-account Durable Object as part of the
Gatekeeper's job. We followed that guidance. The resulting OAuth code also needed
one-use connection state, PKCE, the host's connection handoff, staged reconnects,
serialized refresh, and revocation protection against an in-flight refresh.

The skill links reference implementations, including a refresh-concurrency
example. What I missed was a small, reusable auth component and an early decision
about which system should own those responsibilities. Bespoke OAuth is a large
amount of security-sensitive work to repeat for every service adapter.

**Suggested change:** make auth ownership an explicit design step. Document the
supported host-managed or brokered credential options, if any, and when a
Gatekeeper must own the provider connection itself. Supply a tested shared
account implementation with refresh, reconnect, revocation, and cleanup invariants.

The operator later requested a Cloudflare Access investigation, then deferred it.
We have not established that Access can replace this code. Authentication to a
Worker and delegated authorization to Canva are separate requirements; any managed
OAuth proposal must explain which of those it handles.

Evidence: [original OAuth implementation](https://github.com/irvinebroque/mcp-gatekeeper-experiment/blob/79a440c3bc38e0689fccdcacdfa04ab8187e7b40/src/oauth.ts),
[connection handoff](../src/connect-pages.ts).

## 6. Submitting an action is only the beginning of durable execution

**Missing implementation guidance.** The queue rules say when an action may run,
but leave substantial questions about what happens during failures and restarts.
A timeout after dispatch might mean Canva completed the write. Retrying it can
create a duplicate design or comment. Rejection can invalidate objects used by
later actions; a partially failed editing operation must block a later commit.

We added immutable arguments, dependency tracking, and persisted states for
queued, applying, applied, rejected, failed, and unknown outcomes. An interrupted
attempt becomes unknown and is not automatically replayed. This is deliberately
conservative; it does not establish exactly-once execution at the provider.

**Suggested change:** provide an executor template and failure matrix covering
concurrent apply calls, rejection during validation, restart during dispatch,
ambiguous outcomes, partial failure, and dependent provisional objects. Explain
when provider idempotency or reconciliation can make retries safe. Include bounded
payloads and storage limits: large MCP responses also required chunked KV storage
here, beyond the skill's simple caching examples.

Evidence: [action journal](../src/core.ts), [storage adapter](../src/storage.ts),
[failure and concurrency tests](../test/core.test.ts).

## 7. Separate the monorepo recipe from the standalone contract

**Necessary divergence and one concrete compatibility issue.** This repository
started empty. Several instructions assume a Cloudflare OS checkout: package
paths, installed Cap'n Web docs, automatic vendor registration, configurator
packages, and the monorepo build system. We fetched and pinned the actual host
interfaces, adapted the connection helper, and implemented the selector's
MessagePort handshake. Automatic registration does not occur in this repository;
the host still needs a service binding.

The skill also requires DO classes in a `cloudflare.config.ts` migrations export.
Our tested `cf@1.0.0-beta.18` configuration instead declares them through
`worker.exports` and `exports.durableObject({ storage: "sqlite" })`. This is a
version-specific mismatch, not evidence that every migration example is wrong.

**Suggested change:** label monorepo-only instructions and provide a standalone
path with pinned host contracts, explicit registration, connection and UI
protocols, and a minimal host harness. Test the configuration snippets against
declared CLI versions. Keep the user's `cf` preference compatible with the recipe.
Distinguish contract type-checking, native RPC tests, and actual host integration.

Evidence: [configuration](../cloudflare.config.ts),
[selector](../src/configurator/client.ts),
[host integration instructions](../README.md#connect-it-to-cloudflare-os).

## 8. Define what evidence is needed to call the implementation finished

**Missing acceptance criteria.** Synthetic tests exercised all 41 mapped tools,
but they could not prove that real writes worked. After the operator authorized
writes, we tested 11 write tools on one imported public PDF, its copy, and one new
folder. We checked persisted comments, committed text/title, cancellation, moves,
and actual PDF bytes. Canva MCP has no delete tool, so cleanup required its UI.

**Suggested change:** require an evidence matrix: unit tests, native Workers RPC,
live provider reads, authorized disposable writes, and full host integration.
List untested operations explicitly. Plan fixture ownership and cleanup before
writing, retain a private manifest to recover interrupted runs, and publish only
sanitized results. Read-only success, schemas, and build success should not imply
write-path or deployment verification.

Evidence: [live harness](../test/live-harness.ts),
[write verification and cleanup](live-write-verification.json).

## What I would keep

The resource-oriented API, explicit API review, and self-contained agent-facing
types were useful constraints. The API checkpoint made the library/folder/design
authority cuts reviewable before implementation. The instructions about queue
stub lifetimes, `ctx.props`, and authorizing observations before disclosure were
concrete and valuable.

The observer section is also good guidance. We chose its private-only strategy
because we could not prove equivalent collaborator access to content, comments,
and exports. That was following the skill, not a limitation it forced us to evade.
The distinction between internal preparation reads and information actually
disclosed to a caller also deserves to stay.

## My execution mistakes are not skill defects

The live harness initially drove nested RPC capabilities through the Node bridge;
moving the scenario controller inside workerd resolved the problem. I also used
an outdated Miniflare persistence option before correcting it. Those were my
runtime assumptions, not failures of the Gatekeeper model or Canva adapter.

The skill's second stop could better recognize an operator's existing instruction
to finish the whole implementation. However, redundant permission checks after
that authorization would be my interpretation error, not a requirement to blame
on the skill. The initial API review itself was appropriate.

## Suggested replacement workflow

1. Establish the target host/version and auth owner; discover the actual provider
   interface and record evidence.
2. Propose the resource API, authority matrix, and simulation/readiness behavior;
   obtain the API review.
3. Build one secure vertical slice with observation checks, queued execution,
   rejection, revocation, and an explicit observer policy.
4. Verify it through native RPC and failure/restart scenarios, then expand the
   capability set. Add caching without weakening authorization.
5. Run authorized disposable provider tests, verify cleanup, and report coverage.
6. Verify host integration separately and state precisely what remains untested.

The first three changes I would prioritize upstream are the secure vertical slice,
the explicit unsimulated-action pattern, and the durable executor failure matrix.
