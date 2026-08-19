import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

// ── Enums (mirror schema until prisma generate runs with v4 schema) ───────────

export enum StockMovementType {
  PURCHASE = "PURCHASE",
  SALE_DEDUCTION = "SALE_DEDUCTION",
  WASTE = "WASTE",
  ADJUSTMENT = "ADJUSTMENT",
  TRANSFER_IN = "TRANSFER_IN",
  TRANSFER_OUT = "TRANSFER_OUT",
  RETURN = "RETURN",
  COUNT_CORRECTION = "COUNT_CORRECTION",
}

export enum PurchaseOrderStatus {
  DRAFT = "DRAFT",
  SUBMITTED = "SUBMITTED",
  ORDERED = "ORDERED",
  PARTIAL = "PARTIAL",
  RECEIVED = "RECEIVED",
  CANCELLED = "CANCELLED",
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface CreateSupplierDto {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface UpdateSupplierDto {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  isActive?: boolean;
}

export interface CreateIngredientDto {
  name: string;
  unit: string;
  costPerUnit: number;
  lowStockAlert: number;
  supplierId?: string;
}

export interface UpdateIngredientDto {
  name?: string;
  unit?: string;
  costPerUnit?: number;
  lowStockAlert?: number;
  supplierId?: string;
  isActive?: boolean;
}

export interface AdjustStockDto {
  quantity: number;
  type: StockMovementType;
  reason?: string;
  orderId?: string;
}

export interface UpsertRecipeDto {
  yields: number;
  ingredients: Array<{
    ingredientId: string;
    quantity: number;
  }>;
}

export interface CreatePurchaseOrderDto {
  supplierId: string;
  notes?: string;
  lines: Array<{
    ingredientId: string;
    quantity: number;
    unitCost: number;
  }>;
}

export interface ReceivePurchaseOrderDto {
  lines: Array<{
    lineId: string;
    receivedQty: number;
  }>;
}

// ── Includes ──────────────────────────────────────────────────────────────────

const INGREDIENT_INCLUDE = {
  stockLevels: true,
  supplier: { select: { id: true, name: true } },
} as const;

const RECIPE_INCLUDE = {
  ingredients: {
    include: {
      ingredient: { select: { id: true, name: true, unit: true } },
    },
  },
} as const;

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  lines: {
    include: {
      ingredient: { select: { id: true, name: true, unit: true } },
    },
  },
} as const;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  // ── Suppliers ─────────────────────────────────────────────────────────────

