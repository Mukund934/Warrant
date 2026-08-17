import { demoScenario } from "@warrant/core/fixtures";
import { DefinitionRow, Eyebrow, Label, Mono, Note, Section } from "@/components/primitives";

export const metadata = { title: "Technical notes" };

const REQUIREMENTS = [
  {
    id: "R1",
    title: "Recursive attenuation",
    asks: "Authority delegable through multiple hops, each narrowing the last, verifiable from the conveyed data alone.",
    state: "implemented" as const,
    detail:
      "Scope narrowing is a partial order over actions, audience, counterparties, money and time. The gate evaluates against the intersection of every hop, and a widening hop is reported rather than silently absorbed.",
  },
  {
    id: "R2",
    title: "Cross-organisational verification",
    asks: "A relying party verifies authority against another organisation's trust anchor, without a bilateral agreement.",
    state: "partial" as const,
    detail:
      "The verifier accepts externally supplied keys and never contacts the issuer. There is no trust-anchor discovery, no federation and no key rotation story, so the second organisation still has to obtain the keys by some other means.",
  },
  {
    id: "R3",
    title: "No runtime callback",
    asks: "Decisions reachable from conveyed authority plus locally cached trust and revocation material.",
    state: "implemented" as const,
    detail:
      "Verification uses only the pack, the supplied keys and the signed revocation snapshot. The command-line verifier disables network access before it begins.",
  },
  {
    id: "R4",
    title: "Proof of possession",
    asks: "Confirm the presenter controls the key the authority is bound to, so a credential cannot simply be replayed by whoever holds a copy.",
    state: "implemented" as const,
    detail:
      "The agent signs its own action request. The gate requires that signature to verify and requires its key to be the subject key of the presenting mandate. Presenting a genuine mandate you did not receive fails.",
  },
  {
    id: "R5",
    title: "Principal binding and invariance",
    asks: "The on-behalf-of principal travels the chain and intermediaries cannot alter it.",
    state: "implemented" as const,
    detail:
      "The liable principal is copied from parent to child at issuance, checked for invariance across the chain at evaluation, and covered by every signature.",
  },
  {
    id: "R6",
    title: "Dual-axis authorisation",
    asks: "Decisions depend on the agent's authority and the principal's own entitlements together.",
    state: "not built" as const,
    detail:
      "Only the agent's delegated authority is evaluated. Whether the principal was still entitled to grant it — whether Priya still ran finance on the day — is not checked against any directory.",
  },
  {
    id: "R7",
    title: "Authentic, bounded-staleness revocation",
    asks: "Revocation verifiable offline, with explicit staleness bounds and fail-safe behaviour.",
    state: "partial" as const,
    detail:
      "The revocation snapshot is signed and carries the moment it was published, and every verification states that bound in plain words. No maximum acceptable staleness is enforced, and there is no fail-safe when a snapshot is too old.",
  },
  {
    id: "R8",
    title: "Tamper-evident, composable audit",
    asks: "Records resistant to undetectable alteration, composable into end-to-end provenance.",
    state: "partial" as const,
    detail:
      "Ledger entries are hash-chained and the head is signed, so a third party cannot edit them undetected. There is no external anchoring, so it does not stop the issuing organisation rewriting its own history from the first entry, and segments from different organisations do not compose.",
  },
  {
    id: "R9",
    title: "Format and transport agnosticism",
    asks: "Work with existing agent identity mechanisms rather than presupposing one new transport.",
    state: "not built" as const,
    detail:
      "This is one format over one transport. There are no adapters for SPIFFE, OAuth token exchange, Entra Agent ID or MCP, which is where a real implementation would have to meet agents where they already run.",
  },
  {
    id: "R10",
    title: "Execution-time human authorisation",
    asks: "Evidence of human approval at execution, bound to a specific action and verifiable offline.",
    state: "partial" as const,
    detail:
      "The gate can answer ESCALATE and records the threshold that triggered it. It does not yet produce a signed human-approval artifact bound to the action, which is what would make the approval itself verifiable later.",
  },
];

