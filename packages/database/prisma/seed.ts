// @prisma/client is a stub when a custom generator output is used.
// The generated client lives at packages/database/generated/prisma/ — import directly.
import { PrismaClient } from "../generated/prisma";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Order Hub Solutions database...");

  // ── Platform Tenant (system — required for PLATFORM_ADMIN) ───────────────
  const platformTenant = await prisma.tenant.upsert({
    where: { slug: "orderhub-platform" },
    update: {},
    create: {
      name: "Order Hub Platform",
      slug: "orderhub-platform",
      plan: "PROFESSIONAL",
      status: "ACTIVE",
    },
  });

  // ── Platform Admin User ───────────────────────────────────────────────────
  // Password intentionally documented in STAGING_LOGIN.md — rotate after first login.
  const platformAdminPassword = await bcrypt.hash("Admin!OrderHub2026", 12);
  const platformAdmin = await prisma.user.upsert({
    where: { email: "admin@orderhub.io" },
    update: {},
    create: {
      tenantId: platformTenant.id,
      email: "admin@orderhub.io",
      password: platformAdminPassword,
      firstName: "Platform",
      lastName: "Admin",
      role: "PLATFORM_ADMIN",
      isActive: true,
    },
  });

  // ── Demo Tenant ───────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-restaurant-group" },
    update: {},
    create: {
      name: "Demo Restaurant Group",
      slug: "demo-restaurant-group",
      plan: "PROFESSIONAL",
      status: "ACTIVE",
    },
  });

  // ── Demo Tenant Owner ─────────────────────────────────────────────────────
  const demoPassword = await bcrypt.hash("Demo1234!", 12);
  await prisma.user.upsert({
    where: { email: "admin@demo.orderhub.io" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@demo.orderhub.io",
      password: demoPassword,
      firstName: "Demo",
      lastName: "Admin",
      role: "TENANT_OWNER",
      isActive: true,
    },
  });

  // ── Brand ─────────────────────────────────────────────────────────────────
  const brand = await prisma.brand.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "burger-co" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Burger Co",
      slug: "burger-co",
      isActive: true,
    },
  });

  // ── Location ──────────────────────────────────────────────────────────────
  const location = await prisma.location.upsert({
    where: { id: "loc_demo_001" },
    update: {},
    create: {
      id: "loc_demo_001",
      brandId: brand.id,
      name: "Burger Co — London Bridge",
      address: {
        line1: "1 London Bridge St",
        city: "London",
        postcode: "SE1 9BG",
        country: "GB",
      },
      timezone: "Europe/London",
      isActive: true,
    },
  });

  // ── Menu ──────────────────────────────────────────────────────────────────
  const menu = await prisma.menu.upsert({
    where: { id: "menu_demo_001" },
    update: {},
    create: {
      id: "menu_demo_001",
      brandId: brand.id,
      name: "Main Menu",
      isActive: true,
    },
  });

  // Use upsert-by-id so repeated seed runs don't create duplicate categories/items
  const category = await prisma.menuCategory.upsert({
    where: { id: "cat_demo_001" },
    update: {},
    create: {
      id: "cat_demo_001",
      menuId: menu.id,
      name: "Burgers",
      sortOrder: 1,
    },
  });

  const item = await prisma.menuItem.upsert({
    where: { id: "item_demo_001" },
    update: {},
    create: {
      id: "item_demo_001",
      brandId: brand.id,
      name: "Classic Cheeseburger",
      description: "Two beef patties, American cheese, pickles, onion, ketchup.",
      basePrice: 10.95,
      isAvailable: true,
      allergens: ["GLUTEN", "DAIRY", "SESAME"],
    },
  });

  await prisma.menuItemOnCategory.upsert({
    where: { categoryId_itemId: { categoryId: category.id, itemId: item.id } },
    update: {},
    create: { categoryId: category.id, itemId: item.id, sortOrder: 1 },
  });

  console.log(`
✓ Order Hub Solutions — seed complete

  Platform Admin:
    Email:    ${platformAdmin.email}
    Password: Admin!OrderHub2026  ← rotate immediately after first login
    Role:     PLATFORM_ADMIN

  Demo Tenant:
    Tenant:   ${tenant.name} (${tenant.slug})
    Location: ${location.name}
    Email:    admin@demo.orderhub.io
    Password: Demo1234!
  `);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
