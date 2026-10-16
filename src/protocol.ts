import * as validators from "./generated/validators.js";
import map from "../research/tool-map.json";

export type Data = Record<string, any>;
export const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function object(x: unknown): Data {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Unexpected Canva response shape");
  return x as Data;
}
export function string(x: unknown): string {
  if (typeof x !== "string") throw new Error("Expected a string");
  return x;
}
export function items(x: unknown): Data[] {
  if (!Array.isArray(x)) throw new Error("Expected a Canva result list");
  return x.map(object);
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("Canva returned malformed JSON"); }
}
export const policy = new Map(map.tools.map(t => [t.name, t.classification]));
export function validate(name: string, args: Data, output = false): void {
  const key = name.replaceAll("-", "_") + (output ? "_output" : "");
  const check = (validators as Record<string, (x: unknown) => boolean>)[key];
  if (!check && !output) throw new Error("Unreviewed tool");
  if (check && !check(args)) throw new Error(`Invalid ${output ? "response" : "arguments"} for ${name}`);
}

export async function boundedText(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > max) throw new Error("Canva response exceeded size limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

// Server-directed events may keep the stream open. Stop at our response, never wait for EOF.
export async function rpcResponse(response: Response, id: number): Promise<Data> {
  if (!response.ok) throw new Error(`Canva MCP HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const value = object(parseJson(await boundedText(response)));
    if (value.id !== id) throw new Error("Mismatched MCP response");
    return value;
  }
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error("MCP event stream ended without a result");
      size += part.value.length;
      if (size > 8 * 1024 * 1024) throw new Error("MCP response exceeded size limit");
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = object(parseJson(data));
        if (value.id === id) return value;
      }
    }
  } finally { await reader.cancel(); }
}

export interface ToolClient { call(name: string, args: Data): Promise<Data>; ensureActive?(): Promise<void> }

export class McpClient implements ToolClient {
  #session?: string;
  #ready?: Promise<void>;
  #id = 0;
  constructor(private readonly token: () => Promise<string>, private readonly endpoint = "https://mcp.canva.com/mcp", private readonly request: typeof fetch = fetch) {}
  async #send(method: string, params: Data, notify = false): Promise<Data> {
    const id = ++this.#id;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
    };
    if (this.#session) headers["Mcp-Session-Id"] = this.#session;
    const response = await this.request(this.endpoint, {
      method: "POST", headers, redirect: "manual", signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id }), method, params }),
    });
    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.#session = session;
    if (notify) { await response.body?.cancel(); if (!response.ok) throw new Error("MCP initialization failed"); return {}; }
    const envelope = await rpcResponse(response, id);
    if (envelope.error) throw new Error(`MCP request failed (${envelope.error.code ?? "unknown"})`);
    return object(envelope.result);
  }
  async #initialize() {
    await this.#send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "canva-gatekeeper", version: "0.1.0" } });
    await this.#send("notifications/initialized", {}, true);
  }
  async call(name: string, args: Data): Promise<Data> {
    validate(name, args);
    await (this.#ready ??= this.#initialize().catch(e => { this.#ready = undefined; throw e; }));
    const result = await this.#send("tools/call", { name, arguments: clean(args) });
    if (result.isError) throw new Error(`Canva tool ${name} failed`);
    let value = result.structuredContent;
    if (!value) {
      const texts = items(result.content).filter(c => c.type === "text");
      if (name === "get-assets") {
        const assets = texts.map(t => object(parseJson(string(t.text))));
        if (assets.some(x => x.error || !x.asset)) throw new Error("One or more requested Canva assets are unavailable");
        return { assets: assets.map(x => object(x.asset)) };
      }
      if (texts.length !== 1) throw new Error(`Unexpected content for ${name}`);
      const text = string(texts[0].text);
      if (name === "get-design-content") {
        // Live Canva returns flattened text; earlier research normalized it as { text }.
        try { const parsed = object(parseJson(text)); if (typeof parsed.text === "string") return { text: parsed.text }; } catch {}
        return { text };
      }
      value = parseJson(text);
    }
    const data = object(value);
    if (data.error) throw new Error(`Canva tool ${name} returned an error`);
    validate(name, data, true);
    return data;
  }
}
