/** Trust only the runtime's Access context, never caller-supplied identity headers. */
export type AccessPrincipal = { audience: string; userId: string };

export async function accessPrincipal(ctx: Pick<ExecutionContext, "access">, audience: string): Promise<AccessPrincipal> {
  if (!audience || !ctx.access || ctx.access.aud !== audience) throw new Error("Access required");
  const identity = await ctx.access.getIdentity();
  if (!identity?.user_uuid || typeof identity.user_uuid !== "string") throw new Error("An Access user identity is required");
  return { audience, userId: identity.user_uuid };
}

export function samePrincipal(a: AccessPrincipal, b: AccessPrincipal): boolean {
  return a.audience === b.audience && a.userId === b.userId;
}

export function accessDenied(): Response {
  return new Response("Cloudflare Access authentication required", { status: 403, headers: { "Cache-Control": "no-store" } });
}