  async listSuppliers(tenantId: string) {
    return (this.prisma as any).supplier.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: "asc" },
    });
  }

  async createSupplier(tenantId: string, dto: CreateSupplierDto) {
    return (this.prisma as any).supplier.create({
      data: {
        tenantId,
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
      },
    });
  }

  async updateSupplier(supplierId: string, tenantId: string, dto: UpdateSupplierDto) {
    await this.assertSupplierAccess(supplierId, tenantId);
    return (this.prisma as any).supplier.update({
      where: { id: supplierId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  // ── Ingredients ───────────────────────────────────────────────────────────

  async listIngredients(
    tenantId: string,
    locationId: string,
    opts: { lowStockOnly?: boolean } = {},
  ) {
    const ingredients = await (this.prisma as any).ingredient.findMany({
      where: { tenantId, locationId, isActive: true },
      include: INGREDIENT_INCLUDE,
      orderBy: { name: "asc" },
    });

    if (opts.lowStockOnly) {
      return (ingredients as any[]).filter((ing) => {
        const level = (ing.stockLevels as any[]).find(
          (sl: any) => sl.locationId === locationId,
        );
        return level
          ? new Decimal(level.quantity).lte(ing.lowStockAlert)
          : true;
      });
    }

    return ingredients;
  }

  async createIngredient(tenantId: string, locationId: string, dto: CreateIngredientDto) {
    return (this.prisma as any).ingredient.create({
      data: {
        tenantId,
        locationId,
        name: dto.name,
        unit: dto.unit,
        costPerUnit: new Decimal(dto.costPerUnit),
        lowStockAlert: new Decimal(dto.lowStockAlert),
        supplierId: dto.supplierId ?? null,
      },
      include: INGREDIENT_INCLUDE,
    });
  }

  async updateIngredient(
    ingredientId: string,
    tenantId: string,
    dto: UpdateIngredientDto,
    allowedLocationIds?: string[] | null,
  ) {
    await this.assertIngredientAccess(ingredientId, tenantId, allowedLocationIds);
    return (this.prisma as any).ingredient.update({
      where: { id: ingredientId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.unit !== undefined && { unit: dto.unit }),
        ...(dto.costPerUnit !== undefined && { costPerUnit: new Decimal(dto.costPerUnit) }),
        ...(dto.lowStockAlert !== undefined && { lowStockAlert: new Decimal(dto.lowStockAlert) }),
        ...(dto.supplierId !== undefined && { supplierId: dto.supplierId }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: INGREDIENT_INCLUDE,
    });
  }

  async getLowStockIngredients(tenantId: string, locationId: string) {
    const ingredients = await (this.prisma as any).ingredient.findMany({
      where: { tenantId, locationId, isActive: true },
      include: INGREDIENT_INCLUDE,
    });

    return (ingredients as any[]).filter((ing) => {
      const level = (ing.stockLevels as any[]).find(
        (sl: any) => sl.locationId === locationId,
      );
      if (!level) return true; // no stock level = treat as zero stock
      return new Decimal(level.quantity).lte(ing.lowStockAlert);
    });
  }

  async adjustStock(
    tenantId: string,
    locationId: string,
    ingredientId: string,
    dto: AdjustStockDto,
    allowedLocationIds?: string[] | null,
  ) {
    const ingredient = await this.assertIngredientAccess(
      ingredientId,
      tenantId,
      allowedLocationIds,
    );

    const isDeduction = [
      StockMovementType.SALE_DEDUCTION,
      StockMovementType.WASTE,
      StockMovementType.TRANSFER_OUT,
    ].includes(dto.type);

    const absQty = new Decimal(dto.quantity);
    const quantityDelta = isDeduction ? absQty.negated() : absQty;

    const [, updatedLevel] = await (this.prisma as any).$transaction([
      (this.prisma as any).stockMovement.create({
        data: {
          tenantId,
          locationId,
          ingredientId,
          type: dto.type,
          quantity: absQty,
          reason: dto.reason ?? null,
          orderId: dto.orderId ?? null,
        },
      }),
      (this.prisma as any).stockLevel.upsert({
        where: { ingredientId_locationId: { ingredientId, locationId } },
        create: {
          ingredientId,
          locationId,
          quantity: quantityDelta,
        },
        update: {
          quantity: { increment: quantityDelta },
        },
      }),
    ]);

    const newQty = new Decimal((updatedLevel as any).quantity);
    const alertThreshold = new Decimal((ingredient as any).lowStockAlert);

    if (newQty.lte(alertThreshold)) {
      (this.socket as any).emitToLocation(locationId, "inventory:low-stock", {
        ingredientId,
        ingredientName: (ingredient as any).name,
        locationId,
        currentStock: newQty.toNumber(),
        lowStockAlert: alertThreshold.toNumber(),
      });

      this.logger.warn(
        `Low stock alert: ingredient ${ingredientId} at location ${locationId} — qty ${newQty.toFixed(4)}`,
      );
    }

    return updatedLevel;
  }

  // ── Recipes ───────────────────────────────────────────────────────────────

  async getRecipe(menuItemId: string, tenantId: string) {
    const recipe = await (this.prisma as any).recipe.findFirst({
      where: { menuItemId, tenantId },
      include: RECIPE_INCLUDE,
    });
    if (!recipe) throw new NotFoundException("Recipe not found for this menu item");
    return recipe;
  }

  async upsertRecipe(menuItemId: string, tenantId: string, dto: UpsertRecipeDto) {
    const existing = await (this.prisma as any).recipe.findFirst({
      where: { menuItemId, tenantId },
    });

    if (existing) {
      // Replace all RecipeIngredient rows atomically
      await (this.prisma as any).recipeIngredient.deleteMany({
        where: { recipeId: (existing as any).id },
      });

      return (this.prisma as any).recipe.update({
        where: { id: (existing as any).id },
        data: {
          yields: dto.yields,
          ingredients: {
            create: dto.ingredients.map((ri) => ({
              ingredientId: ri.ingredientId,
              quantity: new Decimal(ri.quantity),
            })),
          },
        },
        include: RECIPE_INCLUDE,
      });
    }

    return (this.prisma as any).recipe.create({
      data: {
        tenantId,
        menuItemId,
        yields: dto.yields,
        ingredients: {
          create: dto.ingredients.map((ri) => ({
            ingredientId: ri.ingredientId,
            quantity: new Decimal(ri.quantity),
          })),
        },
      },
      include: RECIPE_INCLUDE,
    });
  }

  // ── Stock deduction (called by order worker after order accepted) ──────────

  async deductStockForOrder(
    orderId: string,
    tenantId: string,
    locationId: string,
  ): Promise<Array<{ ingredientId: string; deducted: number; newQuantity: number }>> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        items: {
          select: {
            id: true,
            menuItemId: true,
            quantity: true,
            name: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const summary: Array<{ ingredientId: string; deducted: number; newQuantity: number }> = [];

    for (const item of order.items) {
      if (!item.menuItemId) continue;

      const recipe = await (this.prisma as any).recipe.findFirst({
        where: { menuItemId: item.menuItemId, tenantId },
        include: { ingredients: true },
      });
      if (!recipe) continue;

      for (const ri of (recipe as any).ingredients) {
        const deductQty = new Decimal(ri.quantity).mul(item.quantity);

        const [, updatedLevel] = await (this.prisma as any).$transaction([
          (this.prisma as any).stockMovement.create({
            data: {
              tenantId,
              locationId,
              ingredientId: ri.ingredientId,
              type: StockMovementType.SALE_DEDUCTION,
              quantity: deductQty,
              orderId,
              reason: `Order ${orderId} — ${item.name} x${item.quantity}`,
            },
          }),
          (this.prisma as any).stockLevel.upsert({
            where: {
              ingredientId_locationId: {
                ingredientId: ri.ingredientId,
                locationId,
              },
            },
            create: {
              ingredientId: ri.ingredientId,
              locationId,
              quantity: deductQty.negated(),
            },
            update: {
              quantity: { decrement: deductQty },
            },
          }),
        ]);

        const newQty = new Decimal((updatedLevel as any).quantity);

        summary.push({
          ingredientId: ri.ingredientId,
          deducted: deductQty.toNumber(),
          newQuantity: newQty.toNumber(),
        });

        // If stock drops to 0 or below, mark tracked menu item unavailable
        if (newQty.lte(0)) {
          const menuItem = await this.prisma.menuItem.findUnique({
            where: { id: item.menuItemId },
            select: { isInventoryTracked: true },
          });
          if ((menuItem as any)?.isInventoryTracked) {
            await this.setMenuItemUnavailable(item.menuItemId);
            this.logger.warn(
              `Menu item ${item.menuItemId} marked unavailable — ingredient ${ri.ingredientId} out of stock`,
            );
          }
        }
      }
    }

    return summary;
  }

  // ── Purchase Orders ───────────────────────────────────────────────────────

  async listPurchaseOrders(
    tenantId: string,
    locationId: string,
    status?: PurchaseOrderStatus,
  ) {
    return (this.prisma as any).purchaseOrder.findMany({
      where: {
        tenantId,
        locationId,
        ...(status && { status }),
      },
      include: PO_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  async createPurchaseOrder(
    tenantId: string,
    locationId: string,
    dto: CreatePurchaseOrderDto,
  ) {
    const totalCost = dto.lines.reduce(
      (acc, line) => acc.add(new Decimal(line.unitCost).mul(line.quantity)),
      new Decimal(0),
    );

    return (this.prisma as any).purchaseOrder.create({
      data: {
        tenantId,
        locationId,
        supplierId: dto.supplierId,
        status: PurchaseOrderStatus.DRAFT,
        totalCost,
        notes: dto.notes ?? null,
        lines: {
          create: dto.lines.map((line) => ({
            ingredientId: line.ingredientId,
            quantity: new Decimal(line.quantity),
            unitCost: new Decimal(line.unitCost),
            totalCost: new Decimal(line.unitCost).mul(line.quantity),
          })),
        },
      },
      include: PO_INCLUDE,
    });
  }

  async submitPurchaseOrder(
    poId: string,
    tenantId: string,
    allowedLocationIds?: string[] | null,
  ) {
    const po = await this.assertPurchaseOrderAccess(poId, tenantId, allowedLocationIds);

    if ((po as any).status !== PurchaseOrderStatus.DRAFT) {
      throw new BadRequestException("Only DRAFT purchase orders can be submitted");
    }

    return (this.prisma as any).purchaseOrder.update({
      where: { id: poId },
      data: {
        status: PurchaseOrderStatus.SUBMITTED,
        orderedAt: new Date(),
      },
      include: PO_INCLUDE,
    });
  }

  async receivePurchaseOrder(
    poId: string,
    tenantId: string,
    dto: ReceivePurchaseOrderDto,
    allowedLocationIds?: string[] | null,
  ) {
    const po = await (this.prisma as any).purchaseOrder.findFirst({
      where: {
        id: poId,
        tenantId,
        ...(allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {}),
      },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");

    if (
      (po as any).status === PurchaseOrderStatus.RECEIVED ||
      (po as any).status === PurchaseOrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot receive a purchase order with status ${(po as any).status}`,
      );
    }

    for (const lineUpdate of dto.lines) {
      const poLine = ((po as any).lines as any[]).find(
        (l: any) => l.id === lineUpdate.lineId,
      );
      if (!poLine) continue;

      const receivedQty = new Decimal(lineUpdate.receivedQty);
      if (receivedQty.lte(0)) continue;

      await (this.prisma as any).$transaction([
        (this.prisma as any).purchaseOrderLine.update({
          where: { id: lineUpdate.lineId },
          data: { receivedQty },
        }),
        (this.prisma as any).stockMovement.create({
          data: {
            tenantId,
            locationId: (po as any).locationId,
            ingredientId: poLine.ingredientId,
            type: StockMovementType.PURCHASE,
            quantity: receivedQty,
            purchaseOrderId: poId,
            reason: `Purchase order ${poId} received`,
          },
        }),
        (this.prisma as any).stockLevel.upsert({
          where: {
            ingredientId_locationId: {
              ingredientId: poLine.ingredientId,
              locationId: (po as any).locationId,
            },
          },
          create: {
            ingredientId: poLine.ingredientId,
            locationId: (po as any).locationId,
            quantity: receivedQty,
          },
          update: {
            quantity: { increment: receivedQty },
          },
        }),
      ]);
    }

    // Determine final status
    const updatedLines = await (this.prisma as any).purchaseOrderLine.findMany({
      where: { purchaseOrderId: poId },
    });

    const allReceived = (updatedLines as any[]).every(
      (l: any) =>
        l.receivedQty !== null &&
        new Decimal(l.receivedQty).gte(l.quantity),
    );

    const newStatus = allReceived
      ? PurchaseOrderStatus.RECEIVED
      : PurchaseOrderStatus.PARTIAL;

    return (this.prisma as any).purchaseOrder.update({
      where: { id: poId },
      data: {
        status: newStatus,
        ...(allReceived && { receivedAt: new Date() }),
      },
      include: PO_INCLUDE,
    });
  }

  // ── Menu Item Availability Sync ───────────────────────────────────────────

  async syncMenuItemAvailability(tenantId: string, locationId: string) {
    const trackedItems = await (this.prisma as any).menuItem.findMany({
      where: {
        isInventoryTracked: true,
        menu: { tenantId },
      },
      select: { id: true, isAvailable: true },
    });

    const results: Array<{ menuItemId: string; isAvailable: boolean }> = [];

    for (const item of trackedItems as any[]) {
      const recipe = await (this.prisma as any).recipe.findFirst({
        where: { menuItemId: item.id, tenantId },
        include: { ingredients: true },
      });

      if (!recipe || !(recipe as any).ingredients.length) continue;

      let canFulfill = true;
      for (const ri of (recipe as any).ingredients) {
        const level = await (this.prisma as any).stockLevel.findUnique({
          where: {
            ingredientId_locationId: {
              ingredientId: ri.ingredientId,
              locationId,
            },
          },
        });

        if (!level || new Decimal((level as any).quantity).lte(0)) {
          canFulfill = false;
          break;
        }
      }

      if (item.isAvailable !== canFulfill) {
        await (this.prisma as any).menuItem.update({
          where: { id: item.id },
          data: { isAvailable: canFulfill },
        });
        results.push({ menuItemId: item.id, isAvailable: canFulfill });
      }
    }

    this.logger.log(
      `Synced menu availability for tenant ${tenantId} @ location ${locationId}: ${results.length} items updated`,
    );

    return results;
  }

  async setMenuItemUnavailable(menuItemId: string) {
    return this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: { isAvailable: false },
      select: { id: true, name: true, isAvailable: true },
    });
  }

  async setMenuItemAvailable(menuItemId: string) {
    return this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: { isAvailable: true },
      select: { id: true, name: true, isAvailable: true },
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async assertSupplierAccess(supplierId: string, tenantId: string) {
    const supplier = await (this.prisma as any).supplier.findFirst({
      where: { id: supplierId, tenantId },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");
    return supplier;
  }

  /**
   * `allowedLocationIds` is the caller's location allowlist, or null/undefined
   * for a tenant-wide role. Applying it here covers every id-addressed
   * ingredient route at once — otherwise a staff member who can no longer SEE
   * another shop's ingredients in a list could still PATCH one by reusing an id.
   */
  private async assertIngredientAccess(
    ingredientId: string,
    tenantId: string,
    allowedLocationIds?: string[] | null,
  ) {
    const ingredient = await (this.prisma as any).ingredient.findFirst({
      where: {
        id: ingredientId,
        tenantId,
        ...(allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {}),
      },
    });
    if (!ingredient) throw new NotFoundException("Ingredient not found");
    return ingredient;
  }

  private async assertPurchaseOrderAccess(
    poId: string,
    tenantId: string,
    allowedLocationIds?: string[] | null,
  ) {
    const po = await (this.prisma as any).purchaseOrder.findFirst({
      where: {
        id: poId,
        tenantId,
        ...(allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {}),
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }
}
