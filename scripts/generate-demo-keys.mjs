import { writeFile } from "node:fs/promises";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

const parties = [
  ["principal", "Priya Sharma, Finance Head, Meridian Technologies Pvt Ltd"],
  ["agent", "AP-Agent-01, accounts payable agent"],
  ["agent", "PAY-Agent-07, payment execution agent"],
  ["agent", "SETTLE-Agent-12, settlement agent"],
  ["agent", "ROGUE-Agent-99, unregistered agent"],
  ["gate", "Warrant Gate (demonstration instance)"],
  ["ledger", "Warrant recording service (demonstration instance)"],
];

const names = [
  "principalKey",
  "apAgentKey",
  "payAgentKey",
  "settleAgentKey",
  "rogueAgentKey",
  "gateKey",
  "ledgerKey",
];

const records = [];
for (const [role, subject] of parties) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  const publicKeyJwk = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y };
  const thumbprint = await calculateJwkThumbprint(publicKeyJwk, "sha256");
  records.push({
    keyId: `key:${role}:${thumbprint.slice(0, 16)}`,
    subject,
    role,
    publicKeyJwk,
    privateKeyJwk: { ...publicKeyJwk, d: priv.d },
  });
}

const body = records
  .map(
    (record, index) =>
      `export const ${names[index]}: DemoKey = ${JSON.stringify(record, null, 2)
        .split("\n")
        .map((line, lineIndex) => (lineIndex === 0 ? line : `${line}`))
        .join("\n")};`,
  )
  .join("\n\n");

const file = `import type { KeyPairRecord } from "../keys.js";

export type DemoKey = KeyPairRecord;

${body}

export const demoKeys: DemoKey[] = [${names.join(", ")}];
`;

await writeFile(new URL("../packages/core/src/fixtures/keys.ts", import.meta.url), file, "utf8");
console.log(`wrote ${records.length} demonstration keys`);
