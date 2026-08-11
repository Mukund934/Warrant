"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, TrustRoot, VerificationReport, Verdict } from "@warrant/core";
import { Label, Mono } from "./primitives";
import { CheckList, VerdictBadge } from "./verdict";

interface ScenarioOption {
  id: string;
  title: string;
  expected: Verdict;
}

interface Props {
  scenarios: ScenarioOption[];
  activeScenarioId: string;
  pack: EvidencePack;
  publishedTrustRoots: TrustRoot[];
}

type TrustMode = "published" | "embedded";

function detach(pack: EvidencePack): EvidencePack {
  return JSON.parse(JSON.stringify(pack)) as EvidencePack;
}

interface Tamper {
  id: string;
  label: string;
  describe: string;
  apply: (pack: EvidencePack) => boolean;
}

const TAMPERS: Tamper[] = [
  {
    id: "amount",
    label: "Multiply the payment by ten",
    describe: "changed the amount in the request after it was signed",
    apply: (pack) => {
      if (!pack.request.amount) return false;
      pack.request.amount.minor *= 10;
      return true;
    },
  },
  {
    id: "verdict",
    label: "Flip the verdict to ALLOW",
    describe: "rewrote the gate's recorded answer",
    apply: (pack) => {
      if (pack.decision.verdict === "ALLOW") return false;
      pack.decision.verdict = "ALLOW";
      pack.summary.verdict = "ALLOW";
      return true;
    },
  },
  {
    id: "limit",
    label: "Raise the delegated limit",
    describe: "widened the last mandate in the chain",
    apply: (pack) => {
      const leaf = pack.authority.chain[pack.authority.chain.length - 1];
      if (!leaf?.scope.limits.perAction) return false;
      leaf.scope.limits.perAction.minor *= 4;
      return true;
    },
  },
  {
    id: "ledger",
    label: "Delete a ledger entry",
    describe: "removed a record from the middle of the ledger",
    apply: (pack) => {
      if (pack.ledger.entries.length < 3) return false;
      pack.ledger.entries.splice(1, 1);
      return true;
    },
  },
  {
    id: "principal",
    label: "Rename the accountable person",
    describe: "changed the name shown as answerable, leaving the mandates untouched",
    apply: (pack) => {
      pack.authority.liablePrincipal.name = "A. Nother";
      return true;
    },
  },
];

