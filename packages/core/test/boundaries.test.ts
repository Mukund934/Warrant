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

interface Lockfile {
  packages: Record<string, { dependencies?: Record<string, string> }>;
}

const LOCKFILE = JSON.parse(
  await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
) as Lockfile;

// A workspace sibling is a directory in this repository, not an installed package.
const WORKSPACES: Record<string, string> = {
  "@warrant/core": "packages/core",
  "@warrant/verifier": "packages/verifier",
};

/** npm's own resolution: the nearest `node_modules`, then upwards to the root. */
function resolveFrom(from: string, dependency: string): string | undefined {
  const segments = from === "" ? [] : from.split("/");
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join("/");
    const candidate = `${prefix ? `${prefix}/` : ""}node_modules/${dependency}`;
    if (LOCKFILE.packages[candidate]) return candidate;
  }
  return undefined;
}

/**
 * Declaring no provider is necessary and not sufficient.
 *
 * A package pulled in by something else is still installed, still resolvable, and still one
 * `import` away from the verification path — and `package.json` would say nothing about it. This
 * walks the lockfile instead, from each sealed package through every dependency it can reach.
 */
describe.each(SEALED)("packages/%s reaches no provider transitively", (name) => {
  it("resolves a real graph rather than reporting an empty one", () => {
    expect(LOCKFILE.packages[`packages/${name}`]).toBeDefined();
    expect(Object.keys(LOCKFILE.packages).length).toBeGreaterThan(50);
  });

  it("pulls in nothing that is a model provider", () => {
    const seen = new Set<string>();
    const queue = [`packages/${name}`];
    const reached: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);

      for (const dependency of Object.keys(LOCKFILE.packages[current]?.dependencies ?? {})) {
        reached.push(dependency);
        const next = WORKSPACES[dependency] ?? resolveFrom(current, dependency);
        if (next) queue.push(next);
      }
    }

    // The walk must find something, or "no provider" would hold because nothing was checked.
    expect(reached).toContain("jose");

    const offenders = reached.filter((dependency) =>
      PROVIDERS.some((provider) => dependency.includes(provider)),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * The strongest available form of the §13a outage invariant: not "the verifier does not import a
 * provider" but "there is no provider package here to import". Gemini is reached over its REST API
 * with `fetch`, from one file in the application, so this holds for the whole tree.
 */
describe("no provider package is installed anywhere in the workspace", () => {
  it("has none in the lockfile", () => {
    const marker = "node_modules/";
    const installed = Object.keys(LOCKFILE.packages)
      .filter((key) => key.includes(marker))
      .map((key) => key.slice(key.lastIndexOf(marker) + marker.length));

    expect(installed.length).toBeGreaterThan(50);

    const offenders = installed.filter((dependency) =>
      PROVIDERS.some((provider) => dependency.includes(provider)),
    );
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
