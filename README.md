# Warrant

[![ci](https://github.com/Mukund934/Warrant/actions/workflows/ci.yml/badge.svg)](https://github.com/Mukund934/Warrant/actions/workflows/ci.yml)

**Proof of who authorised an AI action, under what limits, and who is accountable.**

AI agents have started to take consequential actions — paying invoices, calling banking APIs, moving
money on behalf of organisations. When one of them gets it wrong, the question that decides
everything afterwards is who authorised it. The usual answer is a log file the company itself can
edit.

Warrant issues signed, scope-bound mandates that always trace back to a named legal person, checks
them at the moment an agent acts, and produces evidence a second organisation can verify **without
trusting the first**.

- **Live demonstrator** — https://warrant-web.vercel.app
- **API** — https://warrant-api-2zvu.onrender.com/health

---

## What this repository is

Production-grade **engineering**. Early-stage **company**.

The cryptography, the delegation semantics, the gate, the evidence format and the verifier are real,
tested and deployed. What does not exist is equally plain: **no customers, no revenue, no production
adoption, no certification, no regulatory approval and no independent audit.** The organisations,
people, agents and payments in the demonstration are invented, and the demonstration signing keys are
published in this repository so that every result here can be reproduced — and forged — by anyone.

There is a page in the app dedicated to separating what works from what is staged.

---

## Quick start

```bash
npm install
npm test
```

748 tests across 42 files. No database, no credentials, no environment variables — a fresh clone runs
as it stands. 59 of those tests exercise a real PostgreSQL instance and skip themselves when
`DATABASE_URL` is absent.

```bash
npm run dev           # http://localhost:3000  — demonstrator, docs, browser verifier
npm run dev:api       # http://localhost:4000  — issuance, gate, evidence
```

The eight demonstration scenarios and all verification work without the API running.

### Verify an evidence pack yourself, offline

```bash
npm run build:core && npm run build:verifier
npm run export:packs

node packages/verifier/dist/cli.js \
  evidence/authorised-payment.json \
  --trust-roots evidence/trust-roots.json
```

Exits `0`. The verifier recomputes the gate's entire evaluation from the pack and compares it against
the recorded verdict, rather than reading the verdict off the file. Now break it:

```bash
node scripts/tamper.mjs evidence/authorised-payment.json request.amount.minor 420000000

node packages/verifier/dist/cli.js \
  evidence/authorised-payment.tampered.json \
  --trust-roots evidence/trust-roots.json
```

Exits `1`, naming the independent checks that caught the edit. `scripts/tamper-sweep.mjs` runs ten
different edits across six packs; every one is caught.

### Check an implementation against the published vectors

```bash
npm run conformance
```

13 golden vectors — eight that must verify, five that must not — with the failure each is expected to
produce. They are committed, and a change that would alter a signed document shows up as a vector
that no longer matches rather than as a silent format drift.

---

## The three objects

**Mandate** — a signed record of what a named legal person granted: which actions, which
counterparties, which limits, until when. Mandates chain, and each hop may **only narrow**. Every
chain terminates in a person, identified as a person rather than as an email address. A mandate may
also record what it was issued in place of, which is lineage and never authority.

**Gate** — every consequential action is checked against the whole chain before it executes.
`ALLOW`, `BLOCK` or `ESCALATE`, across 20 named checks, and the gate signs its own answer. Every
input the gate used is signed into the decision, which is what lets a stranger reproduce it.

**Evidence pack** — the chain, the signed request, the signed decision, a hash-chained ledger segment,
a signed revocation snapshot and any human approval, sealed together with the trust roots it expects.

---

## What it demonstrates

Eight deterministic scenarios, each running the same engine against different authority:

| Scenario | Result | Fails at |
| --- | --- | --- |
| An authorised payment | `ALLOW` | — |
| A payment above the delegated limit | `BLOCK` | `limit.per_action` |
| An agent handing on more than it holds | `BLOCK` | `chain.narrowing` |
| Authority that has lapsed | `BLOCK` | `temporal.validity` |
| A different agent presenting a valid mandate | `BLOCK` | `actor.binding` |
| Authority withdrawn yesterday | `BLOCK` | `revocation.status` |
| A supplier nobody approved | `BLOCK` | `counterparty.allowed` |
| Inside the limit, above the threshold | `ESCALATE` | — |

---

## What is built beyond the scenarios

| | |
| --- | --- |
| **Authority** | delegation chains · house ceiling above every mandate · capability catalogue · authority diff · simulation · reissue with signed lineage |
| **Escalation** | approval requirement carried inside the mandate · signed approval artifact · approve-later, resumed without a double spend |
| **Identity** | organisations, four roles, tenant isolation in the query · agent registry with a lifecycle · agents that sign their own requests · accountable-person provenance |
| **Evidence** | search by what was decided · audit timeline · reconstruction to a chosen instant · replay · signed statement of what the controls did |
| **Protocol** | published key sets, key rotation, conformance vectors, transparency checkpoints, an OpenAPI spec a drift test holds to the code |
| **Assistant** | an advisory model layer that explains, searches, summarises and proposes — and decides nothing |

### Two organisations, two sets of keys

Each organisation signs its own mandates, verdicts and evidence with **its own principal, gate and
recorder keys**, and publishes exactly those. One organisation's evidence pack **fails** under
another's trust roots. That is the claim the product exists to make, and it is a test rather than a
sentence: `apps/api/test/two-organisations.test.ts`.

### The assistant decides nothing

Seven named tools, executed application-side, every one read-only or proposal-only. No tool accepts an
organisation — the caller's session decides what is visible, and a model naming one is refused by a
strict schema rather than obeyed. Tool results come back marked as content, never as instructions.
With no model configured, or with the model unreachable, the gate, the evidence plane and offline
verification are unaffected — which is asserted in the same tests.

---

## Layout

```
packages/core       mandate format, scope algebra, gate, ledger, evidence pack, verification
packages/verifier   standalone command-line verifier
apps/api            Express service: issuance, delegation, gate, evidence, revocation, assistant
apps/web            demonstrator, evidence view, browser verifier, sign-in, console
conformance         13 published golden vectors
scripts             key generation, pack export, tamper helpers, migrations
```

Issuing, delegating, gate evaluation and evidence generation are server-side. **Verification
deliberately is not** — a relying party has to be able to check evidence on their own machine, so the
same verification code runs in the service, in the CLI and in the browser.

State sits behind eight interfaces, each with an in-memory and a PostgreSQL implementation. The
service picks between them at startup depending on whether `DATABASE_URL` is set. `packages/core` and
`packages/verifier` contain no database code, no authentication, no tenancy and no model provider —
and a test walks the dependency graph to prove the last of those rather than asserting it.

The Postgres store is not the same code against a table. Replay protection is a single insert against
a unique constraint, so two instances cannot both accept one nonce; the ledger reads its head under a
lock and appends in the same transaction, so simultaneous writes produce one chain rather than a
fork; and `ledger_entries` and `evidence_packs` refuse `UPDATE` and `DELETE` at the database rather
than by convention.

## Cryptography

Nothing here is invented. ES256 (ECDSA P-256 with SHA-256) via `jose` over Web Crypto; detached
compact JWS per RFC 7515 Appendix F, with the algorithm, key identifier, issue time and payload
digest in the protected header so all four are covered by the signature; RFC 8785 canonical JSON;
SHA-256 digests. Money is integer minor units with an explicit currency, so no floating point ever
reaches a limit comparison.

## Security posture, stated plainly

The demonstration keys in `packages/core/src/fixtures/keys.ts` are **published, private halves
included**. Anyone can issue a mandate the demonstration path will accept. That is deliberate — it is
what makes every result here reproducible — and it is why a real deployment keeps signing keys in an
HSM. Organisations created through the API get their own keys, which are not published.

Known limits, none of them hidden:

- **The service holds the signing keys.** Evidence says so, and the verifier reports it as
  `keyCustody: "service"` rather than letting a reader assume otherwise.
- **The deployed instance runs with authentication open**, deliberately, so the demonstration stays
  reachable. It reports that on `/health` as `auth`.
- **`jku` is absent** from the protected header, so a counterparty obtains a key set out of band.
- **The ledger is not anchored** to an external transparency log, so it detects alteration by a third
  party but not an organisation rewriting its own history from genesis.
- **`registry-verified` is a rung nothing can reach** — no external company register is consulted.
- **CORS is `*`** and rate limiting is per-instance.

The technical notes page in the app measures the implementation against the ten requirements in the
IETF's cross-organisational delegation problem statement, and says which are met, partly met and not
attempted. `SECURITY.md` covers reporting.

## Licence

Not yet licensed. Ask before reusing.
