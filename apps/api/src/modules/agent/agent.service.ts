import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";
import { AiMenuImporter } from "../menus/importers/ai-menu.importer";
import { MenuAvailabilityService } from "../inventory/menu-availability.service";
import { AuditLogService } from "../auth/services/audit-log.service";
import { AgentImageService } from "./agent-image.service";
import { AGENT_TOOLS, AGENT_TOOL_MAP } from "./agent.tools";
import { WRITE_TOOL_DEFS, WRITE_TOOL_NAMES } from "./agent.write";

// ── Admin business co-pilot (Phase 2 — read + confirmed writes) ─────────────
//
// A Claude tool-use loop over READ tools (agent.tools.ts) and WRITE tools
// (agent.write.ts). Read tools query Prisma directly. Write tools are
// dispatched here to the SAME validated, audited services the dashboard uses —
// build a menu, edit an item, 86/un-86, publish. Every write requires the
// operator's in-chat confirmation (the tool refuses without confirmed=true)
// and is written to the audit log. There are deliberately no delete tools.

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 20;

export interface AgentChatTurn {
  role: "user" | "assistant";
  text: string;
}
export interface AgentUser {
  tenantId: string;
  userId: string;
}
interface ChatJob {
  status: "pending" | "done" | "failed";
  reply?: string;
  toolsUsed?: string[];
  error?: string;
  createdAt: number;
}
const CHAT_JOB_TTL_MS = 15 * 60_000;

const SYSTEM_PROMPT = `You are the Order Hub Admin Assistant — a co-pilot for a restaurant business owner/admin using the Order Hub platform. You can READ the business's data and, with the operator's confirmation, make CHANGES for them.

Tools:
- READ (run freely): list_brands, list_locations, list_menus, get_menu, search_products, menu_health, duplicate_products_scan, list_orders, get_order.
- WRITE (require confirmation): build_menu (create a whole menu with categories, items, sizes and modifier groups in one shot), update_item (edit name/description/price/availability, OR set an item's size tiers via a 'sizes' list), set_category_sizes (apply the same size tiers to EVERY item in a section — the right tool for "give all pizzas 10\"/12\" sizes"), add_modifier_group_to_category (create ONE shared modifier group and attach it to every item in a section — the right tool for "add a crust choice and extra toppings to all pizzas"; options can price per-size via pricesBySize), add_modifier_group_to_item (same for one item), snooze_item / unsnooze_item (86 / un-86), publish_menu, generate_item_image (AI photo for one item), generate_menu_images (AI photos for a whole menu, background — say roughly how many and that it costs a little per image before confirming).

For a big multi-part request (e.g. sizes + two modifier groups across a whole section), do it step by step with the bulk tools: set_category_sizes first, then add_modifier_group_to_category for each group. Confirm the whole plan once up front, then carry it out.

How to make changes SAFELY — always follow this:
1. Use read tools to gather the real facts first (ids, current values).
2. Describe EXACTLY what you're about to change — names, prices, counts, which brand/location — in plain language, and ASK the operator to confirm.
3. Only after they clearly say yes, call the write tool with "confirmed": true. Never set confirmed=true on your own initiative. If you call a write tool without confirmation it will refuse.
4. To build a menu, construct the ENTIRE structure and call build_menu ONCE — never create items one at a time. Group shared options (sauces, toppings) into modifierGroups and reference them from items by key.

Rules:
- Never invent products, prices, ids, or order details — look them up.
- Prices are GBP, plain numbers (9.99). VARIANT modifier = pick one; ADDON = pick several.
- Be concise and concrete. After a successful change, briefly confirm what was done and any next step (e.g. "created — want me to publish it?").
- If something is outside what the tools can do, say so plainly rather than pretending.`;

/** Turn a [{name, price}] size list into the updateItem fields that make an
 *  item multi-size. `plu` per size follows the HubRise publish convention
 *  (`<itemId>_sku_<i>`) so a later publish/86 targets the right ref. */
