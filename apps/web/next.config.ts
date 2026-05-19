import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles the server into a single self-contained directory.
  // Required by infrastructure/docker/Dockerfile.web which copies .next/standalone.
  // Also used by Render/Railway Docker deployments.
  output: "standalone",

  // Turborepo-friendly transpilation of workspace packages
  transpilePackages: ["@orderhub/shared", "@orderhub/ui"],

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

  // Rewrites so the frontend proxies /api/* to the NestJS service in dev
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL ?? "http://localhost:4000"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
