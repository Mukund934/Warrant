"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/supabase/server";
import { callApi } from "@/lib/warrant-api";

export interface ActionState {
  error?: string;
  created?: string;
}

/**
 * Creating an organisation is the one write this console makes, and it is deliberately the only one
 * for now: it is what turns a signed-in person into an accountable owner, and nothing else can be
 * recorded until that exists.
 *
 * The API decides. This re-checks the session only so an unauthenticated submit fails here rather
 * than producing a confusing error from a service that was never going to accept it.
 */
export async function createOrganisation(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const viewer = await currentViewer();
  if (!viewer) return { error: "your session has ended; sign in again" };

  const name = String(form.get("name") ?? "").trim();
  const jurisdiction = String(form.get("jurisdiction") ?? "").trim();

  if (name.length < 2) return { error: "an organisation needs a name" };
  if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) {
    return { error: "jurisdiction is an ISO code like IN or IN-MH" };
  }

  const outcome = await callApi<{ id: string; name: string }>("/v1/organisations", {
    method: "POST",
    body: { name, jurisdiction },
    accessToken: viewer.accessToken,
  });

  if (!outcome.ok) return { error: outcome.failure.message };

  revalidatePath("/console");
  return { created: outcome.data.name };
}
