import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOLS } from "../src/assistant/tools.js";

/**
 * What the assistant is *able* to reach, read from its source rather than from its behaviour.
 *
 * `assistant.test.ts` proves that a hostile model achieves nothing through the tools that exist.
 * This file is the other half, and it is the half that survives a future change: it proves that no
 * tool which could grant, revoke, sign or record was ever wired in. A behavioural test only covers
 * the paths someone thought to script; a structural one covers the paths nobody has written yet.
 *
 * ROADMAP §13a: "Never: decide, grant, revoke, approve, sign, mutate evidence or ledger, touch
 * signing keys, appear in offline verification, or hold write access of any kind."
 */

const assistantDirectory = new URL("../src/assistant/", import.meta.url);

async function assistantSources(): Promise<{ name: string; source: string }[]> {
  const files = (await readdir(assistantDirectory)).filter((name) => name.endsWith(".ts"));
  const read = await Promise.all(
    files.map(async (name) => ({
      name: `assistant/${name}`,
      source: await readFile(new URL(name, assistantDirectory), "utf8"),
    })),
  );

  return [
    ...read,
    {
      name: "routes/assistant.ts",
      source: await readFile(new URL("../src/routes/assistant.ts", import.meta.url), "utf8"),
    },
  ];
}

const SOURCES = await assistantSources();

/** Every service export that changes something. Taken from the services, not from memory. */
const MUTATING_SERVICES = [
  "issueRoot",
  "delegate",
  "revoke",
  "submitAction",
  "submitSignedAction",
  "recordAction",
  "recordDecision",
  "resumePending",
  "parkAction",
  "takeCheckpoint",
  "registerAgent",
  "changeAgentStatus",
  "rotateAgentKey",
  "registerCapability",
  "changeCapabilityStatus",
  "setCatalogueEnforcement",
  "issueControlStatement",
];

/** Everything in core that produces a signature or a signed document. */
const SIGNING = [
  "signDetached",
  "signActionRequest",
  "signApproval",
  "signControlStatement",
  "signerFromJwk",
  "buildEvidencePack",
  "issueRootMandate",
  "delegateMandate",
  "checkpointFor",
  "evaluate",
];

/** The keyring and the recorder. Holding either would put the assistant inside the trust boundary. */
const KEY_MATERIAL = [
  "signerForKeyId",
  "principalSigner",
  "apAgentSigner",
  "recorder",
  "demoKeys",
  "privateKeyJwk",
];

/** Repository methods that write. Read methods are deliberately absent from this list. */
const WRITE_METHODS = [
  "save",
  "append",
  "register",
  "park",
  "grant",
  "withdraw",
  "rotate",
  "setStatus",
  "setEnforcement",
  "setHouseScope",
  "createOrganisation",
  "rememberAccount",
  "revoke",
  "claim",
];

const importedNames = (source: string): string[] =>
  [...source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}/g)]
    .flatMap((match) => match[1]!.split(","))
    .map((entry) => entry.replace(/\btype\b/, "").split(/\s+as\s+/)[0]!.trim())
    .filter(Boolean);

describe("the assistant cannot reach anything that writes", () => {
  it("reads at least the files it is supposed to", () => {
    expect(SOURCES.map((file) => file.name).sort()).toEqual([
      "assistant/gemini.ts",
      "assistant/provider.ts",
      "assistant/session.ts",
      "assistant/tools.ts",
      "routes/assistant.ts",
    ]);
  });

  it("imports no service that changes anything", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const name of importedNames(file.source)) {
        if (MUTATING_SERVICES.includes(name)) offenders.push(`${file.name} imports ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing that signs", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const name of importedNames(file.source)) {
        if (SIGNING.includes(name)) offenders.push(`${file.name} imports ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never names a signer or a private key", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const secret of KEY_MATERIAL) {
        // Comments are stripped first, so a file may still *explain* that it holds no keys.
        const code = file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (code.includes(secret)) offenders.push(`${file.name} mentions ${secret}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("calls no repository method that writes", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const code = file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const method of WRITE_METHODS) {
        // Only as a call on something — `repositories.evidence.save(...)`, `.append(...)`.
        if (new RegExp(`\\.${method}\\s*\\(`).test(code)) {
          offenders.push(`${file.name} calls .${method}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares every tool as read-only or proposal-only", () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(["read", "propose"]).toContain(tool.effect);
    }
  });
});

describe("the provider stays inside its own file", () => {
  it("mentions no vendor outside the provider implementation", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.name === "assistant/gemini.ts") continue;
      if (/googleapis|x-goog|generativelanguage|gemini/i.test(file.source)) {
        offenders.push(`${file.name} names the provider`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("adds no provider package to the workspace at all", async () => {
    const manifests = [
      "../../../package.json",
      "../../api/package.json",
      "../../web/package.json",
      "../../../packages/core/package.json",
      "../../../packages/verifier/package.json",
    ];

    const forbidden = ["@google/generative-ai", "@google/genai", "openai", "@anthropic-ai/sdk", "langchain"];
    const offenders: string[] = [];

    for (const relative of manifests) {
      const manifest = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of declared) {
        if (forbidden.some((provider) => name.includes(provider))) {
          offenders.push(`${manifest.name} depends on ${name}`);
        }
      }
    }

    // Gemini is reached over its REST API with `fetch`, so the guard in `packages/core` never has to
    // argue about a package that is present but unimported.
    expect(offenders).toEqual([]);
  });

  it("reads no configuration from the environment", () => {
    // The key is passed in from `server.ts`. If the tool layer could read `process.env` it could
    // also reach `DATABASE_URL`, and a tool that can read the environment is not read-only.
    const offenders = SOURCES.filter((file) => /process\.env/.test(file.source)).map(
      (file) => file.name,
    );
    expect(offenders).toEqual([]);
  });
});

describe("the guard itself is not vacuous", () => {
  it("would notice a mutating import if one appeared", () => {
    const pretend = 'import { submitAction, digestOf } from "../services/execution.js";';
    const names = importedNames(pretend);

    expect(names).toEqual(["submitAction", "digestOf"]);
    expect(names.filter((name) => MUTATING_SERVICES.includes(name))).toEqual(["submitAction"]);
  });

  it("would notice a write call if one appeared", () => {
    const pretend = "await context.repositories.evidence.save(pack, organisationId);";
    expect(WRITE_METHODS.some((method) => new RegExp(`\\.${method}\\s*\\(`).test(pretend))).toBe(true);
  });

  it("reads real files rather than passing on an empty list", () => {
    expect(SOURCES).toHaveLength(5);
    for (const file of SOURCES) expect(file.source.length).toBeGreaterThan(200);
  });
});
