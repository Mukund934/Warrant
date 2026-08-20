"use client";

import { useActionState } from "react";
import { createOrganisation } from "@/app/console/actions";
import type { ActionState } from "@/app/console/actions";
import { Card } from "@/components/primitives";

const INITIAL: ActionState = {};

export function CreateOrganisationForm() {
  const [state, submit, pending] = useActionState(createOrganisation, INITIAL);

  return (
    <Card className="p-5">
      <form action={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <label className="block space-y-1.5">
            <span className="text-[13px] text-text-muted">Legal name</span>
            <input
              name="name"
              required
              minLength={2}
              maxLength={120}
              placeholder="Meridian Technologies Pvt Ltd"
              className="w-full rounded-md border border-line bg-ink-raised px-3 py-2 text-[14px] outline-none transition-colors focus:border-seal-dim"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[13px] text-text-muted">Jurisdiction</span>
            <input
              name="jurisdiction"
              required
              placeholder="IN-MH"
              className="w-full rounded-md border border-line bg-ink-raised px-3 py-2 font-mono text-[13px] uppercase outline-none transition-colors focus:border-seal-dim"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-line-strong bg-surface-raised px-4 py-2 text-[14px] font-medium transition-colors hover:border-seal-dim disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Recording…" : "Create organisation"}
        </button>

        {state.error ? (
          <p role="alert" className="text-[13px] text-fail">
            {state.error}
          </p>
        ) : null}

        {state.created ? (
          <p role="status" className="text-[13px] text-pass">
            {state.created} is recorded, and you are its owner.
          </p>
        ) : null}
      </form>
    </Card>
  );
}
