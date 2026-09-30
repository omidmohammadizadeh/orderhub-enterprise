# Phase BJ — JET Go (Just Eat Delivery-as-a-Service) courier dispatch

**Status:** built, unit-tested, not yet run against JET. **Blocked on JET Go test credentials.**

JET Go is Just Eat Takeaway's last-mile network — the same product shape as Uber
Direct and Stuart: our order, our customer, their courier. It is wired into the
same dispatch surfaces as those two, so an operator picks it from the same
chooser and it bills the same way.

Docs read: all nine pages under `developers.just-eat.com/documentation/jet-go`,
plus the full OpenAPI spec they link to at
`https://uk.api.just-eat.io/docs/daas/openapi.yaml` (v1.0.11), which is where the
per-field rules below come from.

---

## What it is, underneath

The JET Go API **is** SkipTheDishes' DaaS platform — every hostname is
`skipthedishes.com`. That is correct, not a copy/paste slip.

| | |
|---|---|
| Auth | Keycloak `client_credentials`, HTTP **Basic** header of `base64(clientId:clientSecret)`, `grant_type` in the form body |
| Token TTL | **300 seconds** |
| Token host | `https://api-staguk.skipthedishes.com` (UK staging) |
| API host | `https://api-daas-staguk.skipthedishes.com` (UK staging) — **a different host** |
| Webhook auth | JET → us, `TOKEN` (`x-api-key`) or `BASIC`. Not HMAC, unlike JET Connect. |

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /v1/delivery/collect-points` | the pickup points JET has onboarded for the credential |
| `POST /v1/delivery/estimate` | price + availability + the `requestId` everything else keys off |
| `POST /v1/delivery` | book the courier against that `requestId` (returns 202) |
| `PUT /v1/delivery/cancellation-request` | cancel, allowed until the courier collects |
| `GET /v1/delivery/status/{requestId}` | poll — our missed-webhook recovery |
| `POST /v1/delivery/simulate` | staging only; drives the real webhook sequence |
| `POST/GET/DELETE /v1/delivery/notification-config` | register our webhook |

---

## Traps found in the spec, and what we do about them

These are the things that are wrong-by-default and fail in ways that don't say
what they are. Each has a test.

1. **`geolocation.coordinates` is `[latitude, longitude]`** — *not* GeoJSON's
   `[lng, lat]`, despite `type: "point"`. Reversed, a London delivery lands in
   the Atlantic.
2. **Two different hosts.** Token from `api-…`, deliveries from `api-daas-…`.
   Mixing them 404s everything. EU also uses a **dot** where every other market
   uses a dash (`api-daas.stageu1`), which a naive string build gets wrong.
3. **The market is load-bearing.** UK credentials against the CA host are simply
   unauthorized, and the error doesn't say why.
4. **`ASSIGNED` does not mean a courier is coming.** JET's own docs: an offer
   goes to several couriers and you may get several `ASSIGNED` events.
   `IN_TRANSIT_TO_COLLECT` is the confirmation. We move the order on that one
   only — otherwise we'd tell a customer a rider was coming when nobody had
   accepted.
5. **`orderTrackerURL` is Canada-only** and returns the literal string
   `"Not available"` elsewhere. Stored naively, that becomes a dead "Track your
   courier" link. We only keep values that parse as a URL.
6. **`CANCELJOBSTATUS.status` is true/false** — `false` means the cancellation
   was *refused* and the courier is still coming. Clearing the order there would
   drop a live delivery off the board.
7. **`requestId` expires in 5 minutes and is single-use.** The price the operator
   sees in the modal is therefore not bookable, so dispatch always takes a fresh
   estimate rather than reusing it.
8. **Top-level `hasAlcohol` is deprecated and errors if true**, discarding the
   estimate. Alcohol only ever goes in `deliveryDetails`.
9. **`preparationDuration` must be 5–60.** A shop with a 90-minute prep time
   would 400 on every estimate, which reads as "JET Go is down". Clamped.
10. **JET retries nothing.** A failed webhook is gone — hence the poll endpoint
    and the manual "refresh status" action.
11. **`User-Agent` is mandatory in production** or Cloudflare blocks the request.
    Not required in sandbox, so this would first appear at go-live.
12. **One notification config per client credential.** See below.

---

## Two design decisions worth knowing about

### The webhook URL is per-credential, not per-location

Stuart and Uber Direct get a URL per location. JET Go **cannot**: it stores one
notification config per client credential, so two shops sharing a credential
would fight over it — registering the second silently strands the first shop's
courier updates.

So `JetGoConfig` carries a `webhookToken` that is **shared** between locations on
the same `clientId` (re-registering is then idempotent). Routing never depends on
it: every event carries `requestId`, which is unique platform-wide, with the
`metadata.orderId` we send on `/delivery` as a backstop.

The path token is **not** the credential. `webhookSecret` is a separate value
that never appears in the URL — the URL is shown in the dashboard and gets pasted
into support tickets, and if the path segment were also the secret then seeing
the URL would be enough to forge courier updates.

### A collect point is required before dispatch works

JET Go takes no pickup *address* — it dispatches from a point it has already
onboarded. A location with valid credentials and no collect point cannot dispatch
at all, so the settings screen blocks Activate and says why, rather than letting
it fail later at the till.

---

## Money

Identical to Stuart / Uber Direct: flat OrderHub fee debited from the location
wallet before the delivery is created, refunded if creation fails, `PLATFORM_ADMIN`
bypasses. JET bills the restaurant's own account for the courier.

Two JET-specific refunds, because in both cases the shop paid for a courier that
never came:

- **`CANCELJOBSTATUS` we did not ask for** — a JET agent cancelled, or the
  platform's unassigned-delivery timeout fired (changelog 2026-07-28). Refunded.
  An operator-requested cancellation is **not** refunded, or cancel/re-dispatch
  would be a free loop. Clearing `courierProvider` is the idempotency guard: a
  duplicate event no longer resolves to the order, so nothing refunds twice.
- **`DELIVERYREJECTED`** (EU only) — creation failed after our 202. Refunded.

Deliberately **not** sent: `tip`. `Order.tipAmount` is the *restaurant's*
gratuity; passing it as JET's `tip` would hand the shop's money to the courier on
every dispatch.

**Cash orders**: JET only supports COD in Bulgaria. Everywhere else a cash order
sent to a JET courier means nobody collects the money. The quote returns a
warning that is shown *before* the dispatch button, not after — it is not blocked,
because that is the operator's call.

---

## What was built

**API** — `apps/api/src/modules/integrations/jet-go/`
`jet-go-client.service.ts` (auth, host map, all endpoints) ·
`jet-go-config.service.ts` (encrypted per-location creds, collect point, shared token) ·
`jet-go-dispatch.service.ts` (quote / dispatch / cancel / simulate / refresh) ·
`jet-go-webhook.controller.ts` + `jet-go-webhook.service.ts` (all nine event types) ·
`jet-go.controller.ts` · `jet-go.module.ts`

**Schema** — `JetGoConfig` model + migration `20260926120000_jet_go_dispatch`.
No existing migration was edited.

**Dashboard** — `jet-go.client.ts`; `JetGoConnectionSection` in Location settings
(credentials → collect-point picker → register webhook → activate); JET Go added
to the per-order **and** bulk dispatch choosers; cancel wired into the order
drawer (worded for the asynchronous confirmation); `JET_GO` label + logo.

**Tests** — 83 unit tests across 4 specs, covering every trap above.

### Verified
- `pnpm test` (jet-go): 83/83 pass
- `tsc --noEmit` on `apps/api`: 0 errors
- `next build` on `apps/web`: exit 0
- Settings panel rendered and checked at desktop and mobile widths; label/input
  bindings, `autocomplete=off` and `spellcheck=false` confirmed in the DOM

### Not verified — needs credentials
No call has been made to JET. The transformer is **spec-derived**, the same
position JET Connect was in before its first real order. Specifically unproven:
the exact `/estimate` 400s for a UK payload, whether `dynamicDeliveryFee` is
pence as documented, and the real webhook field casing.

---

## Certification checklist (from JET's Validation and Certification page)

| Requirement | State |
|---|---|
| Estimate payload: weight, prep duration, alcohol, target time, address | ✅ built |
| Delivery payload: target collect time, vendorOrderId, special instructions | ✅ built |
| ASAP vs advance (advance unsupported in EU) | ✅ built, EU falls back to ASAP |
| Notification config setup | ✅ one-click register + status check |
| Wait for `DELIVERYCREATED` to confirm creation | ✅ order sits at `PENDING` until it arrives |
| Wait for `CANCELJOBSTATUS` to confirm cancellation | ✅ cancel does not clear locally |
| `requestId` mapped as the unique delivery identifier | ✅ `Order.courierJobId` |
| SMS delivery toggle ON/OFF | ❓ **ask JET** — not in the API or the spec; appears to be an account-side setting |
| `User-Agent` on every request (mandatory in production) | ✅ `JET_GO_USER_AGENT`, defaults sensibly |

---

## Open questions for the JET Go team

1. **Test credentials + test collect points** for the UK staging environment
   (`api-staguk` / `api-daas-staguk`). Their onboarding page says these are
   issued together — this is the blocker.
2. **Is `dynamicDeliveryFee` pence?** The spec says "minor currency units"; we
   divide by 100 to display.
3. **The SMS delivery toggle** in the certification list — where is it set?
4. **`paymentType: COD`** — confirmed Bulgaria-only? We send `PREPAID` always.
5. **Is `/simulate` available on UK staging?** The spec excludes `EU` and lists
   `api-daas-staguk` among the simulate hosts, so it should be, but the docs page
   also says "not available in EU" without defining whether UK counts.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `JET_GO_USER_AGENT` | `OrderHub/1.0 (+https://orderhub.solutions)` | mandatory in production |
| `JET_GO_CONTACT_EMAIL` | `support@orderhubsolutions.com` | who JET contacts if our endpoint fails |
| `JET_GO_FALLBACK_EMAIL` | `noreply@orderhubsolutions.com` | JET requires a customer email; used when the order has none |

Credentials are per location, encrypted with `CREDENTIAL_ENCRYPTION_KEY`.
