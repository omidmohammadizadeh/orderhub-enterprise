#!/usr/bin/env ts-node
/**
 * bootstrap-admin.ts
 *
 * Creates the system platform tenant and PLATFORM_ADMIN user.
 * Safe to run multiple times — all operations are idempotent (upsert).
 *
 * Usage (from repo root):
 *   DATABASE_URL=<url> pnpm seed:admin
 *
 * Or directly:
 *   DATABASE_URL=<url> npx tsx apps/api/src/scripts/bootstrap-admin.ts
 *
 * On Render: open the API service Shell tab and run:
 *   DATABASE_URL=$DATABASE_URL npx tsx apps/api/src/scripts/bootstrap-admin.ts
 *
 * Environment:
 *   DATABASE_URL   — required, Postgres connection string
 *   ADMIN_EMAIL    — optional override (default: admin@orderhub.io)
 *   ADMIN_PASSWORD — optional override (default: Admin!OrderHub2026)
 *                    ROTATE THIS after first login in production.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@orderhub.io";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin!OrderHub2026";
const PLATFORM_SLUG = "orderhub-platform";

async function bootstrap() {
  console.log("OrderHub — Platform Admin Bootstrap");
  console.log("=====================================");

  if (!process.env.DATABASE_URL) {
    console.error("❌  DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }

  // ── 1. System platform tenant ─────────────────────────────────────────────
  console.log(`\n[1/2] Upserting system tenant (slug: ${PLATFORM_SLUG})...`);
  const platformTenant = await prisma.tenant.upsert({
    where: { slug: PLATFORM_SLUG },
    update: {},
    create: {
      name: "Order Hub Platform",
      slug: PLATFORM_SLUG,
      plan: "PROFESSIONAL",
      status: "ACTIVE",
    },
  });
  console.log(`      ✓ Tenant: ${platformTenant.name} (id: ${platformTenant.id})`);

  // ── 2. PLATFORM_ADMIN user ────────────────────────────────────────────────
  console.log(`\n[2/2] Upserting PLATFORM_ADMIN (email: ${ADMIN_EMAIL})...`);

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    console.log(`      ✓ User already exists (id: ${existing.id}) — no changes made.`);
    console.log("      ℹ  To reset the password, delete the user and re-run this script,");
    console.log("         or use the platform admin UI once logged in.");
  } else {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const admin = await prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: ADMIN_EMAIL,
        password: passwordHash,
        firstName: "Platform",
        lastName: "Admin",
        role: "PLATFORM_ADMIN",
        isActive: true,
      },
    });
    console.log(`      ✓ Created PLATFORM_ADMIN user (id: ${admin.id})`);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Bootstrap complete

  Login URL: https://orderhub-web.onrender.com/login
  Email:     ${ADMIN_EMAIL}
  Password:  ${existing ? "(unchanged — was already set)" : ADMIN_PASSWORD}

  ⚠️  Rotate the password after first login.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

bootstrap()
  .catch((err) => {
    console.error("\n❌  Bootstrap failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
