import { NextResponse } from "next/server";
import { trustRoots } from "@warrant/core/fixtures";

export async function GET() {
  const body = {
    keys: trustRoots.map((root) => ({
      ...root.publicKeyJwk,
      kid: root.keyId,
      use: "sig",
      alg: "ES256",
    })),
  };

  return new NextResponse(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      "content-type": "application/jwk-set+json; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    },
  });
}
