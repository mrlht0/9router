import { NextResponse } from "next/server";
import { getDeviceCount, getDeviceDetails } from "@/lib/deviceTracker";
import { getApiKeys } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/keys/devices - List active device details by API key
export async function GET() {
  try {
    const apiKeys = await getApiKeys();
    const devices = {};

    for (const apiKey of apiKeys) {
      devices[apiKey.key] = {
        count: getDeviceCount(apiKey.key),
        details: getDeviceDetails(apiKey.key),
      };
    }

    return NextResponse.json({ devices });
  } catch (error) {
    console.error("[API] Failed to get API key devices:", error);
    return NextResponse.json({ error: "Failed to fetch API key devices" }, { status: 500 });
  }
}
