import { readFile } from "node:fs/promises";
import { verifyEvidencePack } from "@warrant/core";

const roots = JSON.parse(await readFile(new URL("../evidence/trust-roots.json", import.meta.url), "utf8"));

const cases = [
  ["authorised-payment", "request.amount.minor", 420000000, "payment amount"],
  ["over-limit", "decision.verdict", "ALLOW", "flipped verdict"],
  ["authorised-payment", "authority.liablePrincipal.name", "A. Nother", "renamed principal"],
  ["authorised-payment", "ledger.head.seq", 99, "ledger head sequence"],
  ["revoked-mandate", "revocation.asOf", "2026-08-21T00:00:00Z", "backdated revocation"],
  ["wrong-agent", "request.actor", "agent:pay-agent-07", "actor swapped to match mandate"],
  ["authorised-payment", "summary.headline", "Everything was fine", "pack summary text"],
  ["delegation-escalation", "decision.reason", "all checks passed", "decision reason"],
  ["authorised-payment", "decision.checks.0.status", "fail", "a recorded check result"],
  ["authorised-payment", "authority.chain.0.expiresAt", "2027-12-31T23:59:59Z", "mandate expiry extended"],
];

const pad = (value, width) => String(value).padEnd(width);
let allCaught = true;

for (const [scenario, path, value, label] of cases) {
  const pack = JSON.parse(
    await readFile(new URL(`../evidence/${scenario}.json`, import.meta.url), "utf8"),
  );

  const segments = path.split(".");
  const last = segments.pop();
  let cursor = pack;
  for (const segment of segments) cursor = cursor[segment];
  cursor[last] = value;

  const report = await verifyEvidencePack(pack, { trustRoots: roots, verifiedAt: "2026-08-21T09:00:00Z" });
  const caught = report.result === "INVALID";
  if (!caught) allCaught = false;

  const failed = report.checks.filter((check) => check.status === "fail").map((check) => check.id);
  console.log(
    `${pad(label, 34)} ${pad(report.result, 9)} ${failed.join(", ") || "nothing failed"}`,
  );
}

console.log(`\n${allCaught ? "every edit was caught" : "AT LEAST ONE EDIT WENT UNDETECTED"}`);
process.exitCode = allCaught ? 0 : 1;
