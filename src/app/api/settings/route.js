import { NextResponse } from "next/server";
import { getSettings, updateSettings, getUserById, updateUser, getUsers } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

export async function GET() {
  try {
    const settings = await getSettings();
    const users = await getUsers();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    safeSettings.hasUsers = users.length > 0;
    safeSettings.allowRegistration = users.length === 0;
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // If updating password, hash it
    if (body.newPassword) {
      const cookieStore = await cookies();
      const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
      if (session?.userId) {
        const user = await getUserById(session.userId);
        if (!user?.passwordHash || user.isActive === false) {
          return NextResponse.json({ error: "User account not found" }, { status: 404 });
        }
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }

        const passwordHash = await bcrypt.hash(body.newPassword, 10);
        await updateUser(user.id, { passwordHash });
        const users = await getUsers();
        const settings = await getSettings();
        const { password, oidcClientSecret, ...safeSettings } = settings;
        safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
        safeSettings.hasUsers = users.length > 0;
        safeSettings.allowRegistration = users.length === 0;
        return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
      }

      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);
    const users = await getUsers();

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    safeSettings.hasUsers = users.length > 0;
    safeSettings.allowRegistration = users.length === 0;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

