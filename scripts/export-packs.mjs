import { mkdir, writeFile } from "node:fs/promises";
import { demoScenarios, trustRoots } from "../packages/core/dist/fixtures/index.js";

const target = new URL("../evidence/", import.meta.url);
await mkdir(target, { recursive: true });

await writeFile(
  new URL("trust-roots.json", target),
  `${JSON.stringify(trustRoots, null, 2)}\n`,
  "utf8",
);

const scenarios = await demoScenarios();
for (const scenario of scenarios) {
  await writeFile(
    new URL(`${scenario.id}.json`, target),
    `${JSON.stringify(scenario.pack, null, 2)}\n`,
    "utf8",
  );
}

console.log(`wrote ${scenarios.length} evidence packs and the published trust roots to evidence/`);
