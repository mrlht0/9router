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
    const authenticated = !!session?.authenticated;
    const displayName = authenticated
      ? (oidcName || oidcEmail || userEmail || (session?.oidc ? "OIDC user" : "Local user"))
      : null;
    const loginMethod = authenticated
      ? (session?.oidc ? "OIDC" : "Email/Password")
      : null;

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
      oidcName: authenticated ? (oidcName || null) : null,
      oidcEmail: authenticated ? (oidcEmail || null) : null,
      userEmail: authenticated ? (userEmail || null) : null,
      oidcLogin: authenticated && !!session?.oidc,
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
      displayName: null,
      loginMethod: null,
      oidcName: null,
      oidcEmail: null,
      userEmail: null,
      oidcLogin: false,
    });
  }
}
