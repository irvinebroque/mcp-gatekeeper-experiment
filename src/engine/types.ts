import type { ApprovalQueue } from "../host/gatekeeper";
import type { Data } from "../json";
import type { Scope } from "../resources";

export interface Store {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}
export type Queue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction">;
export type ResourceRef = string | { action: number; kind: "folder" | "comment" | "design" };
export type Target = { kind: "design" | "folder" | "image" | "template"; id: ResourceRef };
export type Overlay =
  | { kind: "folder"; parent: ResourceRef; name: string }
  | { kind: "comment"; designId: string; text: string }
  | { kind: "reply"; commentId: ResourceRef; text: string };

export interface Action {
  id: number;
  operation: string;
  input: Data;
  targets: Target[];
  dependsOn: number[];
  state: "queued" | "applying" | "running" | "applied" | "rejected" | "unknown" | "failed";
  scope: Scope;
  overlay?: Overlay;
  result?: Data;
  nextPoll?: number;
}
