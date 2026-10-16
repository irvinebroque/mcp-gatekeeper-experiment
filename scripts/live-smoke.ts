/** Optional live verification. Reads only; credentials stay in ignored .local/. */
import fs from "node:fs/promises";
import { McpClient, object, items } from "../src/protocol";
import * as decode from "../src/decode";

const file = ".local/oauth-tokens.json";
let tokens = JSON.parse(await fs.readFile(file, "utf8"));
let issued = (await fs.stat(file)).mtimeMs;
const clientInfo = JSON.parse(await fs.readFile(".local/oauth-client.json", "utf8"));
const client = new McpClient(async () => {
  if (issued + tokens.expires_in * 1000 < Date.now() + 60_000) {
    if (!tokens.refresh_token) throw new Error("Run the discovery sign-in again");
    const response = await fetch("https://mcp.canva.com/token", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientInfo.client_id, resource: "https://mcp.canva.com/mcp" }) });
    if (!response.ok) throw new Error(`Canva refresh failed: HTTP ${response.status}`);
    const updated = object(await response.json());
    tokens = { ...tokens, ...updated }; issued = Date.now();
    await fs.writeFile(file, JSON.stringify(tokens), { mode: 0o600 });
  }
  return tokens.access_token;
});
const verified: string[] = [];
async function read(name: string, args: Record<string, unknown>) {
  const value = await client.call(name, args); verified.push(name); return value;
}
const search = await read("search-designs", { limit: 1 });
const first = decode.design(items(search.items)[0]);
await read("search-folders", { limit: 1 });
await read("list-folder-items", { folder_id: "root" });
decode.design(object((await read("get-design", { design_id: first.id })).design));
items((await read("get-design-pages", { design_id: first.id, limit: 10 })).items).map(decode.page);
const text = await read("get-design-content", { design_id: first.id, content_types: ["richtexts"] });
if (typeof text.text !== "string") throw new Error("Unexpected text response");
object((await read("get-export-formats", { design_id: first.id })).formats);
items((await read("list-comments", { design_id: first.id, limit: 10 })).items).map(decode.comment);
decode.dataset(await read("get-design-dataset", { design_id: first.id }));
await fs.writeFile("research/live-verification.json", JSON.stringify({ verifiedAt: new Date().toISOString(), endpoint: "https://mcp.canva.com/mcp", implementation: "src/protocol.ts and src/decode.ts", mode: "read-only", passedTools: verified, mutationsPerformed: 0, accountContentRecorded: false }, null, 2) + "\n");
console.log(`Live Canva verification passed: ${verified.length} read-only tools; no account content printed or recorded.`);
