# Rollout Locations — Phase P

> Created: 2026-05-19
> Maintained by: Operations / On-call engineering
> Do not onboard next shop while previous shop has unresolved P0/P1 issues.
> Maximum 1 new restaurant per day. Go-live window: 08:00–10:00 BST only.

---

## Quick Summary

| # | Shop | Status | Go-Live Date | Support Owner |
|---|------|--------|-------------|---------------|
| 1 | Spice Garden — Bethnal Green | ✅ LIVE (pilot) | 2026-05-16 | Engineering |
| 2 | The Curry Leaf — Whitechapel | 🟡 TESTING | 2026-05-27 | TBC |
| 3 | Naan & Co — Shoreditch | 🔵 CONFIGURING | 2026-06-03 | TBC |
| 4 | Peri Palace — Hackney | 📋 DRAFT | After shops 2+3 stable ≥5 days | TBC |
| 5 | TBD (inbound enquiry) | 📋 DRAFT | After shops 2+3+4 stable ≥5 days | TBC |

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

## Shop 2 — The Curry Leaf, Whitechapel

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
| **Planned go-live date** | 2026-05-27 (08:00–10:00 BST, Tuesday) |
| **Readiness status** | 🟡 TESTING |
| **Support owner** | TBC — assign before 2026-05-25 |

**Pre-go-live checklist status:**
- [x] Selection criteria met
- [x] Owner briefed on pilot programme
- [x] Printer model confirmed (Epson TM-T88VI LAN)
- [x] Printer IP confirmed reachable (confirmed 2026-05-18)
- [x] Provider credentials obtained
- [x] shopCode SHOP02 assigned
- [x] Menu exported and reviewed (35 items, all priced in pence)
- [ ] Webhook URLs configured and test webhook received
- [ ] Credentials encrypted (plaintextCredentials = 0)
- [ ] Staff training session scheduled (target 2026-05-25)
- [ ] Test print confirmed
- [ ] Test order confirmed
- [ ] Readiness score ≥ 90
- [ ] On-call engineer confirmed available 2026-05-27

**Notes:** Referred by Arjun Mehta (Spice Garden). Single-location. Similar setup to pilot.
Do not go-live until Spice Garden has ≥ 5 working days trading with 0 P0/P1.

---

## Shop 3 — Naan & Co, Shoreditch

| Field | Value |
|---|---|
| **Shop name** | Naan & Co |
| **Location** | 7 Curtain Road, London EC2A 3LT |
| **Contact** | Dev Patel (manager), dev@naanandco.co.uk, 07700 900387 |
| **Providers** | Deliveroo, Just Eat (pending approval — Deliveroo only for launch) |
| **Printer type** | Star TSP654II (LAN) |
| **shopCode** | SHOP03 |
| **Menu size** | 42 items, 7 categories |
| **Risk level** | Low-Medium (new printer type — Star, previously only Epson in production) |
| **Planned go-live date** | 2026-06-03 (08:00–10:00 BST, Wednesday) |
| **Readiness status** | 🔵 CONFIGURING |
| **Support owner** | TBC — assign before 2026-05-31 |

**Pre-go-live checklist status:**
- [x] Selection criteria met
- [x] Owner briefed
- [x] Printer model confirmed (Star TSP654II LAN)
- [ ] Printer IP confirmed and reachable
- [ ] Provider credentials obtained (Deliveroo only — Just Eat deferred)
- [ ] shopCode SHOP03 assigned
- [ ] Menu reviewed
- [ ] Staff training scheduled
- [ ] Test print (Star printer — verify formatting)
- [ ] Test order
- [ ] Readiness score ≥ 90

**Notes:** First Star printer in production. Do a printer formatting verification call before go-live.
Just Eat integration deferred — not approved yet. Launch on Deliveroo only.
Do not go-live until Shop 2 (Curry Leaf) has ≥ 5 working days trading with 0 P0/P1.

---

## Shop 4 — Peri Palace, Hackney (Planned)

| Field | Value |
|---|---|
| **Shop name** | Peri Palace |
| **Location** | 55 Mare Street, London E8 4RG |
| **Contact** | TBC |
| **Providers** | Uber Eats (Deliveroo deferred) |
| **Printer type** | TBC (likely Epson LAN) |
| **shopCode** | SHOP04 (reserved) |
| **Menu size** | TBC (~50 items) |
| **Risk level** | Medium (higher-volume shop, ~60–80 orders/day expected) |
| **Planned go-live date** | After shops 2+3 stable ≥ 5 working days |
| **Readiness status** | 📋 DRAFT |
| **Support owner** | TBC |

**Notes:** Slightly higher volume than previous shops. Onboard only after shops 2 and 3 stable.
Confirm order volume expectation before go-live — if > 80/day, defer to Phase Q.

---

## Shop 5 — TBD (Inbound Enquiry)

| Field | Value |
|---|---|
| **Shop name** | TBC |
| **Location** | TBC — London preferred |
| **Contact** | TBC |
| **Providers** | TBC |
| **Printer type** | TBC |
| **shopCode** | SHOP05 (reserved) |
| **Risk level** | TBC |
| **Planned go-live date** | After shops 2+3+4 stable ≥ 5 working days each |
| **Readiness status** | 📋 DRAFT |
| **Support owner** | TBC |

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
