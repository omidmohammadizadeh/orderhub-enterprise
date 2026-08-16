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
- WRITE (require confirmation): build_menu (create a whole menu with categories, items, sizes and modifier groups in one shot), update_item (edit name/description/price/availability, OR set an item's size tiers via a 'sizes' list), set_category_sizes (apply the same size tiers to EVERY item in a section — the right tool for "give all pizzas 10\"/12\" sizes"), add_modifier_group_to_category (create ONE shared modifier group and attach it to every item in a section — the right tool for "add a crust choice and extra toppings to all pizzas"; options can price per-size via pricesBySize), add_modifier_group_to_item (same for one item), snooze_item / unsnooze_item (86 / un-86), publish_menu, generate_item_image (AI photo for one item), generate_menu_images (AI photos for a whole menu, background — say roughly how many and that it costs a little per image before confirming).\nBULK PRICING: to set one price across a whole section (\"make all pizzas £7.80\") use set_category_prices — ONE call. Never loop update_item per item for that: a 50-item section will exhaust the step budget and you will stop half-done. If a job genuinely needs more steps than you have, say so plainly and say what you already changed — never say you are applying something you have not applied.

For a big multi-part request (e.g. sizes + two modifier groups across a whole section), do it step by step with the bulk tools: set_category_sizes FIRST (this defines the sizes), THEN add_modifier_group_to_category for each group (modifier groups attach onto the existing sizes). Confirm the whole plan once up front, then carry it out. get_menu now shows each item's sizes and modifierGroups (names) — use it to verify your work and to spot duplicates. Adding a group is idempotent (an item that already has a same-named group is skipped), and remove_modifier_group_from_category clears duplicates. If you ever see the same group name twice on items, remove it then add it once.

Per-size modifier groups: for a MULTI-SIZE item, each size (SKU) gets its OWN separate modifier group — 10" and 12" never share a group, so they price independently. When you add a group to a sized item/section, express per-size prices with pricesBySize keyed by the exact size name (e.g. {"10\"": 2.5, "12\"": 3}); the tool creates a dedicated group per size at that price. If you give a flat price instead, every size uses it.

To change the PRICE of options on a group that ALREADY exists, use set_modifier_prices — do NOT remove and re-add. It edits in place: pass sizePrices keyed by the exact size name to change just one size (e.g. {"12\"": 3} makes only the 12" stuffed crust £3, leaving 10" alone), or a flat price to change every size, or allOptions to price every option in the group the same. Before calling it, run get_menu to read the group's option names and each item's exact size-name strings.

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
    // Ran out of tool iterations. The old message was vague and, worse, the
    // model's LAST turn was usually a promise ("applying it now") that never
    // happened — an operator reasonably read that as done. Say plainly that
    // it did NOT finish, and name the writes that DID land so a partial
    // change is never mistaken for a complete one.
    const writesRun = toolsUsed.filter((t) => WRITE_TOOL_NAMES.has(t));
    const changed = writesRun.length
      ? ` I did make these changes before stopping: ${[...new Set(writesRun)].join(", ")} — please check the menu, it may be partly updated.`
      : " Nothing was changed.";
    return {
      reply:
        "I ran out of steps before finishing, so I have NOT completed that request." +
        changed +
        " Ask me for one section at a time, or use a bulk tool (e.g. setting one price across a whole section) rather than item by item.",
      toolsUsed,
    };
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
      case "set_category_prices": {
        // Why this exists: without it, "make all 55 pizzas £7.80" needed 55
        // update_item calls, which overran MAX_TOOL_ITERATIONS. The agent
        // would orient, run out of budget, and end its turn PROMISING the
        // change instead of making it. One bulk call removes the whole
        // failure mode.
        const price = Number(input.price);
        if (!Number.isFinite(price) || price < 0) {
          return { error: "Provide a valid price." };
        }
        const pcat = await (this.prisma as any).menuCategory.findFirst({
          where: {
            menuId: input.menuId,
            name: { equals: String(input.categoryName), mode: "insensitive" },
            menu: { brand: { tenantId } },
          },
          select: { id: true, name: true, items: { select: { itemId: true } } },
        });
        if (!pcat) {
          return { error: `No category named "${input.categoryName}" in that menu.` };
        }
        const pIds: string[] = pcat.items.map((i: any) => i.itemId);
        let priced = 0;
        const failed: string[] = [];
        for (const itemId of pIds) {
          try {
            // basePrice ONLY — modifier and size pricing is untouched.
            await this.menus.updateItem(itemId, tenantId, { basePrice: price } as any);
            priced++;
          } catch (e) {
            failed.push(itemId);
            this.logger.warn(
              `set_category_prices: item ${itemId} failed: ${(e as Error).message}`,
            );
          }
        }
        await this.record(user, "agent.category.prices", "menuCategory", pcat.id, {
          category: pcat.name,
          price,
          updated: priced,
          failed: failed.length,
        });
        // Report failures explicitly — a partly-priced section that reads as
        // success is worse than an error.
        return {
          ok: true,
          category: pcat.name,
          price,
          updated: priced,
          ...(failed.length ? { failed: failed.length } : {}),
        };
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
      case "set_modifier_prices": {
        const cat = await this.loadCategoryForModifiers(tenantId, input.menuId, input.categoryName);
        if (!cat) return { error: `No category named "${input.categoryName}" in that menu.` };
        const groupNameLower = String(input.groupName).trim().toLowerCase();
        // Targeted edits by option name; allOptions is the fallback for the rest.
        const targeted = new Map<string, { price?: number; sizePrices?: Record<string, number> }>();
        for (const o of input.options ?? []) {
          if (o?.name) {
            targeted.set(String(o.name).trim().toLowerCase(), {
              price: typeof o.price === "number" ? o.price : undefined,
              sizePrices: o.sizePrices && typeof o.sizePrices === "object" ? o.sizePrices : undefined,
            });
          }
        }
        const all =
          input.allOptions && typeof input.allOptions === "object" ? input.allOptions : null;
        if (targeted.size === 0 && !all) {
          return { error: "Nothing to change — pass `options` and/or `allOptions`." };
        }

        let optionsUpdated = 0;
        let itemsTouched = 0;
        for (const itemId of cat.itemIds) {
          const item = await this.loadItemForModifiers(tenantId, itemId);
          if (!item) continue;
          // Only the groups actually attached to THIS item, with the SKU sizes
          // each one serves. A dedicated per-size group serves one size; a
          // legacy shared group serves several.
          const attached = await this.itemGroupsByName(tenantId, item, groupNameLower);
          if (!attached.length) continue;
          let touchedItem = false;
          for (const { group, sizes } of attached) {
            const shared = sizes.size > 1; // legacy: one group across many sizes
            const theSize = sizes.size === 1 ? [...sizes][0] : null;
            for (const opt of group.options ?? []) {
              const edit =
                targeted.get(String(opt.name).trim().toLowerCase()) ??
                (all ? { price: all.price, sizePrices: all.sizePrices } : null);
              if (!edit) continue;
              const dto: Record<string, any> = {};
              if (shared) {
                // Legacy shared-across-sizes group — keep per-size prices on the
                // option's pricesBySize map, merging so one size doesn't wipe
                // another. (New menus use dedicated per-size groups below.)
                if (edit.sizePrices && typeof edit.sizePrices === "object") {
                  const current =
                    opt.pricesBySize && typeof opt.pricesBySize === "object" ? opt.pricesBySize : {};
                  const merged: Record<string, number> = { ...current };
                  for (const [k, v] of Object.entries(edit.sizePrices)) merged[k] = Number(v) || 0;
                  dto.pricesBySize = merged;
                } else if (typeof edit.price === "number") {
                  dto.priceAdjustment = edit.price;
                }
              } else {
                // Dedicated per-size group (or a single-price item) — set a flat
                // price for this size and clear any stale pricesBySize.
                let p: number | undefined;
                if (edit.sizePrices && theSize && typeof edit.sizePrices[theSize] === "number") {
                  p = edit.sizePrices[theSize];
                } else if (typeof edit.price === "number") {
                  p = edit.price;
                }
                if (p !== undefined) {
                  dto.priceAdjustment = p;
                  dto.pricesBySize = {};
                }
              }
              if (Object.keys(dto).length === 0) continue;
              try {
                await this.menus.updateModifierOption(opt.id, tenantId, dto as any);
                optionsUpdated++;
                touchedItem = true;
              } catch (e) {
                this.logger.warn(`set_modifier_prices: option ${opt.id} failed: ${(e as Error).message}`);
              }
            }
          }
          if (touchedItem) itemsTouched++;
        }
        await this.record(user, "agent.modifier.prices", "menuCategory", cat.id, {
          menuId: input.menuId, category: cat.name, groupName: input.groupName, optionsUpdated, itemsTouched,
        });
        return { ok: true, groupName: input.groupName, category: cat.name, optionsUpdated, itemsTouched };
      }
      case "add_modifier_group_to_item": {
        const item = await this.loadItemForModifiers(tenantId, input.itemId);
        if (!item) return { error: "Item not found for this business." };
        const nameById = await this.brandGroupNameMap(item.brandId);
        if (this.itemHasGroupNamed(item, input.group?.name, nameById)) {
          return { ok: true, alreadyPresent: true, message: `Item already has a "${input.group?.name}" group.` };
        }
        // Multi-size items get a separate group per SKU (independent prices).
        const groupIds = await this.attachGroupToItem(tenantId, item, input.group);
        await this.record(user, "agent.item.modifiers", "menuItem", input.itemId, { group: input.group?.name });
        return { ok: true, groupIds, itemsLinked: 1 };
      }
      case "add_modifier_group_to_category": {
        const cat = await this.loadCategoryForModifiers(tenantId, input.menuId, input.categoryName);
        if (!cat) return { error: `No category named "${input.categoryName}" in that menu.` };
        const items = await Promise.all(
          cat.itemIds.map((id: string) => this.loadItemForModifiers(tenantId, id)),
        );
        const present = items.filter(Boolean) as any[];
        const nameById = await this.brandGroupNameMap(cat.brandId);
        // Idempotent: only touch items that DON'T already have a same-named
        // group (prevents the duplicate pile-up from re-running).
        const missing = present.filter(
          (it) => !this.itemHasGroupNamed(it, input.group?.name, nameById),
        );
        if (missing.length === 0) {
          return { ok: true, alreadyPresent: true, message: `Every item already has a "${input.group?.name}" group.` };
        }
        // Each item gets its OWN group(s) — and for a multi-size item, a
        // SEPARATE group per SKU, so 10" and 12" price independently and never
        // share a group id across sizes.
        let linked = 0;
        let groupsCreated = 0;
        for (const it of missing) {
          try {
            const ids = await this.attachGroupToItem(tenantId, it, input.group);
            groupsCreated += ids.length;
            linked++;
          } catch (e) {
            this.logger.warn(`attach modifier to ${it.id} failed: ${(e as Error).message}`);
          }
        }
        await this.record(user, "agent.category.modifiers", "menuCategory", cat.id, {
          menuId: input.menuId, category: cat.name, group: input.group?.name, itemsLinked: linked, groupsCreated,
        });
        return { ok: true, category: cat.name, itemsLinked: linked, groupsCreated, itemsTotal: present.length };
      }
      case "remove_modifier_group_from_category": {
        const cat = await this.loadCategoryForModifiers(tenantId, input.menuId, input.categoryName);
        if (!cat) return { error: `No category named "${input.categoryName}" in that menu.` };
        const wanted = String(input.groupName).trim().toLowerCase();
        const brandGroups = await (this.prisma as any).modifierGroup.findMany({
          where: { brandId: cat.brandId },
          select: { id: true, name: true },
        });
        const matchIds = new Set<string>(
          brandGroups.filter((g: any) => String(g.name).toLowerCase() === wanted).map((g: any) => g.id),
        );
        if (matchIds.size === 0) return { ok: true, removed: 0, message: `No group named "${input.groupName}" found.` };
        let itemsTouched = 0;
        for (const id of cat.itemIds) {
          const it = await this.loadItemForModifiers(tenantId, id);
          if (!it) continue;
          let touched = false;
          // item-level unlink
          for (const l of it.modifierGroupLinks ?? []) {
            if (matchIds.has(l.groupId)) {
              await this.menus.unlinkModifierGroupFromItem(it.id, l.groupId, tenantId).catch(() => {});
              touched = true;
            }
          }
          // per-size removal (productSkus JSON isn't FK-cascaded, so strip it)
          const skus = Array.isArray(it.productSkus) ? it.productSkus : [];
          if (skus.some((s: any) => (s.modifierGroups ?? []).some((g: string) => matchIds.has(g)))) {
            const next = skus.map((s: any) => ({
              ...s,
              modifierGroups: (s.modifierGroups ?? []).filter((g: string) => !matchIds.has(g)),
            }));
            await this.menus.updateItem(it.id, tenantId, { productSkus: next } as any).catch(() => {});
            touched = true;
          }
          if (touched) itemsTouched++;
        }
        // Delete the now-unused group rows.
        for (const id of matchIds) {
          await this.menus.removeModifierGroup(id, tenantId).catch(() => {});
        }
        await this.record(user, "agent.category.modifiers.remove", "menuCategory", cat.id, {
          menuId: input.menuId, category: cat.name, groupName: input.groupName, groupsRemoved: matchIds.size,
        });
        return { ok: true, groupsRemoved: matchIds.size, itemsTouched };
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
          input.categoryId,
        );
        if ("jobId" in res) {
          await this.record(user, "agent.menu.images", "menu", input.menuId, {
            onlyMissing: input.onlyMissing !== false,
            categoryId: input.categoryId ?? null,
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

  /** Brand ids owned by a tenant — MenuItem has only a scalar brandId (no
   *  `brand` relation), so item queries scope by brandId, not by relation. */
  private async tenantBrandIds(tenantId: string): Promise<string[]> {
    const brands = await (this.prisma as any).brand.findMany({
      where: { tenantId },
      select: { id: true },
    });
    return brands.map((b: any) => b.id);
  }

  private async loadItemForModifiers(tenantId: string, itemId: string) {
    const brandIds = await this.tenantBrandIds(tenantId);
    return (this.prisma as any).menuItem.findFirst({
      where: { id: itemId, brandId: { in: brandIds } },
      select: {
        id: true, brandId: true, locationId: true, menuIds: true,
        hasMultipleSkus: true, productSkus: true,
        modifierGroupLinks: { select: { groupId: true, group: { select: { name: true } } } },
      },
    });
  }

  private async loadCategoryForModifiers(tenantId: string, menuId: string, categoryName: string) {
    const cat = await (this.prisma as any).menuCategory.findFirst({
      where: {
        menuId,
        name: { equals: String(categoryName), mode: "insensitive" },
        menu: { brand: { tenantId } },
      },
      select: {
        id: true, name: true,
        menu: { select: { brandId: true, locationId: true } },
        items: { select: { itemId: true } },
      },
    });
    if (!cat) return null;
    return {
      id: cat.id, name: cat.name, brandId: cat.menu.brandId,
      locationId: cat.menu.locationId, itemIds: cat.items.map((i: any) => i.itemId) as string[],
    };
  }

  /** id → lowercased name for a brand's modifier groups (to resolve per-size
   *  group ids and dedupe by name). */
  private async brandGroupNameMap(brandId: string): Promise<Map<string, string>> {
    const groups = await (this.prisma as any).modifierGroup.findMany({
      where: { brandId },
      select: { id: true, name: true },
    });
    return new Map(groups.map((g: any) => [g.id, String(g.name).toLowerCase()]));
  }

  /** Does this item already carry a modifier group of the given name (item-level
   *  link OR on any size)? Used to make attachment idempotent. */
  private itemHasGroupNamed(item: any, name: string | undefined, nameById: Map<string, string>): boolean {
    if (!name) return false;
    const want = name.toLowerCase();
    for (const l of item.modifierGroupLinks ?? []) {
      if (String(l.group?.name ?? "").toLowerCase() === want) return true;
    }
    for (const s of item.productSkus ?? []) {
      for (const gid of s.modifierGroups ?? []) {
        if (nameById.get(gid) === want) return true;
      }
    }
    return false;
  }

  /** Attach a modifier group to an item the way the product editor models it.
   *  A MULTI-SIZE item gets a SEPARATE group PER SKU — so 10" and 12" never
   *  share a group id and price independently (exactly like "Create New" under
   *  each SKU in the editor). Each size's options are priced from the input's
   *  pricesBySize[sizeName], falling back to the flat price, and the per-size
   *  group carries no pricesBySize (single-priced → no visibility footgun).
   *  Single-price items get one item-level group. Returns the created id(s). */
  private async attachGroupToItem(tenantId: string, item: any, group: any): Promise<string[]> {
    const menuIds = item.menuIds ?? [];
    const skus = Array.isArray(item.productSkus) ? item.productSkus : [];
    if (item.hasMultipleSkus && skus.length) {
      const created: string[] = [];
      const nextSkus: any[] = [];
      for (const s of skus) {
        const gid = await this.createGroupWithOptions(
          tenantId, item.brandId, this.priceGroupForSize(group, s.name), menuIds, item.locationId,
        );
        created.push(gid);
        nextSkus.push({
          ...s,
          modifierGroups: Array.from(new Set([...(s.modifierGroups ?? []), gid])),
        });
      }
      await this.menus.updateItem(item.id, tenantId, {
        productSkus: nextSkus,
        hasMultipleSkus: true,
      } as any);
      return created;
    }
    const gid = await this.createGroupWithOptions(
      tenantId, item.brandId, this.priceGroupForSize(group, null), menuIds, item.locationId,
    );
    await this.menus.linkModifierGroupToItem(item.id, gid, tenantId).catch(() => {});
    return [gid];
  }

  /** Flatten a group's option prices to ONE size (null = flat): each option's
   *  price becomes pricesBySize[sizeName] when present, else its flat `price`.
   *  The result drops pricesBySize so each per-size group is cleanly
   *  single-priced (getModifierPrice then falls back to priceAdjustment and the
   *  option is always visible). */
  private priceGroupForSize(group: any, sizeName: string | null): any {
    const options = (group?.options ?? []).map((opt: any) => {
      let price = typeof opt?.price === "number" ? opt.price : 0;
      const pbs = opt?.pricesBySize;
      if (sizeName && pbs && typeof pbs === "object" && typeof pbs[sizeName] === "number") {
        price = pbs[sizeName];
      }
      return { name: opt?.name, price };
    });
    return { ...group, options };
  }

  /** The modifier groups actually attached to an item whose name matches,
   *  each with the set of SKU sizes referencing it. Multi-size items reference
   *  groups via productSkus[].modifierGroups (one dedicated group per size);
   *  single-price items via item-level modifierGroupLinks (sizes empty). A
   *  legacy shared group shows up once with several sizes. */
  private async itemGroupsByName(
    tenantId: string,
    item: any,
    groupNameLower: string,
  ): Promise<Array<{ group: any; sizes: Set<string> }>> {
    const refs: Array<{ groupId: string; size: string | null }> = [];
    const skus = Array.isArray(item.productSkus) ? item.productSkus : [];
    if (item.hasMultipleSkus && skus.length) {
      for (const s of skus) {
        for (const gid of s.modifierGroups ?? []) refs.push({ groupId: gid, size: s.name });
      }
    } else {
      for (const l of item.modifierGroupLinks ?? []) refs.push({ groupId: l.groupId, size: null });
    }
    if (!refs.length) return [];
    const ids = Array.from(new Set(refs.map((r) => r.groupId)));
    const groups = await (this.prisma as any).modifierGroup.findMany({
      where: { id: { in: ids }, brand: { tenantId } },
      select: {
        id: true, name: true,
        options: { select: { id: true, name: true, priceAdjustment: true, pricesBySize: true } },
      },
    });
    const byId = new Map<string, any>(groups.map((g: any) => [g.id, g]));
    const out = new Map<string, { group: any; sizes: Set<string> }>();
    for (const r of refs) {
      const g = byId.get(r.groupId);
      if (!g || String(g.name).toLowerCase() !== groupNameLower) continue;
      if (!out.has(g.id)) out.set(g.id, { group: g, sizes: new Set<string>() });
      if (r.size) out.get(g.id)!.sizes.add(r.size);
    }
    return Array.from(out.values());
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
