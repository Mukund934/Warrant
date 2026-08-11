import { NextResponse } from "next/server";
import { trustRoots } from "@warrant/core/fixtures";

export async function GET() {
  return new NextResponse(`${JSON.stringify(trustRoots, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="trust-roots.json"',
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
