import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { PROTECTED_PATHS, createApp } from "../src/app.js";
import {
  AuthenticationError,
  bearerToken,
  supabaseIssuer,
  tokenVerifier,
} from "../src/auth/principal.js";
import type { TokenVerifier } from "../src/auth/principal.js";

const ISSUER = "https://project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let verifier: TokenVerifier;

beforeAll(async () => {
  const mine = await generateKeyPair("ES256", { extractable: true });
  const theirs = await generateKeyPair("ES256", { extractable: true });
  signingKey = mine.privateKey;
  otherKey = theirs.privateKey;

  const publicJwk = (await exportJWK(mine.publicKey)) as JWK;
  verifier = tokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", use: "sig", kid: "test" }] }),
  });
});

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  subject?: string | null;
  expiresIn?: string;
  claims?: Record<string, unknown>;
  key?: CryptoKey;
}

async function mint(overrides: TokenOverrides = {}): Promise<string> {
  const token = new SignJWT({ email: "priya@meridian.example", ...(overrides.claims ?? {}) })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "1h");

  if (overrides.subject !== null) token.setSubject(overrides.subject ?? "user_priya");
  return token.sign(overrides.key ?? signingKey);
}

describe("what a Supabase access token has to prove before it identifies anybody", () => {
  it("accepts a well-formed token and reports who presented it", async () => {
    const principal = await verifier.verify(await mint());

    expect(principal.subject).toBe("user_priya");
    expect(principal.issuer).toBe(ISSUER);
    expect(principal.email).toBe("priya@meridian.example");
  });

  it("refuses a token signed by a key that is not in the published set", async () => {
    await expect(verifier.verify(await mint({ key: otherKey }))).rejects.toThrow(AuthenticationError);
  });

  it("refuses a token from a different issuer", async () => {
    await expect(
      verifier.verify(await mint({ issuer: "https://elsewhere.example/auth/v1" })),
    ).rejects.toThrow(AuthenticationError);
  });

  it("refuses a token minted for a different audience", async () => {
    await expect(verifier.verify(await mint({ audience: "service_role" }))).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("refuses a token that has expired", async () => {
    await expect(verifier.verify(await mint({ expiresIn: "-1h" }))).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("refuses a token that names no subject", async () => {
    await expect(verifier.verify(await mint({ subject: null }))).rejects.toThrow(AuthenticationError);
  });

  it("refuses an HS256 token, so a public key cannot be replayed as a shared secret", async () => {
    const stolen = await exportJWK((await generateKeyPair("ES256", { extractable: true })).publicKey);
    const forged = await new SignJWT({ sub: "user_attacker" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(JSON.stringify(stolen)));

    await expect(verifier.verify(forged)).rejects.toThrow(AuthenticationError);
  });

  it("refuses an unsigned token", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = [
      encode({ alg: "none", typ: "JWT" }),
      encode({
        sub: "user_attacker",
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "",
    ].join(".");

    await expect(verifier.verify(unsigned)).rejects.toThrow(AuthenticationError);
  });

  it("refuses rubbish with a named error rather than an internal failure", async () => {
    await expect(verifier.verify("not-a-token")).rejects.toThrow(/access token was refused/);
  });

  it("never carries user-writable metadata into the principal", async () => {
    const principal = await verifier.verify(
      await mint({
        claims: {
          user_metadata: { role: "owner", organisation: "meridian", is_admin: true },
          app_metadata: { role: "owner" },
        },
      }),
    );

    expect(JSON.stringify(principal)).not.toMatch(/owner|is_admin/);
    expect(principal).not.toHaveProperty("role");
    expect(principal).not.toHaveProperty("user_metadata");
    expect(principal).not.toHaveProperty("app_metadata");
  });

  it("derives the Supabase issuer from the project url without a trailing slash surprise", () => {
    expect(supabaseIssuer("https://abc.supabase.co")).toBe("https://abc.supabase.co/auth/v1");
    expect(supabaseIssuer("https://abc.supabase.co/")).toBe("https://abc.supabase.co/auth/v1");
  });

  it("reads a bearer token only from a well-formed Authorization header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

const PUBLIC_SURFACE = [
  "/health",
  "/v1/trust-roots",
  "/v1/scenarios",
  "/v1/scenarios/over-limit",
  "/v1/evidence/over-limit",
];

describe("the demonstrator and the verifier stay in front of the login wall", () => {
  it("serves every public surface without a token, even when auth is required", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });

    for (const path of PUBLIC_SURFACE) {
      await request(app).get(path).expect(200);
    }
  }, 30_000);

  it("verifies an evidence pack for anyone who asks", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    const pack = await request(app).get("/v1/evidence/over-limit").expect(200);

    const report = await request(app).post("/v1/verify").send({ pack: pack.body }).expect(200);
    expect(report.body.result).toBe("VERIFIED");
  }, 30_000);
});

const ROOT_MANDATE = {
  scope: {
    actions: ["payment.execute"],
    audience: ["erp:meridian/accounts-payable"],
    counterparties: { any: true },
    limits: { perAction: { currency: "INR", minor: 100_000_000 } },
  },
  notBefore: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  maxDelegationDepth: 1,
};

describe("the control plane behind the login wall", () => {
  const issue = (app: ReturnType<typeof createApp>, token?: string) => {
    const call = request(app).post("/v1/mandates").send(ROOT_MANDATE);
    return token ? call.set("authorization", `Bearer ${token}`) : call;
  };

  it("refuses an unauthenticated caller and says how to authenticate", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    const response = await issue(app).expect(401);

    expect(response.body.error).toBe("unauthenticated");
    expect(response.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("admits a caller who presents a valid token", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    await issue(app, await mint()).expect(201);
  });

  it("refuses an expired token on a protected route", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    await issue(app, await mint({ expiresIn: "-1h" })).expect(401);
  });

  it("keeps working without a token when the deployment declares itself open", async () => {
    const app = createApp({ auth: { mode: "open" } });
    await issue(app).expect(201);
  });

  it("still refuses a broken token in open mode rather than ignoring it", async () => {
    const app = createApp({ auth: { mode: "open", verifier } });
    await issue(app, await mint({ key: otherKey })).expect(401);
  });

  it("refuses a token a deployment has no way to check", async () => {
    const app = createApp({ auth: { mode: "open" } });
    const response = await issue(app, await mint()).expect(401);

    expect(response.body.message).toMatch(/accepts no bearer tokens/);
  });

  it("refuses to start in required mode with nothing to check tokens against", () => {
    expect(() => createApp({ auth: { mode: "required" } })).toThrow(/refusing to start/);
  });

  it("still answers 404 for an unknown route rather than 401", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    await request(app).get("/v1/nothing-here").expect(404);
  });

  it("reports the mode and the issuer it trusts on /health", async () => {
    const app = createApp({ auth: { mode: "required", verifier } });
    const response = await request(app).get("/health").expect(200);

    expect(response.body.auth).toBe("required");
    expect(response.body.authIssuer).toBe(ISSUER);
  });
});

describe("authentication answers who is asking, never what may be done", () => {
  async function decide(token: string, nonce: string) {
    const app = createApp({ auth: { mode: "required", verifier } });
    const bearer = `Bearer ${token}`;

    const root = await request(app)
      .post("/v1/mandates")
      .set("authorization", bearer)
      .send(ROOT_MANDATE)
      .expect(201);

    const delegated = await request(app)
      .post(`/v1/mandates/${root.body.id}/delegations`)
      .set("authorization", bearer)
      .send({ scopeDelta: { actions: ["payment.execute"] } })
      .expect(201);

    const action = await request(app)
      .post("/v1/actions")
      .set("authorization", bearer)
      .send({
        mandateId: delegated.body.id,
        action: "payment.execute",
        resource: "erp:meridian/accounts-payable",
        counterparty: "Kalyani Steel Works",
        description: "Invoice settlement",
        nonce,
        amount: { currency: "INR", minor: 5_000_000 },
      })
      .expect(201);

    return action.body;
  }

  it("reaches the same verdict whoever is logged in", async () => {
    const first = await decide(await mint({ subject: "user_priya" }), "nonce-auth-a");
    const second = await decide(await mint({ subject: "user_rahul" }), "nonce-auth-b");

    expect(first.verdict).toBe(second.verdict);
    expect(first.decision.checks.map((check: { id: string }) => check.id)).toEqual(
      second.decision.checks.map((check: { id: string }) => check.id),
    );
  }, 30_000);

  it("puts no trace of the authenticated caller into the signed decision", async () => {
    const outcome = await decide(await mint({ subject: "user_priya" }), "nonce-auth-c");
    const serialised = JSON.stringify(outcome.decision);

    expect(serialised).not.toMatch(/user_priya|priya@meridian\.example|supabase/i);
  }, 30_000);
});

describe("no authority route can escape the guard by being forgotten", () => {
  it("covers every route the authority router declares", async () => {
    const source = await readFile(new URL("../src/routes/authority.ts", import.meta.url), "utf8");
    const declared = [...source.matchAll(/router\.(?:get|post)\("([^"]+)"/g)].map(
      (match) => `/v1${match[1]}`,
    );

    expect(declared.length).toBeGreaterThan(0);
    for (const path of declared) {
      const covered = PROTECTED_PATHS.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      expect(covered, `${path} is not behind requirePrincipal`).toBe(true);
    }
  });
});
