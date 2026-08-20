import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The two invariants in ROADMAP §3 and §13a that nothing else can enforce.
 *
 * They are architectural, so they cannot be tested by calling anything — a violation compiles, passes
 * every other test, and only shows up as a verifier that quietly needs a network, or a protocol that
 * cannot be reimplemented without this repository. These read the source instead.
 *
 * Written **before** the Warrant Assistant exists, deliberately. The moment a provider SDK is added
 * to the application, the pressure to import it "just here" arrives with it, and by then the guard is
 * an argument rather than a test.
 */

const SEALED = ["core", "verifier"] as const;

// Any of these inside the protocol packages would put an inference call on the verification path.
const PROVIDERS = [
  "@google/generative-ai",
  "@google/genai",
  "openai",
  "@anthropic-ai/sdk",
  "@mistralai",
  "cohere",
  "ollama",
  "langchain",
];

const packageDir = (name: string) => new URL(`../../${name}/`, import.meta.url);

async function sourceFiles(root: URL): Promise<URL[]> {
  const found: URL[] = [];
  const walk = async (directory: URL): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".ts")) found.push(child);
    }
  };
  await walk(new URL("src/", root));
  return found;
}

const importsIn = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);

describe.each(SEALED)("packages/%s is sealed against the application", (name) => {
  it("declares no dependency on a model provider", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", packageDir(name)), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];

    for (const provider of PROVIDERS) {
      expect(declared.filter((entry) => entry.includes(provider))).toEqual([]);
    }
  });

  it("imports no model provider anywhere in its source", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(packageDir(name))) {
      const source = await readFile(file, "utf8");
      for (const specifier of importsIn(source)) {
        if (PROVIDERS.some((provider) => specifier.includes(provider))) {
          offenders.push(`${file.pathname} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // ROADMAP §3, invariant 1. Persistence, transport and configuration are implementation details of
  // the application; a protocol package reaching into them is what makes a format unimplementable by
  // anyone else.
  it("imports nothing from apps/", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(packageDir(name))) {
      const source = await readFile(file, "utf8");
      for (const specifier of importsIn(source)) {
        if (specifier.includes("apps/") || specifier.includes("@warrant/api")) {
          offenders.push(`${file.pathname} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // `NO_COLOR` is the one exception and it is a real one: the standalone verifier is a terminal
  // program, and honouring the convention affects how output is painted, never what it concludes.
  // Anything else read from the environment would make a verdict depend on how a process was
  // launched, which is the property this guard exists to prevent.
  it("reads no environment variable that could change what it concludes", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(packageDir(name))) {
      const source = await readFile(file, "utf8");
      for (const [, variable] of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (variable !== "NO_COLOR") offenders.push(`${file.pathname} reads ${variable}`);
      }
      // Bracket access would slip past the pattern above, so it is refused outright.
      if (/process\.env\s*\[/.test(source)) offenders.push(`${file.pathname} indexes process.env`);
    }

    expect(offenders).toEqual([]);
  });
});

describe("the guard itself is not vacuous", () => {
  it("would notice a provider import if one appeared", () => {
    const pretend = 'import { GoogleGenerativeAI } from "@google/generative-ai";';
    const specifiers = importsIn(pretend);

    expect(specifiers).toEqual(["@google/generative-ai"]);
    expect(PROVIDERS.some((provider) => specifiers[0]!.includes(provider))).toBe(true);
  });

  it("would notice an environment read that is not NO_COLOR", () => {
    const pretend = 'const key = process.env.GEMINI_API_KEY;';
    const names = [...pretend.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);

    expect(names).toEqual(["GEMINI_API_KEY"]);
    expect(names.filter((name) => name !== "NO_COLOR")).toHaveLength(1);
  });

  it("actually reads files, rather than passing on an empty list", async () => {
    const files = await sourceFiles(packageDir("core"));

    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.pathname.endsWith("gate.ts"))).toBe(true);
  });
});