const ENDPOINTS = [
  ["GET", "/health", "Reports that the service runs without a database"],
  ["GET", "/v1/trust-roots", "The published public keys, private halves never leave the fixtures"],
  ["GET", "/v1/scenarios", "The eight fixed demonstration scenarios"],
  ["GET", "/v1/evidence/:id", "An evidence pack, whether fixture or one you just produced"],
  ["POST", "/v1/verify", "Server-side verification, the same code the CLI and the browser run"],
  ["POST", "/v1/mandates", "Issue a root mandate under the demonstration principal"],
  ["POST", "/v1/mandates/:id/delegations", "Delegate; refuses with 422 and names the violation if it widens"],
  ["POST", "/v1/mandates/:id/revocation", "Withdraw a mandate"],
  ["POST", "/v1/actions", "Run an action through the gate and record the evidence"],
];

const STATE_STYLE = {
  implemented: "border-pass/45 bg-pass/[0.08] text-pass",
  partial: "border-warn/45 bg-warn/[0.08] text-warn",
  "not built": "border-line bg-ink-raised text-text-faint",
};

const PROTOTYPE_VS_PRODUCTION = [
  {
    area: "Signing keys",
    prototype: "Demonstration keypairs committed to the repository. Anyone can issue mandates under them.",
    production: "Per-tenant keys in an HSM or KMS, rotated, with the private half never leaving it.",
  },
  {
    area: "Storage",
    prototype: "None. Scenarios are recomputed on each cold start and agents hold their own mandates.",
    production: "Postgres as the system of record, object storage for record blobs, an analytics store for decision volume.",
  },
  {
    area: "Replay protection",
    prototype: "Nonce novelty is an input to the gate, tested in the suite but not shared between server instances.",
    production: "A shared store with a bounded acceptance window and idempotency keys per action.",
  },
  {
    area: "Ledger anchoring",
    prototype: "Hash chain with a signed head. Tamper-evident against third parties only.",
    production: "Merkle batching with roots published to an external transparency log on an interval.",
  },
  {
    area: "Trust distribution",
    prototype: "Keys are downloadable from this site and embedded in packs for convenience.",
    production: "Published key sets with rotation, discovery, and a revocation path for the keys themselves.",
  },
  {
    area: "Authentication",
    prototype: "None. Every page is public and every scenario is fixed.",
    production: "Tenant isolation, an authenticated console, scoped API credentials, rate limits.",
  },
];

