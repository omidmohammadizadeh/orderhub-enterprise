import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles the server into a single self-contained directory.
  // Required by infrastructure/docker/Dockerfile.web which copies .next/standalone.
  // Also used by Render/Railway Docker deployments.
  output: "standalone",

  // Turborepo-friendly transpilation of workspace packages
  transpilePackages: ["@orderhub/shared", "@orderhub/ui"],

  // Explicitly set the monorepo root for standalone output file tracing.
  // Without this, Next.js auto-detection may fail in Docker (no pnpm-workspace.yaml
  // lookup works reliably) and server.js ends up at the standalone root instead of
  // apps/web/server.js — breaking CMD ["node", "apps/web/server.js"].
  outputFileTracingRoot: path.join(__dirname, "../../"),

  experimental: {
    // Server Actions are stable in Next 15 but kept here for visibility
    serverActions: {
      allowedOrigins: [process.env.APP_URL ?? "http://localhost:3000"],
    },
  },

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.cloudflare.com" },
      { protocol: "https", hostname: "**.cloudinary.com" },
      { protocol: "https", hostname: "**.amazonaws.com" },
    ],
  },

  // Strict security headers for all routes
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },

  // Rewrites: proxy /api/* → NestJS API (same-origin from the browser's perspective).
  //
  // Why this matters: Render's Starter plan proxy layer strips CORS response headers
  // before they reach the browser, making cross-origin requests impossible regardless
  // of NestJS CORS config. By routing all browser API calls through the Next.js server
  // (NEXT_PUBLIC_API_URL = /api), requests are same-origin and never need CORS.
  //
  // NEXT_PUBLIC_SOCKET_URL is the API server root (https://orderhub-api-0re6.onrender.com)
  // and is available as a Docker build-time ARG, so it is baked into the rewrite at
  // next build time. NestJS global prefix is "api", so the destination must include it.
  async rewrites() {
    const apiBase =
      process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
