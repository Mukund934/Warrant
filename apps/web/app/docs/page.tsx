import Link from "next/link";
import { Eyebrow, Mono, Note, Section } from "@/components/primitives";

export const metadata = { title: "Documentation" };

const PACK_PARTS = [
  ["authority.chain", "Every mandate from the root down to the one the agent presented, each signed by the party that issued it."],
  ["request", "What the agent asked to do, signed by the agent's own key."],
  ["decision", "The verdict, the reason, every check the gate ran, and the inputs it used — all signed by the gate."],
  ["ledger", "The hash-chained entries covering this action, with a signed head."],
  ["revocation", "A signed snapshot of what was revoked, and the moment it was published."],
  ["trustRoots", "The public keys the pack was produced under. Useful for inspection, not sufficient for trust."],
];

const VERDICTS = [
  ["ALLOW", "The action was inside the authority delegated to the agent."],
  ["BLOCK", "It was not. The pack records why, and remains valid evidence."],
  ["ESCALATE", "Authority was sufficient but a human approval threshold was crossed."],
];

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-ink-raised px-4 py-3 text-[12.5px] leading-relaxed text-text-muted">
      <code>{children}</code>
    </pre>
  );
}

export default function DocsPage() {
  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-10 max-w-3xl">
        <Eyebrow>Documentation</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          Verifying evidence you did not produce
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          Warrant&rsquo;s claim is that a party who does not trust the issuer can reproduce an
          authority decision and reach the same verdict, offline. This page is how you do that
          yourself — with no account, no API key, and no network.
        </p>
      </header>

      <div className="max-w-3xl space-y-12">
        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">In the browser, in under a minute</h2>
          <ol className="space-y-2 text-[14.5px] leading-relaxed text-text-muted">
            <li>1. Open any <Link href="/demo" className="text-seal hover:underline">scenario</Link> and download its evidence pack as JSON.</li>
            <li>2. Go to <Link href="/verify" className="text-seal hover:underline">verify</Link> and drop the file in.</li>
            <li>3. Change a digit in the amount, or a name, and drop it in again.</li>
          </ol>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            The verification runs in your browser. Disconnect from the network first if you want to
            prove that to yourself — the page keeps working, because it has to.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">On the command line</h2>
          <p className="mb-4 text-[14.5px] leading-relaxed text-text-muted">
            The verifier is a separate program from the service that issues mandates. That separation
            is the point: issuance and verification never share a process.
          </p>
          <Code>{`git clone https://github.com/Mukund934/Warrant
cd Warrant
npm ci
npm run build:core && npm run build:verifier
npm run export:packs

node packages/verifier/dist/cli.js evidence/authorised-payment.json \\
  --trust-roots evidence/trust-roots.json`}</Code>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            Exit code is <Mono>0</Mono> when the pack verifies and <Mono>1</Mono> when it does not, so
            it drops into a pipeline unchanged. <Mono>--json</Mono> prints the machine-readable
            report; <Mono>--at</Mono> records an ISO-8601 verification time.
          </p>
          <div className="mt-5">
            <Note tone="caution">
              <strong className="text-text">Always pass <Mono>--trust-roots</Mono>.</strong> Without
              it the verifier falls back to the keys carried inside the pack, which proves the pack is
              internally consistent and nothing more. A pack forged end to end under an attacker&rsquo;s
              keys is internally consistent too. The verifier says so in its own output rather than
              letting you assume otherwise.
            </Note>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Where trust roots come from today</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            This is the honest gap in the current build. Trust roots are published at{" "}
            <Mono>/api/trust-roots</Mono> and shipped with the demonstration packs, which means a
            counterparty either fetches them from us or receives them by hand.{" "}
            <strong className="text-text">
              There is no key discovery, no JWKS endpoint and no key rotation yet.
            </strong>
          </p>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            Until that exists, cross-organisation verification works but depends on an out-of-band
            step. It is the next thing being built, and it is tracked openly rather than glossed over
            on the <Link href="/security" className="text-seal hover:underline">security page</Link>.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">What is inside a pack</h2>
          <dl className="divide-y divide-line border-y border-line">
            {PACK_PARTS.map(([key, description]) => (
              <div key={key} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,11rem)_1fr] sm:gap-4">
                <dt className="text-[13px]"><Mono>{key}</Mono></dt>
                <dd className="text-[14px] leading-relaxed text-text-muted">{description}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Reading the result</h2>
          <p className="mb-4 text-[14.5px] leading-relaxed text-text-muted">
            A report answers two different questions, and conflating them is the most common way to
            misread one.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <h3 className="text-[14.5px] font-semibold tracking-tight text-text">Is this evidence genuine?</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
                Signatures, digests, chain linkage, and whether the verdict reproduces. These decide{" "}
                <Mono>VERIFIED</Mono> or <Mono>INVALID</Mono>.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <h3 className="text-[14.5px] font-semibold tracking-tight text-text">Why did the gate say that?</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
                Scope, limits, expiry, revocation, freshness. These are findings, not faults.
              </p>
            </div>
          </div>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            So <strong className="text-text">a pack recording a blocked action is perfectly good
            evidence</strong>. A refusal that cannot be proven is worth as little as an approval that
            cannot be.
          </p>
          <dl className="mt-5 divide-y divide-line border-y border-line">
            {VERDICTS.map(([verdict, meaning]) => (
              <div key={verdict} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,7rem)_1fr] sm:gap-4">
                <dt className="text-[13px]"><Mono>{verdict}</Mono></dt>
                <dd className="text-[14px] leading-relaxed text-text-muted">{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Going further</h2>
          <ul className="space-y-2 text-[14.5px] leading-relaxed text-text-muted">
            <li>
              <Link href="/how-it-works" className="text-seal hover:underline">How it works</Link> — the
              mandate, the gate and the evidence, in order.
            </li>
            <li>
              <Link href="/technical" className="text-seal hover:underline">Technical notes</Link> — every
              check the gate emits, the formats, and the standards this does and does not follow.
            </li>
            <li>
              <Link href="/security" className="text-seal hover:underline">Security</Link> — the trust
              model and the limitations that come with it.
            </li>
          </ul>
        </section>
      </div>
    </Section>
  );
}
