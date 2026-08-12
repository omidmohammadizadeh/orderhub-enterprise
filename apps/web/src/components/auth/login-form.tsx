"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, AlertCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);
  const router = useRouter();
  const search = useSearchParams();

  // Surface OAuth errors that arrived via ?error=… (the API's callback
  // bounces back here when it can't sign the user in for any reason —
  // missing tenant, deactivated account, unknown failure).
  useEffect(() => {
    const err = search.get("error");
    if (!err) return;
    const friendly: Record<string, string> = {
      oauth_failed: "Google sign-in failed. Please try again.",
      no_tenant: "No tenant configured for new Google accounts. Contact support.",
      account_inactive: "This account is deactivated.",
      oauth_missing_tokens: "Sign-in callback was missing the auth tokens.",
    };
    setServerError(friendly[err] ?? decodeURIComponent(err));
  }, [search]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: process.env.NODE_ENV === "development" ? "admin@demo.orderhub.io" : "",
      password: process.env.NODE_ENV === "development" ? "Demo1234!" : "",
    },
  });

  const onSubmit = async (data: LoginFormData) => {
    setServerError(null);
    try {
      await login({ email: data.email, password: data.password });
      // Honour ?next= (e.g. a kitchen tablet re-authing back to its display),
      // but only same-origin relative paths — never an open redirect.
      const next = search.get("next");
      router.replace(next && next.startsWith("/") ? next : "/dashboard/orders");
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message.includes("401")
          ? "Invalid email or password. Please try again."
          : "Something went wrong. Please try again.";
      setServerError(message);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Server error */}
      {serverError && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 animate-fade-in">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{serverError}</span>
        </div>
      )}

      {/* Email */}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="you@restaurant.com"
          error={!!errors.email}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-red-600">{errors.email.message}</p>
        )}
      </div>

      {/* Password */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-xs text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            Forgot password?
          </Link>
        </div>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            error={!!errors.password}
            className="pr-10"
            {...register("password")}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 transition-colors"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        {errors.password && (
          <p className="text-xs text-red-600">{errors.password.message}</p>
        )}
      </div>

      {/* Submit */}
      <Button
        type="submit"
        size="lg"
        loading={isSubmitting}
        className="w-full group"
      >
        {isSubmitting ? "Signing in…" : (
          <>
            Sign in
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </Button>

      {/* Divider + social sign-in */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-200"></div>
        </div>
        <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
          <span className="bg-white px-2 text-zinc-400">or continue with</span>
        </div>
      </div>

      <GoogleSignInButton />

      {/* Dev hint */}
      {process.env.NODE_ENV === "development" && (
        <p className="text-center text-xs text-zinc-400">
          Dev credentials pre-filled · <span className="font-mono">Demo1234!</span>
        </p>
      )}
    </form>
  );
}

/**
 * Phase AO — Google sign-in. Full-page redirect to the API's
 * /auth/oauth/google route which kicks off the Passport flow.
 * Using NEXT_PUBLIC_API_URL when set (typical in production); falls
 * back to the same-origin /api prefix that the Next.js rewrites map
 * to the API in development.
 */
function GoogleSignInButton() {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "/api";
  const href = `${apiBase.replace(/\/+$/, "")}/v1/auth/oauth/google`;
  return (
    <a
      href={href}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.26 1.05-3.72 1.05-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" fill="#34A853"/>
        <path d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.66-2.84Z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </a>
  );
}
