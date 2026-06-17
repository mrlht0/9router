import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { createUser, getUsers } from "@/lib/localDb";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function POST(request) {
  try {
    const existingUsers = await getUsers();
    if (existingUsers.length > 0) {
      return NextResponse.json({ error: "Registration is disabled after the first account is created" }, { status: 403 });
    }

    const { email, password } = await request.json();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({ email: normalizedEmail, passwordHash, bootstrapOnly: true });

    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request, {
      userId: user.id,
      userEmail: user.email,
      loginMethod: "email-password",
    });

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    const message = error?.message || "Registration failed";
    const status = message === "Email already exists"
      ? 409
      : message === "Bootstrap registration already completed"
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
