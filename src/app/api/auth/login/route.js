import { NextResponse } from "next/server";
import { getSettings, getUsers, getUserByEmail, updateUser } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isLocalRequest } from "@/dashboardGuard";

const RESET_HINT = "Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default.";

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { email, password } = await request.json();
    const settings = await getSettings();
    const users = await getUsers();
    const hasUsers = users.length > 0;

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
      return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
    }

    let isValid = false;
    let authClaims = {};
    if (hasUsers) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (!normalizedEmail) {
        return NextResponse.json({ error: "Email is required" }, { status: 400 });
      }
      const user = await getUserByEmail(normalizedEmail);
      if (user?.isActive !== false && user?.passwordHash) {
        isValid = await bcrypt.compare(password, user.passwordHash);
        if (isValid) {
          authClaims = {
            userId: user.id,
            userEmail: user.email,
            loginMethod: "email-password",
          };
          await updateUser(user.id, { lastLoginAt: new Date().toISOString() });
        }
      }
    } else {
      const storedHash = settings.password;
      if (storedHash) {
        isValid = await bcrypt.compare(password, storedHash);
      } else {
        const initialPassword = process.env.INITIAL_PASSWORD || "123456";
        isValid = password === initialPassword;
      }
    }

    if (isValid) {
      recordSuccess(ip);
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request, authClaims);

      // Default password still in use on a remote client → force a password
      // change before the dashboard is exposed remotely (keeps local UX intact).
      const mustChangePassword =
        !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

      return NextResponse.json({ success: true, mustChangePassword, hasUsers });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