function sizesToItemDto(
  itemId: string,
  sizes: Array<{ name?: string; price?: number }>,
): Record<string, unknown> {
  const clean = (sizes ?? []).filter((s) => s && String(s.name ?? "").trim());
  const productSkus = clean.map((s, i) => ({
    name: String(s.name).trim(),
    price: Number(s.price) || 0,
    plu: `${itemId}_sku_${i}`,
  }));
  const basePrice = productSkus.length
    ? Math.min(...productSkus.map((s) => s.price))
    : 0;
  return {
    hasMultipleSkus: productSkus.length > 1,
    productSkus,
    basePrice,
  };
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;
  private readonly chatJobs = new Map<string, ChatJob>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly menuImporter: AiMenuImporter,
    private readonly availability: MenuAvailabilityService,
    private readonly audit: AuditLogService,
    private readonly images: AgentImageService,
  ) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.model = this.config.get<string>("AGENT_MODEL") ?? DEFAULT_MODEL;
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — admin agent disabled");
    }
  }

  get configured(): boolean {
    return !!this.anthropic;
  }

  /**
   * Start a chat turn as a BACKGROUND job and return a jobId to poll. A complex
   * request (e.g. sizing/adding modifiers to 40+ items) can run well past the
   * ~60s proxy timeout — running it inline made the browser show "Something
   * went wrong" even though the work was still going. Now the HTTP request
   * returns instantly and the client polls getChatJob.
   */
  startChat(user: AgentUser, history: AgentChatTurn[]): string {
    if (!this.anthropic) {
      throw new BadRequestException(
        "The admin assistant isn't configured (missing ANTHROPIC_API_KEY).",
      );
    }
    if (!Array.isArray(history) || history.length === 0) {
      throw new BadRequestException("Send at least one message.");
    }
    const jobId = randomBytes(12).toString("hex");
    this.chatJobs.set(jobId, { status: "pending", createdAt: Date.now() });
    void this.runChat(user, history)
      .then((r) =>
        this.chatJobs.set(jobId, { status: "done", ...r, createdAt: Date.now() }),
      )
      .catch((err: unknown) => {
        const e = err as { message?: string };
        this.logger.warn(`agent chat job failed: ${e?.message}`);
        this.chatJobs.set(jobId, {
          status: "failed",
          error: e?.message ?? "The assistant hit an error.",
          createdAt: Date.now(),
        });
      });
    this.sweepChatJobs();
    return jobId;
  }

  getChatJob(jobId: string): ChatJob | null {
    this.sweepChatJobs();
    return this.chatJobs.get(jobId) ?? null;
  }

  private sweepChatJobs(): void {
    const now = Date.now();
    for (const [id, j] of this.chatJobs) {
      if (now - j.createdAt > CHAT_JOB_TTL_MS) this.chatJobs.delete(id);
    }
  }

  private async runChat(
    user: AgentUser,
    history: AgentChatTurn[],
  ): Promise<{ reply: string; toolsUsed: string[] }> {
    if (!this.anthropic) {
      throw new BadRequestException("The admin assistant isn't configured.");
    }

    const messages: Anthropic.MessageParam[] = history
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => ({
        role: t.role === "assistant" ? "assistant" : "user",
        content: t.text,
      }));

    const tools: Anthropic.Tool[] = [
      ...AGENT_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
      ...WRITE_TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as unknown as Anthropic.Tool.InputSchema,
      })),
    ];

    const toolsUsed: string[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { reply: text || "I couldn't produce a reply — try rephrasing.", toolsUsed };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        toolsUsed.push(call.name);
        const input = (call.input ?? {}) as Record<string, any>;
        let content: string;
        try {
          const out = WRITE_TOOL_NAMES.has(call.name)
            ? await this.runWrite(user, call.name, input)
            : await this.runRead(user.tenantId, call.name, input);
          content = JSON.stringify(out).slice(0, 60_000);
        } catch (err) {
          const e = err as Error;
          this.logger.warn(`agent tool ${call.name} failed: ${e.message}`);
          content = JSON.stringify({ error: e.message ?? "tool failed" });
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content });
      }
      messages.push({ role: "user", content: results });
    }
    return { reply: "That needed too many steps — try something more specific.", toolsUsed };
  }

  private async runRead(tenantId: string, name: string, input: Record<string, any>) {
    const tool = AGENT_TOOL_MAP[name];
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool.run(this.prisma, tenantId, input);
  }

  // ── Write dispatch — every branch: confirm-gate → validated service → audit ──
  private async runWrite(user: AgentUser, name: string, input: Record<string, any>) {
    // Hard confirmation gate. The model must have set confirmed=true (which it
    // is instructed to do only after the operator agrees in chat).
    if (input.confirmed !== true) {
      return {
        needsConfirmation: true,
        message:
          "Not applied — describe the change to the operator and get an explicit 'yes', then call again with confirmed=true.",
      };
    }
    const { tenantId, userId } = user;

    switch (name) {
      case "build_menu": {
        const draft = {
          menuName: input.menuName,
          categories: input.categories ?? [],
          modifierGroups: input.modifierGroups ?? [],
        };
        const res = await this.menuImporter.commit({
          tenantId,
          brandId: input.brandId,
          menuName: input.menuName,
          menuType: input.menuType,
          locationId: input.locationId,
          draft: draft as any,
        });
        await this.record(user, "agent.menu.build", "menu", (res as any)?.menuId, {
          menuName: input.menuName,
          brandId: input.brandId,
          categories: (input.categories ?? []).length,
        });
        return res;
      }
      case "update_item": {
        const dto: Record<string, any> = {};
        for (const k of ["name", "description", "basePrice", "isAvailable", "imageUrl"]) {
          if (input[k] !== undefined) dto[k] = input[k];
        }
        // Size tiers convert the item to multi-size (base price = cheapest).
        if (Array.isArray(input.sizes) && input.sizes.length) {
          Object.assign(dto, sizesToItemDto(input.itemId, input.sizes));
        }
        const res = await this.menus.updateItem(input.itemId, tenantId, dto as any);
        await this.record(user, "agent.item.update", "menuItem", input.itemId, dto);
        return { ok: true, item: { id: (res as any)?.id, name: (res as any)?.name } };
      }
      case "set_category_sizes": {
        if (!Array.isArray(input.sizes) || input.sizes.length === 0) {
          return { error: "Provide at least one size." };
        }
        // Find the category within a tenant-owned menu, then apply the same
        // size tiers to every item in it. One bulk call — the agent never
        // loops per item. updateItem re-checks tenant ownership per item.
        const cat = await (this.prisma as any).menuCategory.findFirst({
          where: {
            menuId: input.menuId,
            name: { equals: String(input.categoryName), mode: "insensitive" },
            menu: { brand: { tenantId } },
          },
          select: { id: true, name: true, items: { select: { itemId: true } } },
        });
        if (!cat) return { error: `No category named "${input.categoryName}" in that menu.` };
        const itemIds: string[] = cat.items.map((i: any) => i.itemId);
        let updated = 0;
        for (const itemId of itemIds) {
          try {
            await this.menus.updateItem(
              itemId,
              tenantId,
              sizesToItemDto(itemId, input.sizes) as any,
            );
            updated++;
          } catch (e) {
            this.logger.warn(`set_category_sizes: item ${itemId} failed: ${(e as Error).message}`);
          }
        }
        await this.record(user, "agent.category.sizes", "menuCategory", cat.id, {
          menuId: input.menuId,
          category: cat.name,
          sizes: input.sizes,
          itemsUpdated: updated,
        });
        return { ok: true, category: cat.name, itemsUpdated: updated, itemsTotal: itemIds.length };
      }
      case "snooze_item": {
        await this.availability.snooze({
          itemId: input.itemId,
          tenantId,
          userId,
          channel: (input.channel ?? "ALL") as any,
          locationId: input.locationId,
        });
        await this.record(user, "agent.item.snooze", "menuItem", input.itemId, {
          channel: input.channel ?? "ALL",
          locationId: input.locationId ?? null,
        });
        return { ok: true };
      }
      case "unsnooze_item": {
        await this.availability.unsnooze({
          itemId: input.itemId,
          tenantId,
          channel: (input.channel ?? "ALL") as any,
          locationId: input.locationId,
        });
        await this.record(user, "agent.item.unsnooze", "menuItem", input.itemId, {
          channel: input.channel ?? "ALL",
          locationId: input.locationId ?? null,
        });
        return { ok: true };
      }
      case "publish_menu": {
        const res = await this.menus.publish(input.menuId, tenantId, userId);
        await this.record(user, "agent.menu.publish", "menu", input.menuId, {});
        return { ok: true, status: (res as any)?.status ?? "PUBLISHED" };
      }
      case "add_modifier_group_to_item": {
        const item = await (this.prisma as any).menuItem.findFirst({
          where: { id: input.itemId, brand: { tenantId } },
          select: { id: true, brandId: true, locationId: true, menuIds: true },
        });
        if (!item) return { error: "Item not found for this business." };
        const groupId = await this.createGroupWithOptions(tenantId, item.brandId, input.group, item.menuIds, item.locationId);
        await this.menus.linkModifierGroupToItem(input.itemId, groupId, tenantId);
        await this.record(user, "agent.item.modifiers", "menuItem", input.itemId, { group: input.group?.name });
        return { ok: true, groupId, itemsLinked: 1 };
      }
      case "add_modifier_group_to_category": {
        const cat = await (this.prisma as any).menuCategory.findFirst({
          where: {
            menuId: input.menuId,
            name: { equals: String(input.categoryName), mode: "insensitive" },
            menu: { brand: { tenantId } },
          },
          select: {
            id: true, name: true,
            menu: { select: { brandId: true, locationId: true } },
            items: { select: { itemId: true } },
          },
        });
        if (!cat) return { error: `No category named "${input.categoryName}" in that menu.` };
        const itemIds: string[] = cat.items.map((i: any) => i.itemId);
        // ONE shared group, linked to every item — not one group per item.
        const groupId = await this.createGroupWithOptions(
          tenantId, cat.menu.brandId, input.group, [input.menuId], cat.menu.locationId,
        );
        let linked = 0;
        for (const itemId of itemIds) {
          try {
            await this.menus.linkModifierGroupToItem(itemId, groupId, tenantId);
            linked++;
          } catch {
            /* already linked — tolerate */
          }
        }
        await this.record(user, "agent.category.modifiers", "menuCategory", cat.id, {
          menuId: input.menuId, category: cat.name, group: input.group?.name, itemsLinked: linked,
        });
        return { ok: true, groupId, category: cat.name, itemsLinked: linked, itemsTotal: itemIds.length };
      }
      case "generate_item_image": {
        const res = await this.images.generateForItem(tenantId, input.itemId, input.styleHint);
        if (res.ok) {
          await this.record(user, "agent.item.image", "menuItem", input.itemId, {});
        }
        return res;
      }
      case "generate_menu_images": {
        const res = this.images.startBulkForMenu(
          tenantId,
          input.menuId,
          input.onlyMissing !== false,
          input.styleHint,
        );
        if ("jobId" in res) {
          await this.record(user, "agent.menu.images", "menu", input.menuId, {
            onlyMissing: input.onlyMissing !== false,
          });
          return {
            started: true,
            message:
              "Generating photos in the background — they'll appear on the items over the next few minutes.",
          };
        }
        return res;
      }
      default:
        throw new Error(`Unknown write tool ${name}`);
    }
  }

  /** Create a modifier group + its options (flat price or per-size pricesBySize)
   *  and return the new group id. Options with pricesBySize keep a flat
   *  priceAdjustment of the smallest size price as a sensible fallback. */
  private async createGroupWithOptions(
    tenantId: string,
    brandId: string,
    group: any,
    menuIds: string[],
    locationId?: string | null,
  ): Promise<string> {
    const created = await this.menus.createModifierGroup(brandId, tenantId, {
      name: group.name,
      selectionType: group.selectionType === "ADDON" ? "ADDON" : "VARIANT",
      minSelections: typeof group.minSelections === "number" ? group.minSelections : undefined,
      maxSelections: typeof group.maxSelections === "number" ? group.maxSelections : undefined,
      isRequired: (group.minSelections ?? 0) >= 1,
      menuIds: menuIds ?? [],
      ...(locationId ? { locationId } : {}),
    });
    const groupId = (created as any).id;
    for (const opt of group.options ?? []) {
      if (!opt?.name) continue;
      const pricesBySize =
        opt.pricesBySize && typeof opt.pricesBySize === "object" ? opt.pricesBySize : undefined;
      const flat =
        typeof opt.price === "number"
          ? opt.price
          : pricesBySize
            ? Math.min(...Object.values(pricesBySize).map((v) => Number(v) || 0))
            : 0;
      await this.menus.addModifierOption(groupId, tenantId, {
        name: String(opt.name),
        priceAdjustment: flat,
        ...(pricesBySize ? { pricesBySize } : {}),
      });
    }
    return groupId;
  }

  private async record(
    user: AgentUser,
    event: string,
    resource: string,
    resourceId: string | undefined,
    meta: Record<string, unknown>,
  ) {
    try {
      await this.audit.log({
        tenantId: user.tenantId,
        userId: user.userId,
        event,
        resource,
        resourceId,
        meta: { ...meta, via: "admin-agent" },
      });
    } catch {
      /* audit must never block the action */
    }
  }
}
