import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, DefinitionRow, Eyebrow, Label, Mono, Note, Section } from "@/components/primitives";
import { CreateOrganisationForm } from "@/components/create-organisation-form";
import { currentViewer } from "@/lib/supabase/server";
import { apiHealth, myOrganisations } from "@/lib/warrant-api";

export const metadata = { title: "Console" };

export const dynamic = "force-dynamic";

const ROLE_NOTE: Record<string, string> = {
  owner: "may issue, delegate, revoke and change who belongs",
  admin: "may issue, delegate and revoke",
  member: "may issue and delegate within what it holds",
  auditor: "may read and simulate, and may record nothing",
};

export default async function ConsolePage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/sign-in?next=%2Fconsole");

  const [organisations, health] = await Promise.all([
    myOrganisations(viewer.accessToken),
    apiHealth(),
  ]);

  return (
    <Section width="prose" className="py-10 sm:py-14">
      <header className="mb-8">
        <Eyebrow>Console</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          Signed in as {viewer.email ?? "an identified account"}
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          This is the accountable person a mandate names. Everything issued under an organisation you
          own traces back to this identity, and appears in the evidence a counterparty verifies.
        </p>
      </header>

      <div className="space-y-10">
        <Card className="p-5">
          <Label>Session</Label>
          <dl className="mt-3">
            <DefinitionRow term="Account">
              <Mono>{viewer.id}</Mono>
            </DefinitionRow>
            {viewer.email ? <DefinitionRow term="Email">{viewer.email}</DefinitionRow> : null}
            {viewer.expiresAt ? (
              <DefinitionRow term="Session expires">
                <Mono>{viewer.expiresAt}</Mono>
              </DefinitionRow>
            ) : null}
          </dl>
          <p className="mt-4 text-[13px] leading-relaxed text-text-faint">
            The access token is never given to the browser. Pages here call the Warrant API from the
            server with a token read from your session cookie, and the API re-checks it against the
            provider&rsquo;s published key set on every request.
          </p>
        </Card>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Your organisations</h2>

          {organisations.ok ? (
            organisations.data.length > 0 ? (
              <ul className="space-y-3">
                {organisations.data.map((organisation) => (
                  <Card key={organisation.id} as="li" className="p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-[15px] font-medium">{organisation.name}</span>
                      <span className="text-[11px] uppercase tracking-[0.13em] text-seal">
                        {organisation.role}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-text-faint">
                      {ROLE_NOTE[organisation.role] ?? "role recorded"} · {organisation.jurisdiction}
                    </p>
                    <p className="mt-2">
                      <Mono>{organisation.id}</Mono>
                    </p>
                  </Card>
                ))}
              </ul>
            ) : (
              <Note>
                You do not belong to an organisation yet. Create one below — you become its owner, and
                the liable principal named in every mandate it issues.
              </Note>
            )
          ) : (
            <Note tone="caution">
              <span className="text-text">Your organisations could not be read.</span>{" "}
              {organisations.failure.message}
            </Note>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-[19px] font-semibold tracking-tight">Create an organisation</h2>
          <p className="mb-4 text-[14px] leading-relaxed text-text-muted">
            An organisation is the legal entity authority is issued under. You become its owner, and
            the accountable person recorded in its evidence.
          </p>
          <CreateOrganisationForm />
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">The service you are using</h2>
          {health.ok ? (
            <Card className="p-5">
              <dl>
                <DefinitionRow term="Persistence">{health.data.persistence}</DefinitionRow>
                <DefinitionRow term="Database reachable">
                  {health.data.databaseReachable ? "yes" : "no"}
                </DefinitionRow>
                <DefinitionRow term="Replay protection">{health.data.replayScope}</DefinitionRow>
                <DefinitionRow term="Authentication">
                  {health.data.auth}
                  {health.data.auth === "open" ? (
                    <span className="text-text-faint">
                      {" "}
                      — this deployment also accepts unauthenticated callers, deliberately, so the
                      demonstration stays open
                    </span>
                  ) : null}
                </DefinitionRow>
                <DefinitionRow term="Assistant">
                  {health.data.assistant ?? "not configured"}
                </DefinitionRow>
              </dl>
            </Card>
          ) : (
            <Note tone="caution">
              <span className="text-text">The API did not answer.</span> {health.failure.message}
            </Note>
          )}
        </section>

        <Note>
          Signing in decides who may record authority. It never decides a verdict — that is a function
          of the mandate chain and the signed evaluation inputs alone, which is why{" "}
          <Link href="/verify" className="text-seal hover:underline">
            verifying evidence
          </Link>{" "}
          needs no account at all.
        </Note>
      </div>
    </Section>
  );
}
