import test from "node:test";
import assert from "node:assert/strict";
import { accessPrincipal } from "../src/access";

test("Access requires the native context, the configured audience, and a human identity", async () => {
  await assert.rejects(accessPrincipal({}, "app"));
  await assert.rejects(accessPrincipal({ access: { aud: "other-app", getIdentity: async () => ({ user_uuid: "a" }) } }, "app"));
  await assert.rejects(accessPrincipal({ access: { aud: "app", getIdentity: async () => undefined } }, "app"));
  await assert.rejects(accessPrincipal({ access: { aud: "app", getIdentity: async () => ({ email: "user@example.com" }) } }, "app"));
  assert.deepEqual(await accessPrincipal({ access: { aud: "app", getIdentity: async () => ({ user_uuid: "a" }) } }, "app"), { audience: "app", userId: "a" });
});
