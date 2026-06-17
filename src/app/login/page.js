"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/shared/components";

const LOGIN_VIEW = "login";
const REGISTER_VIEW = "register";

export default function LoginPage() {
  const router = useRouter();
  const [view, setView] = useState(LOGIN_VIEW);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [hasUsers, setHasUsers] = useState(false);
  const [authMode, setAuthMode] = useState("password");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ email: "", password: "", confirmPassword: "" });

  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((value) => (value > 0 ? value - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function loadStatus() {
      try {
        const res = await fetch("/api/auth/status");
        if (!res.ok) throw new Error("Failed to load auth status");
        const data = await res.json();
        if (data.requireLogin === false) {
          router.push("/dashboard");
          router.refresh();
          return;
        }
        const usersExist = data.hasUsers === true;
        const canRegister = data.allowRegistration === true;
        setHasUsers(usersExist);
        setAllowRegistration(canRegister);
        setAuthMode(data.authMode || "password");
        setOidcConfigured(data.oidcConfigured === true);
        setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
        setView(usersExist ? LOGIN_VIEW : canRegister ? REGISTER_VIEW : LOGIN_VIEW);
      } catch {
        setHasUsers(false);
        setAllowRegistration(true);
        setView(REGISTER_VIEW);
      } finally {
        setLoading(false);
      }
    }
    loadStatus();
  }, [router]);

  const oidcAvailable = oidcConfigured && ["oidc", "both"].includes(authMode);
  const passwordAvailable = authMode !== "oidc" || !oidcConfigured;
  const canShowRegister = allowRegistration && !hasUsers;

  function switchView(nextView) {
    setError("");
    setRetryAfter(0);
    setView(nextView);
  }

  function updateLoginField(key, value) {
    setLoginForm((current) => ({ ...current, [key]: value }));
  }

  function updateRegisterField(key, value) {
    setRegisterForm((current) => ({ ...current, [key]: value }));
  }

  async function handleLogin(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to sign in.");
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Unable to sign in right now.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    setError("");
    if (registerForm.password !== registerForm.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: registerForm.email,
          password: registerForm.password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to create account.");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Unable to create account right now.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleOidcLogin() {
    window.location.href = "/api/auth/oidc/start";
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(51,65,85,0.18),transparent_45%),linear-gradient(180deg,#0b1120_0%,#111827_100%)] text-white flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-sm text-white/70">Checking access...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.16),transparent_38%),radial-gradient(circle_at_bottom,rgba(249,115,22,0.16),transparent_32%),linear-gradient(180deg,#0b1120_0%,#111827_52%,#030712_100%)] text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-10">
        <div className="grid w-full gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="flex flex-col justify-center">
            <div className="mb-6 inline-flex w-fit items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs tracking-[0.24em] text-white/70 uppercase">
              9Router Access
            </div>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight sm:text-5xl">
              One account per user, one login flow, no legacy fallback.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-white/70 sm:text-lg">
              Dashboard access now uses a single account-based flow. Sign in with email and password, or create the first account before onboarding the rest of the system.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium">Account-based</p>
                <p className="mt-2 text-sm text-white/65">Every user gets isolated settings, usage and credentials.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium">Single auth model</p>
                <p className="mt-2 text-sm text-white/65">No mixed password-only mode on the main login screen anymore.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium">Ready for OIDC</p>
                <p className="mt-2 text-sm text-white/65">OIDC still stays available when that mode is configured.</p>
              </div>
            </div>
          </section>

          <section>
            <Card className="border border-white/10 bg-white/95 text-slate-950 shadow-2xl shadow-black/30 backdrop-blur">
              <div className="flex flex-col gap-6">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.22em] text-slate-500">Dashboard</p>
                  <h2 className="mt-2 text-2xl font-semibold">
                    {view === REGISTER_VIEW ? "Create account" : "Sign in"}
                  </h2>
                  <p className="mt-2 text-sm text-slate-500">
                    {view === REGISTER_VIEW
                      ? "Register the first local account with a valid email and password."
                      : "Use your email and password to enter the dashboard."}
                  </p>
                </div>

                {canShowRegister && (
                  <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1">
                    <button
                      type="button"
                      onClick={() => switchView(LOGIN_VIEW)}
                      className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                        view === LOGIN_VIEW ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"
                      }`}
                    >
                      Đăng nhập
                    </button>
                    <button
                      type="button"
                      onClick={() => switchView(REGISTER_VIEW)}
                      className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                        view === REGISTER_VIEW ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"
                      }`}
                    >
                      Đăng ký
                    </button>
                  </div>
                )}

                {oidcAvailable && view === LOGIN_VIEW && (
                  <>
                    <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                      {oidcLoginLabel}
                    </Button>
                    {passwordAvailable && (
                      <div className="relative">
                        <div className="h-px bg-slate-200" />
                        <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-white px-3 text-xs uppercase tracking-[0.24em] text-slate-400">
                          or
                        </span>
                      </div>
                    )}
                  </>
                )}

                {error && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {error}
                  </div>
                )}

                {view === LOGIN_VIEW && passwordAvailable && (
                  <form onSubmit={handleLogin} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-slate-700">Email</label>
                      <Input
                        type="email"
                        placeholder="you@example.com"
                        value={loginForm.email}
                        onChange={(event) => updateLoginField("email", event.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-slate-700">Password</label>
                      <Input
                        type="password"
                        placeholder="Enter your password"
                        value={loginForm.password}
                        onChange={(event) => updateLoginField("password", event.target.value)}
                        required
                      />
                    </div>
                    {retryAfter > 0 && (
                      <p className="text-xs text-amber-600">
                        Too many attempts. Try again in {retryAfter}s.
                      </p>
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full"
                      loading={submitting}
                      disabled={submitting || retryAfter > 0 || !loginForm.email || !loginForm.password}
                    >
                      {retryAfter > 0 ? `Wait ${retryAfter}s` : "Sign in"}
                    </Button>
                    {canShowRegister && (
                      <p className="text-center text-sm text-slate-500">
                        No account yet?{" "}
                        <button
                          type="button"
                          onClick={() => switchView(REGISTER_VIEW)}
                          className="font-medium text-slate-950 underline underline-offset-4"
                        >
                          Create the first one
                        </button>
                      </p>
                    )}
                  </form>
                )}

                {view === REGISTER_VIEW && canShowRegister && (
                  <form onSubmit={handleRegister} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-slate-700">Email</label>
                      <Input
                        type="email"
                        placeholder="you@example.com"
                        value={registerForm.email}
                        onChange={(event) => updateRegisterField("email", event.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-slate-700">Password</label>
                      <Input
                        type="password"
                        placeholder="At least 8 characters"
                        value={registerForm.password}
                        onChange={(event) => updateRegisterField("password", event.target.value)}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium text-slate-700">Confirm password</label>
                      <Input
                        type="password"
                        placeholder="Repeat your password"
                        value={registerForm.confirmPassword}
                        onChange={(event) => updateRegisterField("confirmPassword", event.target.value)}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full"
                      loading={submitting}
                      disabled={
                        submitting ||
                        !registerForm.email ||
                        !registerForm.password ||
                        !registerForm.confirmPassword
                      }
                    >
                      Create account
                    </Button>
                    <p className="text-center text-sm text-slate-500">
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => switchView(LOGIN_VIEW)}
                        className="font-medium text-slate-950 underline underline-offset-4"
                      >
                        Sign in
                      </button>
                    </p>
                  </form>
                )}

                {!canShowRegister && view === REGISTER_VIEW && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    Registration is currently disabled because an account already exists.
                  </div>
                )}
              </div>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
