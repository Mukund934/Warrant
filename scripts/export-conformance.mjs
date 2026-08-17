import { mkdir, writeFile } from "node:fs/promises";
import { CONFORMANCE_VERSION } from "@warrant/core";
import { demoScenarios, trustRoots } from "@warrant/core/fixtures";

const target = new URL("../conformance/", import.meta.url);
await mkdir(target, { recursive: true });

const scenarios = await demoScenarios();
const byId = Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario]));

const clone = (value) => JSON.parse(JSON.stringify(value));

const vectors = [];

for (const scenario of scenarios) {
  const file = `valid-${scenario.id}.json`;
  await writeFile(new URL(file, target), `${JSON.stringify(scenario.pack, null, 2)}\n`);
  vectors.push({
    name: `valid-${scenario.id}`,
    description: `A genuine pack recording ${scenario.expected}. Evidence of a refusal is still valid evidence.`,
    file,
    result: "VERIFIED",
    verdict: scenario.expected,
    ...(scenario.failsAt ? { failingChecks: [scenario.failsAt] } : {}),
  });
}

const tampers = [
  {
    name: "tampered-amount",
    description: "The payment amount was edited after signing. Digest, signature and reproduction must all catch it.",
    from: "authorised-payment",
    mutate: (pack) => {
      pack.request.amount.minor = 999_999_00;
    },
    failingChecks: ["pack.digest", "pack.signature", "request.signature"],
  },
  {
    name: "tampered-verdict",
    description: "A BLOCK was rewritten to ALLOW. The recorded decision no longer matches its signature.",
    from: "over-limit",
    mutate: (pack) => {
      pack.decision.verdict = "ALLOW";
      pack.summary.verdict = "ALLOW";
    },
    failingChecks: ["pack.digest", "pack.signature", "decision.signature"],
  },
  {
    name: "tampered-principal",
    description: "The accountable person named in the summary no longer matches the root mandate.",
    from: "authorised-payment",
    mutate: (pack) => {
      pack.authority.liablePrincipal.name = "A. Nother";
    },
    failingChecks: ["pack.digest", "pack.consistency"],
  },
  {
    name: "tampered-expiry",
    description: "A mandate's expiry was extended to cover an action it did not cover.",
    from: "expired-mandate",
    mutate: (pack) => {
      pack.authority.chain[0].expiresAt = "2027-12-31T23:59:59Z";
    },
    failingChecks: ["pack.digest", "chain.signatures"],
  },
  {
    name: "tampered-ledger-head",
    description: "The ledger head sequence was altered, breaking the hash chain it commits to.",
    from: "authorised-payment",
    mutate: (pack) => {
      pack.ledger.head.seq = 99;
    },
    failingChecks: ["pack.digest", "ledger.head"],
  },
];

for (const tamper of tampers) {
  const source = byId[tamper.from];
  if (!source) throw new Error(`unknown scenario ${tamper.from}`);
  const pack = clone(source.pack);
  tamper.mutate(pack);
  const file = `${tamper.name}.json`;
  await writeFile(new URL(file, target), `${JSON.stringify(pack, null, 2)}\n`);
  vectors.push({
    name: tamper.name,
    description: tamper.description,
    file,
    result: "INVALID",
    failingChecks: tamper.failingChecks,
  });
}

await writeFile(new URL("trust-roots.json", target), `${JSON.stringify(trustRoots, null, 2)}\n`);

const manifest = {
  version: CONFORMANCE_VERSION,
  generatedAt: "2026-08-17T00:00:00Z",
  trustRootsFile: "trust-roots.json",
  vectors,
};
await writeFile(new URL("manifest.json", target), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`wrote ${vectors.length} conformance vectors to conformance/`);
