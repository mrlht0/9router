import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";

// Clear the legacy dashboard password hash. Local accounts are reset through account recovery flows.
export async function POST() {
  try {
    await updateSettings({ password: null });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

