# Rollout Locations — Phase P

> Created: 2026-05-19
> Updated: 2026-06-13 (Phase Q complete)
> Maintained by: Operations / On-call engineering
> Do not onboard next shop while previous shop has unresolved P0/P1 issues.
> Maximum 1 new restaurant per day. Go-live window: 08:00–10:00 BST only.

---

## Quick Summary

| # | Shop | Status | Go-Live Date | Orders | Lost | P0/P1 |
|---|------|--------|-------------|--------|------|-------|
| 1 | Spice Garden — Bethnal Green | ✅ LIVE — 28 days | 2026-05-16 | 621 | 0 | 0/0 |
| 2 | The Curry Leaf — Whitechapel | ✅ LIVE — 17 days | 2026-05-27 | 312 | 0 | 0/0 |
| 3 | Naan & Co — Shoreditch | ✅ LIVE — 10 days | 2026-06-03 | 189 | 0 | 0/0 |
| 4 | Peri Palace — Hackney | ✅ LIVE — 4 days | 2026-06-09 | 198 | 0 | 0/0 |
| 5 | Masala Express — Camden | 🟡 MONITORING — 1 day | 2026-06-12 | 47 | 0 | 0/0 |

---

## Shop 1 — Spice Garden, Bethnal Green ✅ LIVE

| Field | Value |
|---|---|
| **Shop name** | Spice Garden |
| **Location** | 42 Bethnal Green Road, London E1 6RL |
| **Contact** | Arjun Mehta (owner), arjun@spicegarden.co.uk, 07700 900142 |
| **Providers** | Uber Eats, Deliveroo |
| **Printer type** | Epson TM-T88VI (LAN, 192.168.1.50:9100) |
| **shopCode** | SHOP01 |
| **Menu size** | 48 items, 6 categories |
| **Risk level** | Low |
| **Go-live date** | 2026-05-16 |
| **Readiness status** | ✅ LIVE — 3-day pilot complete, 47 orders, 0 lost |
| **Support owner** | Engineering (pilot) |
| **Stability window** | 2026-05-16 → 2026-05-19 (3 days complete, stable) |

**Notes:** Pilot restaurant. Phase N/O complete. All Phase P expansion criteria met.

---

## Shop 2 — The Curry Leaf, Whitechapel ✅ LIVE

| Field | Value |
|---|---|
| **Shop name** | The Curry Leaf |
| **Location** | 18 Whitechapel High Street, London E1 7PT |
| **Contact** | Priya Sharma (owner-operator), priya@thecurryleaf.co.uk, 07700 900251 |
| **Providers** | Uber Eats, Deliveroo |
| **Printer type** | Epson TM-T88VI (LAN) |
| **shopCode** | SHOP02 |
| **Menu size** | 35 items, 5 categories |
| **Risk level** | Low (referral from Arjun Mehta) |
| **Go-live date** | 2026-05-27 (09:00 BST) |
| **Readiness status** | ✅ LIVE — 17 trading days, 312 orders, 0 lost |
| **Support owner** | Engineering (ops handoff complete 2026-06-06) |

**Trading summary (Phase Q):**
- 312 orders, 0 lost, 0 P0, 0 P1, 1 P2 (rate-limit events, auto-resolved)
- Staff fully independent from Day 3
- Issue Q-003 (P3): KDS colour brightness — deferred to Phase R

---

## Shop 3 — Naan & Co, Shoreditch ✅ LIVE

| Field | Value |
|---|---|
| **Shop name** | Naan & Co |
| **Location** | 7 Curtain Road, London EC2A 3LT |
| **Contact** | Dev Patel (manager), dev@naanandco.co.uk, 07700 900387 |
| **Providers** | Deliveroo (Just Eat pending — not activated) |
| **Printer type** | Star TSP654II (LAN) |
| **shopCode** | SHOP03 |
| **Menu size** | 42 items, 7 categories |
| **Risk level** | Low-Medium (first production Star printer) |
| **Go-live date** | 2026-06-03 (08:30 BST) |
| **Readiness status** | ✅ LIVE — 10 trading days, 189 orders, 0 lost |
| **Support owner** | Engineering (ops handoff complete 2026-06-09) |

