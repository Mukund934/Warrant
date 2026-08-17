#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assess, describeCounterparties, runVector, thumbprintOf, verifyEvidencePack } from "@warrant/core";
import type {
  Check,
  ConformanceManifest,
  EvidencePack,
  TrustRoot,
  VerificationReport,
} from "@warrant/core";

const USAGE = `warrant-verify - check a Warrant evidence pack without contacting anyone

  warrant-verify <pack.json> [options]      check a pack and reproduce its verdict
  warrant-verify inspect <pack.json>        read a pack without verifying it
  warrant-verify replay <pack.json>         re-run the authority decision, check by check
  warrant-verify inspect-key <keys.json>    read a key set: thumbprints and lifecycle
  warrant-verify conformance <directory>    run a published conformance suite

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

async function loadPack(path: string): Promise<EvidencePack | number> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as EvidencePack;
  } catch (error) {
    console.error(`warrant-verify: cannot read ${path}: ${(error as Error).message}`);
    return 2;
  }
}

async function loadKeys(path: string): Promise<TrustRoot[] | number> {
  try {
    const loaded: unknown = JSON.parse(await readFile(path, "utf8"));
    const keys = Array.isArray(loaded)
      ? (loaded as TrustRoot[])
      : ((loaded as { trustRoots?: TrustRoot[]; keys?: TrustRoot[] }).trustRoots ??
        (loaded as { keys?: TrustRoot[] }).keys);
    if (!Array.isArray(keys)) throw new Error("expected an array of keys");
    return keys;
  } catch (error) {
    console.error(`warrant-verify: cannot read ${path}: ${(error as Error).message}`);
    return 2;
  }
}

async function inspect(path: string): Promise<number> {
  const pack = await loadPack(path);
  if (typeof pack === "number") return pack;

  console.log("");
  console.log(bold("  Warrant evidence pack"));
  console.log(`  ${dim(`${pack.version} · ${path}`)}`);
  console.log(`  ${dim("this is a reader, not a check — nothing below has been verified")}`);
  console.log("");
  console.log(`  ${pack.summary.headline}`);
  console.log(`  ${dim(`organisation   ${pack.organisation.name}`)}`);
  console.log(
    `  ${dim(`accountable    ${pack.authority.liablePrincipal.name}, ${pack.authority.liablePrincipal.role}`)}`,
  );
  console.log(`  ${dim(`generated      ${pack.generatedAt}`)}`);
  console.log("");

  const hops = pack.authority.chain.length;
  console.log(bold(`  Authority chain — ${hops} hop${hops === 1 ? "" : "s"}`));
  for (const mandate of pack.authority.chain) {
    console.log(`  ${dim(`depth ${mandate.depth}`)}  ${mandate.issuer.name} → ${mandate.subject.name}`);
    console.log(`         ${dim(`${mandate.id} · valid ${mandate.notBefore} to ${mandate.expiresAt}`)}`);
    console.log(`         ${dim(`signed by ${mandate.proof.verificationMethod}`)}`);
  }
  console.log("");

  const scope = pack.authority.effectiveScope;
  console.log(bold("  Effective scope, once every hop is intersected"));
  console.log(`  ${dim(`actions        ${scope.actions.join(", ") || "none"}`)}`);
  console.log(`  ${dim(`audience       ${scope.audience.join(", ") || "none"}`)}`);
  console.log(`  ${dim(`counterparties ${describeCounterparties(scope) || "none"}`)}`);
  if (scope.limits.perAction) {
    console.log(
      `  ${dim(`per action     ${scope.limits.perAction.currency} ${scope.limits.perAction.minor}`)}`,
    );
  }
  console.log("");

  console.log(bold("  Decision"));
  console.log(`  ${dim(`verdict        ${pack.decision.verdict}`)}`);
  console.log(`  ${dim(`evaluated      ${pack.decision.evaluatedAt} by ${pack.decision.gate.id}`)}`);
  console.log(`  ${dim(`checks         ${pack.decision.checks.length} recorded`)}`);
  console.log(
    `  ${dim(`ledger         ${pack.ledger.entries.length} entries, head at sequence ${pack.ledger.head.seq}`)}`,
  );
  console.log("");
  console.log(`  ${dim("run without a subcommand to verify this pack rather than read it")}`);
  console.log("");
  return 0;
}

async function replay(path: string, trustRootsPath?: string): Promise<number> {
  const pack = await loadPack(path);
  if (typeof pack === "number") return pack;

  let trustRoots: TrustRoot[] = pack.trustRoots;
  if (trustRootsPath) {
    const loaded = await loadKeys(trustRootsPath);
    if (typeof loaded === "number") return loaded;
    trustRoots = loaded;
  }

  const assessment = await assess(pack.request, pack.authority.chain, {
    trustRoots,
    revocation: pack.revocation,
    inputs: pack.decision.inputs,
  });

  const inputs = pack.decision.inputs;
  console.log("");
  console.log(bold("  Replaying the authority decision"));
  console.log(`  ${dim(`${path} · using the inputs recorded inside the signed decision`)}`);
  console.log("");
  console.log(bold("  What the gate decided on"));
  console.log(`  ${dim(`evaluated at   ${inputs.evaluatedAt}`)}`);
  console.log(`  ${dim(`replay status  ${inputs.replayStatus}`)}`);
  if (inputs.freshness) {
    console.log(
      `  ${dim(`freshness      max age ${inputs.freshness.maxAgeSeconds}s, skew ${inputs.freshness.clockSkewSeconds}s`)}`,
    );
  }
  if (inputs.priorSpend) {
    console.log(`  ${dim(`prior spend    ${inputs.priorSpend.currency} ${inputs.priorSpend.minor}`)}`);
  }
  console.log("");
  printChecks(assessment.checks);
  console.log("");

  const matches = assessment.verdict === pack.decision.verdict;
  if (matches) {
    console.log(`  ${green(assessment.verdict)}  ${dim("same verdict as the signed decision")}`);
    console.log(`  ${dim(assessment.reason)}`);
  } else {
    console.log(
      `  ${red(assessment.verdict)}  ${dim(`the pack records ${pack.decision.verdict}, replaying gives ${assessment.verdict}`)}`,
    );
  }
  console.log("");
  return matches ? 0 : 1;
}

async function inspectKey(path: string): Promise<number> {
  const keys = await loadKeys(path);
  if (typeof keys === "number") return keys;

  let leaked = false;
  console.log("");
  console.log(bold(`  ${keys.length} key${keys.length === 1 ? "" : "s"}`));
  console.log(`  ${dim(path)}`);
  console.log("");

  for (const root of keys) {
    const jwk = (root.publicKeyJwk ?? (root as unknown)) as { x?: string; y?: string; d?: string };
    let thumbprint: string;
    try {
      thumbprint = await thumbprintOf(jwk as never);
    } catch {
      thumbprint = "not a P-256 public key";
    }

    console.log(`  ${bold(root.keyId ?? "unnamed key")}`);
    console.log(`    ${dim(`subject      ${root.subject ?? "not stated"}`)}`);
    console.log(`    ${dim(`role         ${root.role ?? "not stated"}`)}`);
    console.log(`    ${dim(`thumbprint   ${thumbprint}`)}`);
    console.log(`    ${dim(`status       ${root.status ?? "no lifecycle declared"}`)}`);
    if (root.signingFrom) console.log(`    ${dim(`signs from   ${root.signingFrom}`)}`);
    if (root.signingUntil) console.log(`    ${dim(`signs until  ${root.signingUntil}`)}`);
    if (root.acceptUntil) console.log(`    ${dim(`accept until ${root.acceptUntil}`)}`);
    if (jwk.d) {
      leaked = true;
      console.log(`    ${red("PRIVATE KEY MATERIAL — this file must never be published")}`);
    }
    console.log("");
  }

  if (leaked) {
    console.log(`  ${red("this key set contains private key material")}`);
    console.log("");
  }
  return leaked ? 1 : 0;
}

const argv = process.argv.slice(2);
const COMMANDS: Record<string, (target: string, rootsPath?: string) => Promise<number>> = {
  conformance: (target) => conformance(target),
  inspect: (target) => inspect(target),
  "inspect-key": (target) => inspectKey(target),
  replay: (target, rootsPath) => replay(target, rootsPath),
};

const [command, target] = argv;
const handler = command ? COMMANDS[command] : undefined;

if (!handler) {
  process.exitCode = await main();
} else if (!target || target.startsWith("-")) {
  console.error(`warrant-verify: ${command} needs a file path`);
  process.exitCode = 2;
} else {
  const flag = argv.indexOf("--trust-roots");
  process.exitCode = await handler(target, flag === -1 ? undefined : argv[flag + 1]);
}
