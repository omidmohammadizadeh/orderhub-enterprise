# Rollout Staff Training — Phase P

> Created: 2026-05-19
> Updated after each new shop goes live.
> One row per shop. Must be complete before go-live.

---

## Training Status Summary

| Shop | Training Date | Trainer | Sign-off |
|---|---|---|---|
| Shop 1 — Spice Garden | 2026-05-15 | Engineering team | ✅ Arjun Mehta |
| Shop 2 — The Curry Leaf | TBC (target 2026-05-25) | TBC | ⬜ Pending |
| Shop 3 — Naan & Co | TBC (target 2026-05-31) | TBC | ⬜ Pending |
| Shop 4 — Peri Palace | TBC | TBC | ⬜ Pending |
| Shop 5 — TBD | TBC | TBC | ⬜ Pending |

---

## Shop 1 — Spice Garden, Bethnal Green ✅

**Training date:** 2026-05-15
**Trainer:** Engineering team
**Sign-off:** Arjun Mehta (owner)

| Training item | Complete |
|---|---|
| Staff names/users created | ✅ Arjun Mehta (TENANT_OWNER), 2 kitchen staff (STAFF) |
| Staff can log in to dashboard | ✅ |
| Test order completed by staff | ✅ (5 test orders, mixed platforms) |
| Staff can accept/reject orders | ✅ |
| Staff can use KDS (bump, colour coding) | ✅ |
| Staff can use Cashier/Dispatch screen | ✅ |
| Staff can reprint a job | ✅ |
| Staff shown daily printer pre-shift check | ✅ |
| Staff can check health panel (`/v1/health/staff-status`) | ✅ (Arjun shown on his phone) |
| Staff know printer troubleshooting steps | ✅ (printout posted near tablet) |
| Staff know emergency pause procedure | ✅ (Go-Live Wizard → PAUSED explained) |
| Support contact given | ✅ (WhatsApp group created) |
| `PILOT_STAFF_TRAINING.md` printed and posted | ✅ |
| Emergency contact list printed and posted | ✅ |

**Notes:** Arjun was confident with the system after 30-minute demo. Kitchen staff needed extra time on KDS bump behaviour (green = accepted, yellow = preparing). No issues on go-live day.

---

## Shop 2 — The Curry Leaf, Whitechapel ⬜ (Pending)

**Training date:** Target 2026-05-25
**Trainer:** TBC
**Sign-off:** Priya Sharma (owner-operator)

| Training item | Complete |
|---|---|
| Staff names/users created | ⬜ |
| Staff can log in to dashboard | ⬜ |
| Test order completed by staff | ⬜ |
| Staff can accept/reject orders | ⬜ |
| Staff can use KDS | ⬜ |
| Staff can use Cashier/Dispatch screen | ⬜ |
| Staff can reprint a job | ⬜ |
| Staff shown daily printer pre-shift check | ⬜ |
| Staff can check health panel | ⬜ |
| Staff know printer troubleshooting steps | ⬜ |
| Staff know emergency pause procedure | ⬜ |
| Support contact given | ⬜ |
| `ROLLOUT_STAFF_TRAINING.md` / training sheet printed and posted | ⬜ |
| Emergency contact list printed and posted | ⬜ |

---

## Shop 3 — Naan & Co, Shoreditch ⬜ (Pending)

**Training date:** Target 2026-05-31
**Trainer:** TBC
**Sign-off:** Dev Patel (manager)

| Training item | Complete |
|---|---|
| Staff names/users created | ⬜ |
| Staff can log in to dashboard | ⬜ |
| Test order completed by staff | ⬜ |
| Staff can accept/reject orders | ⬜ |
| Staff can use KDS | ⬜ |
| Staff can use Cashier/Dispatch screen | ⬜ |
| Staff can reprint a job | ⬜ |
| Staff shown daily printer pre-shift check | ⬜ |
| Staff can check health panel | ⬜ |
| Staff know printer troubleshooting steps | ⬜ |
| Staff know emergency pause procedure | ⬜ |
| Support contact given | ⬜ |
| Training sheet printed and posted | ⬜ |
| Emergency contact list printed and posted | ⬜ |

**Notes (pre-training):** Star TSP654II printer — verify staff know the paper loading procedure differs from Epson.

---

## Staff Training Curriculum (all shops)

The following topics must be covered for every new shop. Allow 60–90 minutes.

### Part 1 — Dashboard basics (15 min)

1. Log in at `app.orderhub.io`
2. Switch location (for managers with multi-location access)
3. Orders page — incoming orders, platforms shown
4. Accepting and rejecting an order
5. Rush Hour mode toggle
6. Status flow: PENDING → ACCEPTED → PREPARING → READY → DISPATCHED → COMPLETE

### Part 2 — Kitchen Display (KDS) (15 min)

1. What orders appear on the KDS
2. Bump an order off the KDS
3. Colour coding:
   - Green = ACCEPTED (just arrived)
   - Yellow = PREPARING (cooking started)
   - Red = overdue
4. What to do if the KDS tablet goes blank

### Part 3 — Printer operation (15 min)

1. What prints and when (receipt on accept, kitchen ticket on accept)
2. Reprinting a job via dashboard
3. **Daily printer pre-shift check** (must be done every day before opening):
   - Power light green
   - Ethernet cable firmly connected
   - Paper loaded (80mm roll)
   - Dashboard → Diagnostics → printer shows ONLINE
   - Send test print → confirm it prints
4. What to do if test print fails → printer troubleshooting table

### Part 4 — System Status Panel (10 min)

1. Open the health panel (manager's phone):
   ```
   GET https://api.orderhub.io/api/v1/health/staff-status?locationId=<YOUR_LOCATION_ID>
   ```
   (Or use the Orders page header status badge when available)
2. Fields: systemStatus, printerStatus, providerStatuses, lastOrderAt, actionRequired
3. If `actionRequired: "check_printer"` → follow printer troubleshooting
4. If `actionRequired: "contact_support"` → call support immediately

### Part 5 — Emergency pause (10 min)

1. If you need to stop taking orders immediately:
   - Dashboard → Go-Live Wizard → select location → PAUSED
   - Or call the on-call engineer who will pause it remotely
2. What "paused" means: no new orders arrive from any platform
3. How to resume: PAUSED → LIVE (manager or admin only)

### Part 6 — Support contact (5 min)

1. Share support WhatsApp group link
2. Confirm on-call engineer's number is in their phone
3. Confirm email: support@orderhub.io
4. When to call vs. when to message
5. P0 = call immediately; P1 = message within 5 minutes; P2/P3 = message during business hours

---

## Printer Troubleshooting Quick Reference

Post this near the tablet in every shop.

| Symptom | First check | Second check | Third check | Call support |
|---|---|---|---|---|
| Printer not printing | Power light | Ethernet cable | Restart printer | After 5 min |
| Test print fails | Paper loaded | Paper not jammed | Cable reseated | After 5 min |
| Dashboard shows OFFLINE | Ethernet cable | Printer power | Router/switch | After 5 min |
| Paper jam | Open cover | Remove jammed paper | Reload roll | — |
| Print is garbled | Paper orientation | Roll diameter (80mm) | — | Immediately |

---

## Sign-off Template

Complete for each shop:

```
Shop: ___________________________
Training date: ___________________
Trainer name: ___________________
Staff trained:
  - Name: _____________ Role: _____________ Sign: _____________
  - Name: _____________ Role: _____________ Sign: _____________
  - Name: _____________ Role: _____________ Sign: _____________
Owner/manager sign-off: _____________
Date: ___________________________
```
