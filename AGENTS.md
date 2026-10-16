## Cloudflare development preference

Use the Cloudflare CLI (`cf`) whenever building things with Cloudflare. Prefer `cf`
for development, deployment, and resource management where supported. Consult
https://developers.cloudflare.com/cf/get-started/ for current setup and usage, and
use `cf cli search` or command help to discover commands.

## Gatekeeper contract

Use the pinned canonical host interfaces in `research/upstream/gatekeeper.ts` and
follow `research/upstream/write-gatekeeper-SKILL.md`. The API in `src/types.d.ts`
was explicitly approved by the operator. Preserve the action/observation gates and
runtime capability boundaries when making changes.
