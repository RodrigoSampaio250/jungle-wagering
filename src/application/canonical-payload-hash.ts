import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Número inválido no JSON canônico.");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const object = value as { readonly [key: string]: JsonValue };

  const entries = Object.keys(object)
    .sort()
    .map((key) => {
      const item = object[key];

      if (item === undefined) {
        throw new Error("Valor indefinido no JSON canônico.");
      }

      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });

  return `{${entries.join(",")}}`;
}

export function canonicalPayloadHash(value: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}