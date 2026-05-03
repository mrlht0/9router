import { NextResponse } from "next/server";
import { getProviderPools, createProviderPool } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pools = await getProviderPools();
    return NextResponse.json({ pools });
  } catch (error) {
    console.log("Error fetching provider pools:", error);
    return NextResponse.json({ error: "Failed to fetch provider pools" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { name, providerIds = [] } = body;

    if (!name || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!Array.isArray(providerIds)) {
      return NextResponse.json({ error: "providerIds must be an array" }, { status: 400 });
    }

    const pool = await createProviderPool({
      name: name.trim(),
      providerIds,
    });

    return NextResponse.json({ pool }, { status: 201 });
  } catch (error) {
    console.log("Error creating provider pool:", error);
    return NextResponse.json({ error: "Failed to create provider pool" }, { status: 500 });
  }
}
