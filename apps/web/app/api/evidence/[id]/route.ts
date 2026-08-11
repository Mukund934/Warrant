import { NextResponse } from "next/server";
import { demoScenarios } from "@warrant/core/fixtures";

export async function generateStaticParams() {
  return (await demoScenarios()).map((scenario) => ({ id: scenario.id }));
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const scenario = (await demoScenarios()).find((item) => item.id === id);

  if (!scenario) {
    return NextResponse.json(
      { error: "not_found", message: `no demonstration scenario named ${id}` },
      { status: 404 },
    );
  }

  return new NextResponse(`${JSON.stringify(scenario.pack, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${scenario.id}.json"`,
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
