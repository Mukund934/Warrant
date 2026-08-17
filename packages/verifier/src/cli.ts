#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runVector, verifyEvidencePack } from "@warrant/core";
import type { Check, ConformanceManifest, TrustRoot, VerificationReport } from "@warrant/core";

const USAGE = `warrant-verify - check a Warrant evidence pack without contacting anyone

  warrant-verify <pack.json> [options]
  warrant-verify conformance <directory>

  --trust-roots <file>   verify against keys you obtained yourself, rather than
                         the keys carried inside the pack
  --at <timestamp>       record an ISO-8601 time of verification
  --json                 print the machine-readable report instead
  --help                 show this message

Exit code is 0 when the pack verifies and 1 when it does not.`;

interface Options {
  packPath: string;
  trustRootsPath?: string;
  verifiedAt?: string;
  json: boolean;
}

class UsageError extends Error {}

function parseArguments(argv: string[]): Options {
  const options: Options = { packPath: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--trust-roots") {
      const value = argv[index + 1];
      if (!value) throw new UsageError("--trust-roots needs a file path");
      options.trustRootsPath = value;
      index += 1;
    } else if (argument === "--at") {
      const value = argv[index + 1];
      if (!value) throw new UsageError("--at needs an ISO-8601 timestamp");
      options.verifiedAt = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      throw new UsageError("");
    } else if (argument?.startsWith("-")) {
      throw new UsageError(`unknown option ${argument}`);
    } else if (argument) {
      if (options.packPath) throw new UsageError("only one evidence pack may be checked at a time");
      options.packPath = argument;
    }
  }
  if (!options.packPath) throw new UsageError("an evidence pack file is required");
  return options;
}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = "\u001b";
const paint = (code: string, text: string) =>
  colour ? `${ESC}[${code}m${text}${ESC}[0m` : text;
const dim = (text: string) => paint("2", text);
const bold = (text: string) => paint("1", text);
const green = (text: string) => paint("32", text);
const red = (text: string) => paint("31", text);
const yellow = (text: string) => paint("33", text);

const MARKS: Record<Check["status"], string> = {
  pass: green("PASS"),
  fail: red("FAIL"),
  warn: yellow("WARN"),
  skip: dim("SKIP"),
};

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    console.log(`  ${MARKS[check.status]}  ${check.title}`);
    console.log(`        ${dim(check.detail)}`);
    if (check.expected !== undefined || check.observed !== undefined) {
      console.log(`        ${dim(`expected ${check.expected ?? "-"}`)}`);
      console.log(`        ${dim(`observed ${check.observed ?? "-"}`)}`);
    }
  }
}

function printReport(report: VerificationReport, packPath: string): void {
  console.log("");
  console.log(bold("  Warrant evidence verification"));
  console.log(`  ${dim(`${report.verifier} · ${packPath}`)}`);
  console.log(`  ${dim("network access was disabled for this run")}`);
  console.log("");

  if (report.summary) {
    console.log(`  ${report.summary.headline}`);
    console.log(`  ${dim(`authorised by  ${report.summary.authorisedBy}`)}`);
    console.log(`  ${dim(`performed by   ${report.summary.performedBy}`)}`);
    console.log(`  ${dim(`gate verdict   ${report.summary.verdict} at ${report.summary.occurredAt}`)}`);
    console.log(`  ${dim(`fingerprint    ${report.summary.packDigest}`)}`);
    console.log("");
  }

  console.log(bold("  Is this evidence genuine?"));
  printChecks(report.checks);
  console.log("");

  if (report.authority) {
    if (report.authority.reproduced) {
      console.log(bold(`  Why did the gate answer ${report.authority.verdict}?`));
    } else {
      console.log(
        bold(
          `  This pack records ${report.authority.verdict}, but the same evidence re-evaluated here does not support it`,
        ),
      );
    }
    console.log(`  ${dim(report.authority.reason)}`);
    printChecks(report.authority.checks);
    console.log("");
  }

  if (report.limitations.length > 0) {
    console.log(bold("  What this check does not establish"));
    for (const limitation of report.limitations) {
      console.log(`  ${dim(`- ${limitation}`)}`);
    }
    console.log("");
  }

  const verdict =
    report.result === "VERIFIED"
      ? green(`  ${bold("VERIFIED")}  this pack is intact and its verdict was reproduced independently`)
      : red(`  ${bold("INVALID")}  this pack does not hold up`);
  console.log(verdict);
  console.log("");
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) console.error(`warrant-verify: ${error.message}\n`);
      console.error(USAGE);
      return error.message ? 2 : 0;
    }
    throw error;
  }

  let pack: unknown;
  try {
    pack = JSON.parse(await readFile(options.packPath, "utf8"));
  } catch (error) {
    console.error(`warrant-verify: cannot read ${options.packPath}: ${(error as Error).message}`);
    return 2;
  }

  let trustRoots: TrustRoot[] | undefined;
  if (options.trustRootsPath) {
    try {
      const loaded: unknown = JSON.parse(await readFile(options.trustRootsPath, "utf8"));
      trustRoots = Array.isArray(loaded) ? (loaded as TrustRoot[]) : (loaded as { trustRoots: TrustRoot[] }).trustRoots;
      if (!Array.isArray(trustRoots)) throw new Error("expected an array of trust roots");
    } catch (error) {
      console.error(
        `warrant-verify: cannot read ${options.trustRootsPath}: ${(error as Error).message}`,
      );
      return 2;
    }
  }

  const unreachable = () => {
    throw new Error("warrant-verify performs no network access");
  };
  Object.defineProperty(globalThis, "fetch", { value: unreachable, configurable: true });

  const report = await verifyEvidencePack(pack, {
    ...(trustRoots ? { trustRoots } : {}),
    ...(options.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, options.packPath);
  }

  return report.result === "VERIFIED" ? 0 : 1;
}

async function conformance(directory: string): Promise<number> {
  const base = directory.endsWith("/") ? directory : `${directory}/`;
  let manifest: ConformanceManifest;
  let trustRoots: TrustRoot[];
  try {
    manifest = JSON.parse(await readFile(`${base}manifest.json`, "utf8")) as ConformanceManifest;
    trustRoots = JSON.parse(await readFile(`${base}${manifest.trustRootsFile}`, "utf8")) as TrustRoot[];
  } catch (error) {
    console.error(`warrant-verify: cannot read the conformance suite: ${(error as Error).message}`);
    return 2;
  }

  console.log("");
  console.log(bold(`  Warrant conformance suite`));
  console.log(`  ${dim(`${manifest.version} · ${manifest.vectors.length} vectors · ${directory}`)}`);
  console.log("");

  let failed = 0;
  for (const vector of manifest.vectors) {
    const pack: unknown = JSON.parse(await readFile(`${base}${vector.file}`, "utf8"));
    const outcome = await runVector(vector, pack, trustRoots, manifest.generatedAt);
    if (outcome.passed) {
      console.log(`  ${green("PASS")}  ${vector.name}`);
    } else {
      failed += 1;
      console.log(`  ${red("FAIL")}  ${vector.name}`);
      for (const reason of outcome.failures) console.log(`        ${dim(reason)}`);
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(`  ${green("all " + manifest.vectors.length + " vectors behaved as the suite declares")}`);
  } else {
    console.log(`  ${red(failed + " of " + manifest.vectors.length + " vectors did not")}`);
  }
  console.log("");
  return failed === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
process.exitCode = argv[0] === "conformance"
  ? argv[1]
    ? await conformance(argv[1])
    : (console.error("warrant-verify: conformance needs a directory"), 2)
  : await main();
