/** JSON payloads whose operation-specific shapes are checked by generated validators. */
export type Data = Record<string, any>;
export const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function object(x: unknown): Data {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new Error("Unexpected Canva response shape");
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
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Canva returned malformed JSON");
  }
}

export async function boundedText(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > max) throw new Error("Canva response exceeded size limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}
