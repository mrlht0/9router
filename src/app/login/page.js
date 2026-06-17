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
      <div className="min-h-screen flex items-center justify-center bg-bg p-4">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
          <p className="mt-4 text-text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary mb-2">9Router</h1>
          <p className="text-text-muted">
            {view === REGISTER_VIEW ? "Create your account" : "Sign in to the dashboard"}
          </p>
        </div>

        <Card>
          <div className="flex flex-col gap-4">
            {oidcAvailable && view === LOGIN_VIEW && (
              <>
                <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                  {oidcLoginLabel}
                </Button>
                {passwordAvailable && <div className="h-px bg-border/60" />}
              </>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </div>
            )}

            {view === LOGIN_VIEW && passwordAvailable && (
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Email</label>
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
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    placeholder="Enter your password"
                    value={loginForm.password}
                    onChange={(event) => updateLoginField("password", event.target.value)}
                    required
                  />
                </div>
                {retryAfter > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
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
                  <p className="text-center text-sm text-text-muted">
                    No account yet?{" "}
                    <button
                      type="button"
                      onClick={() => switchView(REGISTER_VIEW)}
                      className="font-medium text-primary underline underline-offset-4"
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
                  <label className="text-sm font-medium">Email</label>
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
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    placeholder="At least 8 characters"
                    value={registerForm.password}
                    onChange={(event) => updateRegisterField("password", event.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Confirm password</label>
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
                <p className="text-center text-sm text-text-muted">
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => switchView(LOGIN_VIEW)}
                    className="font-medium text-primary underline underline-offset-4"
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
