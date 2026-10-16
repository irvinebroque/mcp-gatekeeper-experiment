import fs from "node:fs/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
const { operations, definitions } = JSON.parse(
  await fs.readFile("schemas/canva-rest.json", "utf8"),
);
const ajv = new Ajv({
  code: { source: true, esm: true },
  strict: false,
  allErrors: true,
  inlineRefs: false,
});
addFormats(ajv);
for (const name of ["int32", "int64", "float", "double"])
  ajv.addFormat(name, { type: "number", validate: Number.isFinite });
// Compile shared response types once instead of inlining them for every operation.
const schemaId = "urn:canva:rest";
function sharedReferences(value) {
  if (Array.isArray(value)) return value.map(sharedReferences);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$ref" ? schemaId + child : sharedReferences(child),
    ]),
  );
}
ajv.addSchema({ $id: schemaId, definitions: sharedReferences(definitions) });
const exports = {};
for (const operation of operations) {
  for (const [suffix, schema] of [
    ["", operation.inputSchema],
    ["_output", operation.outputSchema],
  ]) {
    const name = operation.name + suffix;
    ajv.addSchema(sharedReferences(schema), name);
    exports[name] = name;
  }
}
await fs.mkdir("src/generated", { recursive: true });
const routes = Object.fromEntries(
  operations.map(({ inputSchema, outputSchema, ...route }) => [route.name, route]),
);
await fs.writeFile("src/generated/operations.json", JSON.stringify(routes, null, 2) + "\n");
let code = standaloneCode(ajv, exports);
const modules = new Map();
code = code.replace(/require\("([^"]+)"\)/g, (_, name) => {
  if (!modules.has(name)) modules.set(name, `runtime${modules.size}`);
  return modules.get(name);
});
const imports = [...modules]
  .map(([name, symbol]) => `import ${symbol} from ${JSON.stringify(name + ".js")};`)
  .join("\n");
await fs.writeFile(
  "src/generated/validators.js",
  "// Generated from the pinned Canva REST schemas. Do not hand edit.\n" + imports + "\n" + code,
);
