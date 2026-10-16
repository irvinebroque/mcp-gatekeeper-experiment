import routes from "../generated/operations.json";
import * as validators from "../generated/validators.js";

export type OperationName = keyof typeof routes;
export interface Operation {
  method: string;
  path: string;
  classification: string;
  scopes: string[];
  pathParameters: string[];
  queryParameters: { name: string; explode: boolean }[];
  poll?: string;
}

/** Only reviewed endpoints from the pinned OpenAPI spec can be called. */
export function operationFor(name: string): Operation {
  if (!Object.hasOwn(routes, name)) throw new Error("Unreviewed REST operation");
  return routes[name as OperationName];
}

export function validateOperation(name: string, value: unknown, output = false): void {
  operationFor(name);
  const key = name + (output ? "_output" : "");
  const check = (validators as Record<string, (value: unknown) => boolean>)[key];
  if (!check || !check(value))
    throw new Error(`Invalid ${output ? "response" : "arguments"} for ${name}`);
}
