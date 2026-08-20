import Link from "next/link";
import { redirect } from "next/navigation";
import { Eyebrow, Note, Section } from "@/components/primitives";
import { SignInButton } from "@/components/sign-in-button";
import { safeRedirectPath, signInConfigured } from "@/lib/supabase/config";
import { currentViewer } from "@/lib/supabase/server";

export const metadata = { title: "Sign in" };

// Reads the session to bounce an already-signed-in visitor onwards, so it can never be prerendered.
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  if (await currentViewer()) redirect(safeRedirectPath(next));

  const configured = signInConfigured();

  return (
    <Section width="prose" className="py-10 sm:py-16">
      <header className="mb-8">
        <Eyebrow>Sign in</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          Sign in to act under an organisation
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          Signing in identifies the accountable person behind an action. It decides who may issue and
          delegate authority — never what the gate decides. A verdict is a function of the mandate
          chain and the signed evaluation inputs alone, which is why{" "}
          <Link href="/verify" className="text-seal hover:underline">
            verifying evidence
          </Link>{" "}
          never requires an account here.
        </p>
      </header>

      {error ? (
        <div className="mb-8">
          <Note tone="caution">
            <span className="text-text">Sign-in did not complete.</span> {error}
          </Note>
        </div>
      ) : null}

      {configured ? (
        <div className="space-y-6">
          <SignInButton {...(next ? { next } : {})} />
          <p className="text-[13px] leading-relaxed text-text-faint">
            Google is asked only for <span className="font-mono">openid</span>,{" "}
            <span className="font-mono">email</span> and <span className="font-mono">profile</span>.
            Warrant reads no mail, no files and no calendar, and stores nothing from Google beyond the
            address that identifies you in an evidence pack.
          </p>
        </div>
      ) : (
        <Note tone="caution">
          <span className="text-text">This deployment has no identity provider configured.</span> The
          demonstrator, the documentation and the offline verifier all work without one — sign-in is
          only needed to record authority of your own.
        </Note>
      )}
    </Section>
  );
}
