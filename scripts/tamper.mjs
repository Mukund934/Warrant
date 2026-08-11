import { readFile, writeFile } from "node:fs/promises";

const [source, path, raw, target] = process.argv.slice(2);

if (!source || !path || raw === undefined) {
  console.error(`tamper - edit one value inside an evidence pack, so the verifier can be tested

  node scripts/tamper.mjs <pack.json> <dotted.path> <json-value> [output.json]

  node scripts/tamper.mjs evidence/authorised-payment.json request.amount.minor 420000000
  node scripts/tamper.mjs evidence/over-limit.json decision.verdict '"ALLOW"'`);
  process.exit(2);
}

const pack = JSON.parse(await readFile(source, "utf8"));
const segments = path.split(".");
const last = segments.pop();

let cursor = pack;
for (const segment of segments) {
  cursor = cursor?.[segment];
  if (cursor === undefined) {
    console.error(`tamper: ${source} has no value at ${path}`);
    process.exit(2);
  }
}

const before = cursor[last];
cursor[last] = JSON.parse(raw);

const output = target ?? source.replace(/\.json$/, ".tampered.json");
await writeFile(output, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

console.log(`${path}: ${JSON.stringify(before)} -> ${raw}`);
console.log(`wrote ${output}`);
