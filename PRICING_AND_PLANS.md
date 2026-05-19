# Pricing and Plans — Phase R

> Current as of Phase R commercial launch.
> Update this file whenever pricing or plan features change.

---

## Plan Summary

| Plan | Price | Locations | Users | Notes |
|------|-------|-----------|-------|-------|
| **Starter** | £49/month | 1 | 5 | + £0.05/order above 500/month |
| **Professional** | £149/month | 3 | 20 | + £0.04/order above 2,000/month |
| **Enterprise** | Custom | Unlimited | Unlimited | Contact sales |

---

## Starter (£49/month)

**Best for:** Single-location restaurants with up to 500 orders/month.

Features included:
- Order management (accept, reject, lifecycle)
- Kitchen Display System (KDS)
- Receipt printer support (Epson, Star, LAN, ePOS)
- Uber Eats integration
- Deliveroo integration
- Cashier mode
- Dispatch mode
- Flutter printer app (shopCode polling)
- 30-day free trial for new signups

Limits:
- 1 location
- 5 staff users
- Per-order charge: £0.05 per order above 500/month

---

## Professional (£149/month)

**Best for:** Multi-location restaurants or high-volume single sites.

Everything in Starter, plus:
- Up to 3 locations
- 20 staff users
- Just Eat integration (when production-validated — see KNOWN_LIMITATIONS.md)
- HubRise integration (sub-pilot status — see KNOWN_LIMITATIONS.md)
- Analytics dashboard
- Rush Hour mode
- Multi-location management

Limits:
- 3 locations
- 20 staff users
- Per-order charge: £0.04 per order above 2,000/month

---

## Enterprise (Custom pricing)

**Best for:** Chains, multi-brand groups, franchise operators.

Everything in Professional, plus:
- Unlimited locations
- Unlimited users
- Custom integrations
- Dedicated SLA support
- White-label branding (custom domain, logo, colours)
- Priority onboarding

Contact sales for pricing.

---

## Trial Policy

- **New restaurants**: 30-day free trial on Starter plan
- **No credit card required** during trial
- Trial starts when `Location.goLiveStatus → LIVE`
- Trial end reminders: Day 15, Day 27, Day 30
- After trial: credit card required to continue

## Pilot Shop Policy (Phase Q shops)

The 5 Phase Q rollout restaurants are on a free pilot arrangement:

| Shop | Free until | Post-free plan |
|------|-----------|----------------|
| Spice Garden (SHOP01) | 2026-09-01 | Starter |
| The Curry Leaf (SHOP02) | 2026-09-01 | Starter |
| Naan & Co (SHOP03) | 2026-09-01 | Starter |
| Peri Palace (SHOP04) | 2026-09-01 | Starter |
| Masala Express (SHOP05) | 2026-09-01 | Starter |

Written notice must be sent to all 5 shops before 2026-08-01.

---

## Grace Period Policy

When a payment fails:
- Tenant status → `PAST_DUE`
- Grace period: 7 days (access continues)
- After 7 days without payment: status → `UNPAID`
- `UNPAID` tenants: read-only access to dashboard (no order acceptance)
- Live orders and printer jobs remain functional regardless of billing status

---

## Feature Flags

Plan features are stored in `SubscriptionPlan.features` (JSON string array). Current keys:

| Feature key | Starter | Professional | Enterprise |
|-------------|---------|-------------|-----------|
| `orders` | ✅ | ✅ | ✅ |
| `kds` | ✅ | ✅ | ✅ |
| `printers` | ✅ | ✅ | ✅ |
| `uber_eats` | ✅ | ✅ | ✅ |
| `deliveroo` | ✅ | ✅ | ✅ |
| `cashier` | ✅ | ✅ | ✅ |
| `dispatch` | ✅ | ✅ | ✅ |
| `just_eat` | ❌ | ✅ | ✅ |
| `hubrise` | ❌ | ✅ | ✅ |
| `analytics` | ❌ | ✅ | ✅ |
| `rush_hour` | ❌ | ✅ | ✅ |
| `multi_location` | ❌ | ✅ | ✅ |
| `custom_integrations` | ❌ | ❌ | ✅ |
| `sla_support` | ❌ | ❌ | ✅ |
| `white_label` | ❌ | ❌ | ✅ |

Check feature access: `GET /v1/billing/features/:featureKey` returns `{ featureKey, hasAccess: boolean }`.
