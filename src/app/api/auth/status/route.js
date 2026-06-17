import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, getUsers } from "@/lib/localDb";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

export async function GET() {
  try {
    const settings = await getSettings();
    const users = await getUsers();
    const hasUsers = users.length > 0;
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    const requireLogin = settings.requireLogin !== false;
    const authMode = settings.authMode || "password";
    const oidcName = String(session?.oidcName || "").trim();
    const oidcEmail = String(session?.oidcEmail || "").trim();
    const userEmail = String(session?.userEmail || "").trim();
    const displayName = oidcName || oidcEmail || userEmail || (session?.oidc ? "OIDC user" : hasUsers ? "Local user" : "Password user");
    const loginMethod = session?.oidc ? "OIDC" : (userEmail ? "Email/Password" : "Password");

    return NextResponse.json({
      requireLogin,
      authMode,
      oidcConfigured: isOidcConfigured(settings),
      oidcLoginLabel: (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
      hasPassword: !!settings.password,
      hasUsers,
      allowRegistration: !hasUsers,
      displayName,
      loginMethod,
      oidcName: oidcName || null,
      oidcEmail: oidcEmail || null,
      userEmail: userEmail || null,
      oidcLogin: !!session?.oidc,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authMode: "password",
      oidcConfigured: false,
      oidcLoginLabel: "Sign in with OIDC",
      hasPassword: false,
      hasUsers: false,
      allowRegistration: true,
      displayName: "Local user",
      loginMethod: "Password",
      oidcName: null,
      oidcEmail: null,
      userEmail: null,
      oidcLogin: false,
    });
  }
}