function ResultBanner({ report }: { report: VerificationReport }) {
  const verified = report.result === "VERIFIED";
  return (
    <div
      role="status"
      className={`rounded-lg border px-5 py-4 ${
        verified ? "border-pass/50 bg-pass/[0.08]" : "border-fail/50 bg-fail/[0.08]"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`text-[22px] font-semibold tracking-[0.06em] ${
            verified ? "text-pass" : "text-fail"
          }`}
        >
          {report.result}
        </span>
        <span className="text-[13px] text-text-faint">
          {verified
            ? "every signature, digest and ledger link holds, and the verdict was reproduced here"
            : "this pack does not hold up under checking"}
        </span>
      </div>
      {report.summary && (
        <p className="mt-2 text-[14px] leading-relaxed text-text">{report.summary.headline}</p>
      )}
      <p className="mt-2 text-[12.5px] text-text-faint">
        {report.verifier} · checked{" "}
        {report.trustRootSource === "independent"
          ? "against separately published keys"
          : "against the keys inside the pack"}
      </p>
    </div>
  );
}

export function VerifyConsole({ scenarios, activeScenarioId, pack, publishedTrustRoots }: Props) {
  const original = useMemo(() => pack, [pack]);
  const [working, setWorking] = useState<EvidencePack>(() => detach(pack));
  const [trustMode, setTrustMode] = useState<TrustMode>("published");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setWorking(detach(original));
    setReport(null);
    setEdits([]);
    setLoadError(null);
  }, [original]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const run = useCallback(
    async (target: EvidencePack, mode: TrustMode) => {
      setBusy(true);
      try {
        const outcome = await verifyEvidencePack(target, {
          ...(mode === "published" ? { trustRoots: publishedTrustRoots } : {}),
        });
        setReport(outcome);
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "verification could not be completed",
        );
      } finally {
        setBusy(false);
      }
    },
    [publishedTrustRoots],
  );

  const applyTamper = useCallback(
    (tamper: Tamper) => {
      const next = detach(working);
      if (!tamper.apply(next)) return;
      setWorking(next);
      setEdits((current) => [...current, tamper.describe]);
      void run(next, trustMode);
    },
    [run, trustMode, working],
  );

  const reset = useCallback(() => {
    const next = detach(original);
    setWorking(next);
    setEdits([]);
    setLoadError(null);
    void run(next, trustMode);
  }, [original, run, trustMode]);

  const onFile = useCallback(
    async (file: File) => {
      setLoadError(null);
      try {
        const parsed = JSON.parse(await file.text()) as EvidencePack;
        setWorking(parsed);
        setEdits([`loaded ${file.name}`]);
        void run(parsed, trustMode);
      } catch {
        setLoadError(`${file.name} is not valid JSON`);
      }
    },
    [run, trustMode],
  );

  const changeTrustMode = useCallback(
    (mode: TrustMode) => {
      setTrustMode(mode);
      if (report) void run(working, mode);
    },
    [report, run, working],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-8">
      <div className="space-y-5">
        <div className="rounded-lg border border-line bg-surface p-5">
          <Label>Evidence to check</Label>
          <ul className="mt-3 space-y-1.5">
            {scenarios.map((scenario) => (
              <li key={scenario.id}>
                <Link
                  href={`/verify?scenario=${scenario.id}`}
                  aria-current={scenario.id === activeScenarioId ? "true" : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors ${
                    scenario.id === activeScenarioId
                      ? "bg-seal/10 text-text"
                      : "text-text-muted hover:bg-surface-raised hover:text-text"
                  }`}
                >
                  <VerdictBadge verdict={scenario.expected} size="sm" />
                  <span className="min-w-0 flex-1">{scenario.title}</span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-line pt-4">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="w-full rounded-md border border-line bg-ink-raised px-3 py-2 text-[13px] text-text-muted transition-colors hover:border-line-strong hover:text-text"
            >
              Or open a pack file from your machine
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5">
          <Label>Which keys should be trusted</Label>
          <div className="mt-3 space-y-2">
            {(
              [
                {
                  mode: "published" as const,
                  title: "Keys published by the organisation",
                  blurb: "obtained separately, the way a counterparty would",
                },
                {
                  mode: "embedded" as const,
                  title: "Keys carried inside the pack",
                  blurb: "proves consistency, proves nothing about origin",
                },
              ]
            ).map((option) => (
              <label
                key={option.mode}
                className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                  trustMode === option.mode
                    ? "border-seal/50 bg-seal/[0.07]"
                    : "border-line bg-ink-raised hover:border-line-strong"
                }`}
              >
                <input
                  type="radio"
                  name="trust-mode"
                  checked={trustMode === option.mode}
                  onChange={() => changeTrustMode(option.mode)}
                  className="mt-1 accent-[var(--color-seal)]"
                />
                <span>
                  <span className="block text-[13px] font-medium text-text">{option.title}</span>
                  <span className="block text-[12.5px] text-text-faint">{option.blurb}</span>
                </span>
              </label>
            ))}
          </div>
          <a
            href="/api/trust-roots"
            download="trust-roots.json"
            className="mt-3 inline-block text-[12.5px] text-text-faint underline-offset-2 hover:text-text hover:underline"
          >
            Download the published keys
          </a>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5">
          <Label>Break something</Label>
          <p className="mt-2 text-[12.5px] leading-relaxed text-text-faint">
            Each of these edits the pack in memory, exactly as an attacker or a careless
            administrator would, and re-runs the check.
          </p>
          <div className="mt-3 space-y-1.5">
            {TAMPERS.map((tamper) => (
              <button
                key={tamper.id}
                type="button"
                onClick={() => applyTamper(tamper)}
                className="w-full rounded-md border border-line bg-ink-raised px-3 py-2 text-left text-[13px] text-text-muted transition-colors hover:border-fail/50 hover:text-text"
              >
                {tamper.label}
              </button>
            ))}
          </div>
          {edits.length > 0 && (
            <button
              type="button"
              onClick={reset}
              className="mt-3 w-full rounded-md border border-seal/40 bg-seal/10 px-3 py-2 text-[13px] font-medium text-seal transition-colors hover:bg-seal/15"
            >
              Restore the original pack
            </button>
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void run(working, trustMode)}
            disabled={busy}
            className="rounded-md border border-seal/55 bg-seal/15 px-5 py-2.5 text-[14px] font-semibold text-seal transition-colors hover:bg-seal/20 disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Verify this pack"}
          </button>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] ${
              online ? "border-line text-text-faint" : "border-pass/50 bg-pass/[0.08] text-pass"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${online ? "bg-text-faint" : "bg-pass"}`}
            />
            {online ? "Browser is online" : "Browser is offline — and this still works"}
          </span>
        </div>

        {edits.length > 0 && (
          <div className="rounded-lg border border-fail/40 bg-fail/[0.06] px-4 py-3">
            <Label>Changes made to this pack</Label>
            <ul className="mt-2 space-y-1 text-[13px] text-text">
              {edits.map((edit, index) => (
                <li key={`${edit}-${index}`}>— {edit}</li>
              ))}
            </ul>
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-fail/40 bg-fail/[0.06] px-4 py-3 text-[13.5px] text-fail">
            {loadError}
          </div>
        )}

        {!report && !busy && (
          <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-12 text-center">
            <p className="text-[14px] text-text-muted">
              Nothing has been checked yet. Press <span className="text-text">Verify this pack</span>{" "}
              to run every signature, digest and ledger link in this browser.
            </p>
            <p className="mt-2 text-[12.5px] text-text-faint">
              Fingerprint on file: <Mono>{working.integrity.packDigest}</Mono>
            </p>
          </div>
        )}

        {report && (
          <div className="space-y-5 reveal">
            <ResultBanner report={report} />

            <CheckList checks={report.checks} caption="Is this evidence genuine?" />

            {report.authority && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-[15px] font-semibold text-text">
                    {report.authority.reproduced
                      ? `Why the gate answered ${report.authority.verdict}`
                      : `This pack claims ${report.authority.verdict}; re-evaluating the evidence does not agree`}
                  </h3>
                </div>
                <p className="text-[13.5px] leading-relaxed text-text-muted">
                  {report.authority.reason}
                </p>
                <CheckList checks={report.authority.checks} />
              </div>
            )}

            <div className="rounded-lg border border-line bg-ink-raised px-5 py-4">
              <Label>What this check does not establish</Label>
              <ul className="mt-2.5 space-y-2 text-[13px] leading-relaxed text-text-muted">
                {report.limitations.map((limitation, index) => (
                  <li key={index}>— {limitation}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
