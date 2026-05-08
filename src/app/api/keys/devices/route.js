import { NextResponse } from "next/server";
import { getDeviceCount, getDeviceDetails } from "@/lib/deviceTracker";
import { getApiKeys } from "@/lib/localDb";

export const dynamic = "force-dynamic";

function getKeyPreview(key) {
  if (!key || typeof key !== "string") return "";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

// GET /api/keys/devices - List active device details by API key
export async function GET() {
  try {
    const apiKeys = await getApiKeys();
    const devices = [];

    for (const apiKey of apiKeys) {
      devices.push({
        id: apiKey.id,
        name: apiKey.name,
        keyPreview: getKeyPreview(apiKey.key),
        count: getDeviceCount(apiKey.key),
        details: getDeviceDetails(apiKey.key),
      });
    }

    return NextResponse.json({ devices });
  } catch (error) {
    console.error("[API] Failed to get API key devices:", error);
    return NextResponse.json({ error: "Failed to fetch API key devices" }, { status: 500 });
  }
}
