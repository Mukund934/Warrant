import { WarrantError } from "./types.js";

function serialise(value: unknown, path: string): string {
  if (value === null || value === undefined) return "null";

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialise(item, `${path}[${index}]`)).join(",")}]`;
  }

  const kind = typeof value;

  if (kind === "object") {
    const source = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      members.push(`${JSON.stringify(key)}:${serialise(entry, `${path}.${key}`)}`);
    }
    return `{${members.join(",")}}`;
  }

  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new WarrantError("canonical/non_finite_number", `non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }

  if (kind === "string" || kind === "boolean") {
    return JSON.stringify(value);
  }

  throw new WarrantError("canonical/unserialisable", `value of type ${kind} at ${path} is not serialisable`);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new WarrantError("canonical/unserialisable", "value is not JSON-serialisable");
  }
  return serialise(value, "$");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return base64url(bytes);
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return `sha256:${base64url(new Uint8Array(hashed))}`;
}

export async function digestOf(value: unknown): Promise<string> {
  return sha256(canonicalBytes(value));
}

export function withoutProof<T extends { proof?: unknown }>(value: T): Omit<T, "proof"> {
  const { proof: _proof, ...rest } = value;
  return rest;
}
