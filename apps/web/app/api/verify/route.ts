import { NextResponse } from "next/server";
import { verifyEvidencePack } from "@warrant/core";
import type { TrustRoot } from "@warrant/core";

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "an evidence pack may not exceed 512 KB" },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "payload_too_large", message: "an evidence pack may not exceed 512 KB" },
        { status: 413 },
      );
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "malformed_json", message: "the request body is not valid JSON" },
      { status: 400 },
    );
  }

  const payload = body as { pack?: unknown; trustRoots?: TrustRoot[] };
  if (!payload || typeof payload !== "object" || payload.pack === undefined) {
    return NextResponse.json(
      { error: "missing_pack", message: "send { pack, trustRoots? }" },
      { status: 400 },
    );
  }

  const report = await verifyEvidencePack(payload.pack, {
    ...(Array.isArray(payload.trustRoots) ? { trustRoots: payload.trustRoots } : {}),
  });

  return NextResponse.json(report, { status: 200 });
}