**Trading summary (Phase Q):**
- 189 orders, 0 lost, 0 P0, 0 P1, 1 P2
- Issue Q-001 (P1): Star printer item name truncation — fixed and redeployed Day 1
- Issue Q-004 (P2): Staff unaware Just Eat was pending — UI label fix applied
- Staff fully independent from Day 2

---

## Shop 4 — Peri Palace, Hackney ✅ LIVE

| Field | Value |
|---|---|
| **Shop name** | Peri Palace |
| **Location** | 55 Mare Street, London E8 4RG |
| **Contact** | Sanjay Kapoor (owner), sanjay@peripalace.co.uk, 07700 900478 |
| **Providers** | Uber Eats |
| **Printer type** | Epson TM-T88VI (LAN) |
| **shopCode** | SHOP04 |
| **Menu size** | 51 items, 6 categories |
| **Risk level** | Medium (50–60 orders/day at launch) |
| **Go-live date** | 2026-06-09 (09:00 BST) |
| **Readiness status** | ✅ LIVE — 4 trading days, 198 orders, 0 lost |
| **Support owner** | Engineering |

**Trading summary (Phase Q):**
- 198 orders, 0 lost, 0 P0, 0 P1, 1 P2
- Issue Q-002 (P2): 7 Uber Eats 429s at lunch peak — all auto-resolved via rate-limit-aware backoff
- Staff pre-trained by Arjun Mehta (Spice Garden) — 0 support calls
- Highest-volume shop in rollout; system handled cleanly

---

## Shop 5 — Masala Express, Camden 🟡 MONITORING

| Field | Value |
|---|---|
| **Shop name** | Masala Express |
| **Location** | 103 Parkway, London NW1 7PP |
| **Contact** | Ravi Gupta (owner), ravi@masalaexpress.co.uk, 07700 900561 |
| **Providers** | Uber Eats, Deliveroo |
| **Printer type** | Epson TM-T88VI (LAN) |
| **shopCode** | SHOP05 |
| **Menu size** | 38 items, 5 categories |
| **Risk level** | Low |
| **Go-live date** | 2026-06-12 (09:00 BST) |
| **Readiness status** | 🟡 MONITORING — 1 trading day, 47 orders, 0 lost |
| **Support owner** | Engineering (48-hour close monitoring) |

**Trading summary (Phase Q — 1 day):**
- 47 orders, 0 lost, 0 P0, 0 P1, 0 P2
- First trading session clean
- Monitoring continues — full 3-day stability check pending

---

## Rollout Rules (summary)

| Rule | Value |
|---|---|
| Max new shops per day | 1 |
| Go-live window | 08:00–10:00 BST, Mon–Thu only |
| Do not go-live on | Fri, Sat, Bank holidays |
| Stability gate before next shop | ≥ 5 working days, 0 P0/P1 |
| Block condition | Any unresolved P0/P1 across ANY rollout shop |

---

## Go/No-Go Checks (per shop)

Before marking any shop LIVE:

- [ ] All other rollout shops have 0 unresolved P0/P1 issues
- [ ] This shop: release readiness score ≥ 90
- [ ] This shop: 0 blockers in go-live wizard
- [ ] This shop: test order and test print completed
- [ ] This shop: staff training completed
- [ ] This shop: credentials encrypted (plaintextCredentials = 0)
- [ ] This shop: webhook test received and verified
- [ ] This shop: printer heartbeat ONLINE
- [ ] This shop: on-call engineer available for 2 hours post go-live
- [ ] Go-live time: 08:00–10:00 BST, Mon–Thu only

---

## Rollout Admin Monitoring

Use `GET /api/v1/admin/rollout/overview` (PLATFORM_ADMIN only) to see all rollout locations:
- Live status, provider status, printer status, last order, last print, failed jobs, dead outbox events

No credentials are exposed in this endpoint.
