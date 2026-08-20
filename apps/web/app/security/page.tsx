import Link from "next/link";
import { Eyebrow, Mono, Note, Section } from "@/components/primitives";

export const metadata = { title: "Security" };

const GUARANTEES = [
  "Every mandate, request, decision, ledger head, revocation snapshot and evidence pack is signed with ES256 over an RFC 8785 canonical serialisation.",
  "Authority can only narrow. A delegation that would widen any dimension is refused at issuance, and the gate independently re-checks the whole chain at evaluation.",
  "Effective authority is the intersection of every hop, never the last one. A chain containing an illegally widened hop is still held to the narrowest value above it.",
  "An agent proves it holds the key its mandate was issued to by signing its own request. Presenting a mandate is not sufficient.",
  "Every input the gate used to decide is signed into the decision, so the verdict can be recomputed rather than read.",
  "Verification runs with no network access, in three independent places: a service, a command-line tool and the browser.",
];

const LIMITS = [
  {
    title: "The ledger is tamper-evident, not tamper-proof",
    body: "Hash chaining with a signed head detects alteration by a third party. It does not stop the issuing organisation rewriting its own history from the first entry. Detecting that needs an external transparency anchor, which is not built yet.",
  },
  {
    title: "Replay protection is process-scoped",
    body: "Nonce novelty is tracked in memory by a single process. Within that process a replayed request is refused. Across two processes it is not, and the failure is silent rather than loud. The service reports its own replay scope on its health endpoint so the guarantee is inspectable rather than assumed.",
  },
  {
    title: "Revocation is checked against a snapshot",
    body: "A verifier is offline by design and therefore cannot know whether a mandate was revoked after the snapshot it was given. Every verification report states the moment its revocation data was published.",
  },
  {
    title: "A key set still has to be fetched out of band",
    body: "Keys are published as a JWKS and carry a signing lifecycle, so retiring one never invalidates the evidence it already signed. What is missing is the pointer: no jku is written into the protected header, so a counterparty obtains the key set from a URL it was given rather than one the signature names. Keys embedded in a pack prove internal consistency only — they cannot prove the pack came from the organisation it names, and the verifier says so explicitly when it is given them.",
  },
  {
    title: "This deployment accepts unauthenticated callers, deliberately",
    body: "The API verifies ES256 access tokens against the identity provider's published key set, and a deployment declares whether it requires them — it reports which on /health. This one declares itself open so the demonstration stays reachable, which means anyone can issue mandates under the published demonstration keys. That is a stated position rather than an absence, and it is why the demonstration keys are published in the first place.",
  },
  {
    title: "The service holds the signing keys",
    body: "Each organisation gets its own principal, gate and recorder keys, and the service holds the private halves. Evidence says so rather than leaving it to be assumed: the accountable-person block records keyCustody as \"service\", and a verifier reports it. A deployment that needed the person to hold their own key would put it in an HSM and say so in the same field.",
  },
];

export default function SecurityPage() {
  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-10 max-w-3xl">
        <Eyebrow>Security</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          The trust model, and what it does not cover
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          A verification system that overstates itself is worse than no verification system, because
          somebody relies on it. This page states what is actually guaranteed, what is deliberately
          not, and how to report something we got wrong.
        </p>
      </header>

      <div className="max-w-3xl space-y-12">
        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Reporting a vulnerability</h2>
          <Note tone="caution">
            Please report privately through GitHub&rsquo;s security advisories on the{" "}
            <a
              href="https://github.com/Mukund934/Warrant/security/advisories/new"
              className="text-seal hover:underline"
              rel="noreferrer noopener"
            >
              project repository
            </a>
            , not as a public issue. A report that shows a mandate being widened, a chain being
            spliced, a signature accepted where it should not be, or a pack passing verification
            after alteration is the most useful thing anyone can send.
          </Note>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">The demonstration keys are published on purpose</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            Private keys for the demonstration identities are committed to the repository and served
            from this site. That is deliberate, and it is the single most important thing to
            understand before drawing conclusions from anything here.
          </p>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            It exists so that anyone can reproduce a scenario end to end, forge a pack under their own
            keys, and watch the verifier reject it against the real ones. The alternative — a
            demonstration you can only observe — proves nothing.{" "}
            <span className="text-text">
              No key on this site protects anything, and none of them would exist in a real
              deployment
            </span>
            , where signing would sit behind a KMS or an HSM.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">What the system actually guarantees</h2>
          <ul className="space-y-3">
            {GUARANTEES.map((item) => (
              <li key={item} className="flex gap-3 text-[14.5px] leading-relaxed text-text-muted">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-seal" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Freshness and replay</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            A correctly signed request is not indefinitely spendable. The gate compares the moment a
            request was signed against the moment it is evaluated, against an acceptance window and a
            clock-skew tolerance that are themselves signed into the decision — so a third party
            checking the evidence later applies the same window the gate did, rather than one of
            their own choosing. The demonstration uses{" "}
            <Mono>maxAgeSeconds 300</Mono> with <Mono>clockSkewSeconds 30</Mono>.
          </p>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            Whether a request nonce had been seen before is a fact only the gate holds at the moment
            it decides. It cannot be recomputed from a pack, so a verification report presents it as
            the gate&rsquo;s claim reproduced rather than as an independent finding, and says so.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Known limitations</h2>
          <div className="space-y-5">
            {LIMITS.map((limit) => (
              <div key={limit.title} className="rounded-lg border border-line bg-surface px-5 py-4">
                <h3 className="text-[14.5px] font-semibold tracking-tight text-text">{limit.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-text-muted">{limit.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Checking any of this yourself</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            None of the above has to be taken on trust. Open any{" "}
            <Link href="/demo" className="text-seal hover:underline">scenario</Link>, download its
            evidence pack, edit a number in it, and{" "}
            <Link href="/verify" className="text-seal hover:underline">run the verifier</Link> in your
            own browser with the network switched off. The{" "}
            <Link href="/technical" className="text-seal hover:underline">technical notes</Link>{" "}
            list every check the gate emits and the standards this does and does not follow, including
            the claims that did not survive checking.
          </p>
        </section>
      </div>
    </Section>
  );
}