function StateBadge({ state }: { state: keyof typeof STATE_STYLE }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium ${STATE_STYLE[state]}`}
    >
      {state}
    </span>
  );
}

export default async function TechnicalPage() {
  const scenario = (await demoScenario("authorised-payment"))!;

  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-12 max-w-3xl">
        <Eyebrow>Technical notes</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          What is actually implemented, and where it stops
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          Written for someone who intends to check rather than take it on trust. Every gap below is
          one we found ourselves; the point of listing them is that a reviewer should not have to.
        </p>
      </header>

      <div className="space-y-14">
        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Cryptography and formats</h2>
          <dl className="rounded-lg border border-line bg-surface px-5 py-2">
            <DefinitionRow term="Signatures">
              ECDSA on NIST P-256 with SHA-256 (ES256, RFC 7518), through the{" "}
              <Mono>jose</Mono> library over Web Crypto. No primitive is implemented here.
            </DefinitionRow>
            <DefinitionRow term="Signature envelope">
              Detached compact JWS (RFC 7515, Appendix F). The protected header carries the algorithm,
              the key identifier and the issue time, so all three are covered by the signature rather
              than sitting beside it.
            </DefinitionRow>
            <DefinitionRow term="Canonicalisation">
              JSON Canonicalization Scheme (RFC 8785): keys sorted by UTF-16 code unit at every depth,
              no insignificant whitespace, ECMAScript number serialisation. Implemented directly and
              tested, because the obvious implementation — rebuilding the object with sorted keys —
              is wrong. JavaScript hoists integer-like keys to the front of an object, so the sorted
              order is silently discarded.
            </DefinitionRow>
            <DefinitionRow term="Digests">
              SHA-256 over the canonical bytes, rendered as <Mono>sha256:base64url</Mono>.
            </DefinitionRow>
            <DefinitionRow term="Money">
              Integer minor units with an explicit currency. No floating point anywhere near a limit
              comparison, and cross-currency delegation is rejected rather than converted.
            </DefinitionRow>
            <DefinitionRow term="Schema validation">
              Zod at every trust boundary. Validation checks shape only — signatures are always
              verified against the original parsed JSON, never against the validator&rsquo;s output,
              because a validator that strips unknown fields would change the bytes that were signed.
            </DefinitionRow>
          </dl>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Architecture</h2>
          <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            Issuing a mandate, delegating it, running the gate and sealing evidence are all
            server-side, in an Express service. Verification is deliberately not: a relying party has
            to be able to check evidence on their own machine, so the same verification code runs in
            the service, in the command-line tool and in your browser.
          </p>
          <pre className="mb-5 overflow-x-auto rounded-lg border border-line bg-ink-raised px-5 py-4 font-mono text-[12.5px] leading-relaxed text-text-muted">
{`apps/web        Next.js  ─┐
                          ├─►  apps/api    Express + TypeScript
packages/verifier  CLI  ──┤         │
                          │         ▼
your browser  ────────────┘   packages/core   mandates · scope algebra · gate · evidence
                                    │
                                    ▼
                              repositories    in-memory today, Postgres later`}
          </pre>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[40rem] border-collapse bg-surface text-left">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-[0.1em] text-text-faint">
                  <th className="px-4 py-2.5 font-medium">Method</th>
                  <th className="px-4 py-2.5 font-medium">Path</th>
                  <th className="px-4 py-2.5 font-medium">What it does</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map(([method, path, purpose]) => (
                  <tr key={path} className="border-b border-line align-top last:border-b-0">
                    <td className="px-4 py-2.5">
                      <Mono className="text-seal">{method}</Mono>
                    </td>
                    <td className="px-4 py-2.5">
                      <Mono>{path}</Mono>
                    </td>
                    <td className="px-4 py-2.5 text-[12.5px] leading-relaxed text-text-muted">
                      {purpose}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5">
            <Label>Persistence is a seam, not a dependency</Label>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-text-muted">
              There is no database. State sits behind four small interfaces —{" "}
              <Mono>MandateRepository</Mono>, <Mono>EvidenceRepository</Mono>,{" "}
              <Mono>LedgerRepository</Mono> and <Mono>NonceStore</Mono> — with in-memory
              implementations. Each maps to one table when Postgres arrives, and none of the
              authority model depends on which implementation is behind it. A fresh clone runs with
              no credentials, no provisioning and no environment variables.
            </p>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-[19px] font-semibold tracking-tight">
            Measured against the IETF requirements
          </h2>
          <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            The WIMSE working group has an individual Internet-Draft setting out what cross-organisational
            agent delegation has to satisfy, as ten requirements. It is a problem statement: it states
            explicitly that it proposes no mechanism, credential format or token construction. That
            makes it a fair scorecard for an implementation that claims to be in this space.
          </p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[52rem] border-collapse bg-surface text-left">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-[0.1em] text-text-faint">
                  <th className="px-4 py-2.5 font-medium">Req</th>
                  <th className="px-4 py-2.5 font-medium">What it asks for</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 font-medium">Where this implementation stands</th>
                </tr>
              </thead>
              <tbody>
                {REQUIREMENTS.map((requirement) => (
                  <tr key={requirement.id} className="border-b border-line align-top last:border-b-0">
                    <td className="px-4 py-3">
                      <span className="font-mono text-[12.5px] text-seal">{requirement.id}</span>
                      <p className="mt-0.5 text-[12.5px] text-text">{requirement.title}</p>
                    </td>
                    <td className="max-w-[18rem] px-4 py-3 text-[12.5px] leading-relaxed text-text-faint">
                      {requirement.asks}
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge state={requirement.state} />
                    </td>
                    <td className="max-w-[24rem] px-4 py-3 text-[12.5px] leading-relaxed text-text-muted">
                      {requirement.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-text-faint">
            Source: draft-reece-wimse-cross-org-delegation-01, 30 July 2026, individual submission to
            the WIMSE working group, intended status Informational. Checked against the IETF
            datatracker on 12 August 2026. Four requirements met, four partly met, two not attempted.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">The check catalogue</h2>
          <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            These are the identifiers the gate emits, taken from a live decision. The verifier splits
            them in two: some answer &ldquo;is this evidence genuine?&rdquo; and decide whether a pack
            is valid; the rest answer &ldquo;why did the gate say that?&rdquo; and are findings, not
            faults. A pack recording a blocked action is perfectly good evidence.
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <ul className="divide-y divide-line">
              {scenario.decision.checks.map((check) => (
                <li key={check.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:gap-6">
                  <Mono className="w-52 shrink-0 text-seal">{check.id}</Mono>
                  <span className="text-[13px] text-text-muted">{check.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">This deployment against production</h2>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[46rem] border-collapse bg-surface text-left">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-[0.1em] text-text-faint">
                  <th className="px-4 py-2.5 font-medium">Area</th>
                  <th className="px-4 py-2.5 font-medium">What this demonstrator does</th>
                  <th className="px-4 py-2.5 font-medium">What production would need</th>
                </tr>
              </thead>
              <tbody>
                {PROTOTYPE_VS_PRODUCTION.map((row) => (
                  <tr key={row.area} className="border-b border-line align-top last:border-b-0">
                    <td className="px-4 py-3 text-[13px] text-text">{row.area}</td>
                    <td className="max-w-[22rem] px-4 py-3 text-[12.5px] leading-relaxed text-text-muted">
                      {row.prototype}
                    </td>
                    <td className="max-w-[22rem] px-4 py-3 text-[12.5px] leading-relaxed text-text-faint">
                      {row.production}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Run it yourself</h2>
          <Note tone="caution">
            A browser is not an air gap. To check the offline claim properly, run the command-line
            verifier: it replaces <Mono>fetch</Mono> with a function that throws before verification
            starts, so any attempt to reach the network would crash rather than succeed quietly.
          </Note>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-ink-raised px-5 py-4 font-mono text-[12.5px] leading-relaxed text-text-muted">
{`git clone https://github.com/Mukund934/Warrant
cd Warrant && npm install

npm test                    # 107 tests: scope algebra, gate, tampering, forgery, API
npm run export:packs        # writes every scenario to evidence/

node packages/verifier/dist/cli.js \\
  evidence/authorised-payment.json \\
  --trust-roots evidence/trust-roots.json

node scripts/tamper.mjs evidence/authorised-payment.json \\
  request.amount.minor 420000000

node packages/verifier/dist/cli.js \\
  evidence/authorised-payment.tampered.json \\
  --trust-roots evidence/trust-roots.json`}
          </pre>
          <p className="mt-3 text-[13px] leading-relaxed text-text-muted">
            The first verification exits 0. The second exits 1 and names four independent checks that
            caught the edit: the pack fingerprint, the pack signature, the binding between the recorded
            decision and the request, and the re-evaluated verdict.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">What the tests cover</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                file: "canonical.test.ts",
                covers:
                  "Key ordering at every depth, control characters against digits, digest stability across insertion order, refusal of non-finite numbers.",
              },
              {
                file: "scope.test.ts",
                covers:
                  "Inheritance of unstated fields, every widening case, rate-based comparison of periodic budgets, currency changes, the lattice meet.",
              },
              {
                file: "mandate.test.ts",
                covers:
                  "Issuance and signature verification, refusal to issue an escalating delegation, depth limits, windows that outlive the parent, delegation by a non-holder.",
              },
              {
                file: "gate.test.ts",
                covers:
                  "Every scenario reaches its expected verdict and fails at the expected check; replay, periodic budget exhaustion, escalation thresholds.",
              },
              {
                file: "verify.test.ts",
                covers:
                  "Untouched packs verify; amounts, limits, verdicts, check results, ledger entries and revocation entries are each caught when edited.",
              },
              {
                file: "adversarial.test.ts",
                covers:
                  "Chain splicing, dropped hops, role confusion on the gate key, editing an actor to match a mandate, and a pack forged end to end under attacker-controlled keys.",
              },
            ].map((entry) => (
              <div key={entry.file} className="rounded-lg border border-line bg-surface px-4 py-3.5">
                <Mono className="text-seal">{entry.file}</Mono>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{entry.covers}</p>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <Label>The one worth reading</Label>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-text-muted">
              In <Mono>adversarial.test.ts</Mono>, a complete pack is forged: attacker-generated keys,
              an attacker-issued mandate naming the same person, an attacker-signed decision, and the
              attacker&rsquo;s own keys embedded as the trust roots. Verified against the keys inside
              it, that pack passes — and the verifier says so, with a warning, rather than showing a
              green tick. Verified against the real organisation&rsquo;s published keys, it fails
              immediately. That gap is the entire argument for why evidence has to be checkable from
              outside.
            </p>
          </div>
        </section>
      </div>
    </Section>
  );
}
