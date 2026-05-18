import { PrismaClient } from "../generated/prisma";

// Singleton pattern: prevent multiple PrismaClient instances in dev
// due to hot-module reload creating new connections on each file change.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export everything from the generated client so consumers
// only need to import from @orderhub/database.
export * from "../generated/prisma";
export type { Prisma } from "../generated/prisma";
