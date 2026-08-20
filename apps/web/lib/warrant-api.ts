import "server-only";

/**
 * The Warrant API, reached from server code only.
 *
 * `WARRANT_API_URL` has no `NEXT_PUBLIC_` prefix and must never gain one (ROADMAP §15). That is not
 * about hiding the hostname — it is public — but about where the access token goes. The browser is
 * never handed a token to forward, so a page cannot leak one and a compromised script cannot use
 * one. Every authenticated call is made here, with a token read from the session cookie.
 */

export interface ApiFailure {
  error: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; failure: ApiFailure };

const base = (): string | null => process.env.WARRANT_API_URL?.replace(/\/+$/, "") ?? null;

export const apiConfigured = (): boolean => base() !== null;

export interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Names which organisation to act under when an account belongs to more than one. */
  organisationId?: string;
  accessToken?: string;
}

export async function callApi<T>(path: string, options: CallOptions = {}): Promise<ApiResult<T>> {
  const root = base();
  if (!root) {
    return {
      ok: false,
      status: 503,
      failure: {
        error: "api_not_configured",
        message: "this deployment has no Warrant API configured, so there is nothing to record against",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${root}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        ...(options.organisationId ? { "x-warrant-organisation": options.organisationId } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      // Authority changes while you are looking at it. A cached membership list is a wrong one.
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 502,
      failure: { error: "api_unreachable", message: "the Warrant API could not be reached" },
    };
  }

  if (response.status === 204) return { ok: true, data: undefined as T };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      failure: { error: "malformed_response", message: "the API returned something that is not JSON" },
    };
  }

  if (!response.ok) {
    const failure = payload as Partial<ApiFailure>;
    return {
      ok: false,
      status: response.status,
      failure: {
        error: failure.error ?? "request_failed",
        message: failure.message ?? `the API answered ${response.status}`,
      },
    };
  }

  return { ok: true, data: payload as T };
}

export interface MyOrganisation {
  id: string;
  name: string;
  jurisdiction: string;
  role: "owner" | "admin" | "member" | "auditor";
}

export interface ApiHealth {
  status: string;
  persistence: string;
  databaseReachable: boolean;
  replayScope: string;
  auth: "open" | "required";
  authIssuer: string | null;
  assistant: string | null;
}

export const myOrganisations = (accessToken: string) =>
  callApi<MyOrganisation[]>("/v1/organisations", { accessToken });

export const apiHealth = () => callApi<ApiHealth>("/health");
