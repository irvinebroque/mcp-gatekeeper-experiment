import type { Store } from "./engine/types";

/** JSON-only engine storage, chunked below the KV per-value limit. OAuth stubs use native KV. */
export class JsonStore implements Store {
  #kv: Store;
  constructor(kv: Store) {
    this.#kv = kv;
  }
  get<T>(key: string): T | undefined {
    const manifest = this.#kv.get<{ id: string; parts: number }>("engine:" + key);
    if (!manifest) return undefined;
    let json = "";
    for (let i = 0; i < manifest.parts; i++) {
      const value = this.#kv.get<string>(`chunk:${manifest.id}:${i}`);
      if (value === undefined) throw new Error("Incomplete stored record");
      json += value;
    }
    return JSON.parse(json);
  }
  put<T>(key: string, value: T): void {
    const json = JSON.stringify(value),
      id = crypto.randomUUID(),
      size = 16_000;
    if (json.length > 12 * 1024 * 1024) throw new Error("Stored record is too large");
    const parts = Math.ceil(json.length / size);
    // Calls are synchronous: the DO output gate commits this write batch atomically.
    const old = this.#kv.get<{ id: string; parts: number }>("engine:" + key);
    for (let i = 0; i < parts; i++)
      this.#kv.put(`chunk:${id}:${i}`, json.slice(i * size, (i + 1) * size));
    this.#kv.put("engine:" + key, { id, parts });
    if (old) for (let i = 0; i < old.parts; i++) this.#kv.delete(`chunk:${old.id}:${i}`);
  }
  delete(key: string): void {
    const old = this.#kv.get<{ id: string; parts: number }>("engine:" + key);
    this.#kv.delete("engine:" + key);
    if (old) for (let i = 0; i < old.parts; i++) this.#kv.delete(`chunk:${old.id}:${i}`);
  }
  *list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    for (const [key] of this.#kv.list({ prefix: "engine:" + prefix }))
      yield [key.slice(7), this.get<T>(key.slice(7))!];
  }
}
