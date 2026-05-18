import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Order Hub Solutions database...");

  // ── Tenant ────────────────────────────────────────────
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

  // ── Admin User ────────────────────────────────────────
  const password = await bcrypt.hash("Demo1234!", 12);
  await prisma.user.upsert({
    where: { email: "admin@demo.orderhub.io" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@demo.orderhub.io",
      password,
      firstName: "Demo",
      lastName: "Admin",
      role: "TENANT_OWNER",
      isActive: true,
    },
  });

  // ── Brand ──────────────────────────────────────────────
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

  // ── Location ───────────────────────────────────────────
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

  // ── Menu ───────────────────────────────────────────────
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

  const category = await prisma.menuCategory.create({
    data: {
      menuId: menu.id,
      name: "Burgers",
      sortOrder: 1,
    },
  });

  const item = await prisma.menuItem.create({
    data: {
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
  Tenant:   ${tenant.name} (${tenant.slug})
  Location: ${location.name}
  Login:    admin@demo.orderhub.io / Demo1234!
  `);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
