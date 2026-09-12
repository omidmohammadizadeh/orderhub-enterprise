# Caller ID — connecting a shop's phone provider

Three ways a caller reaches the till popup. All three end at the same socket
event (`callerid:ring`) and the same lookup, so the popup, the autofill and the
customer history behave identically whichever one a shop is on.

| Route | Needs | Cost per call | Works with |
|---|---|---|---|
| **A — provider webhook** | The provider can POST on an incoming call | none | any line, including ones we don't host |
| **B — simultaneous ring** | A number from us, and a provider that can ring a second outside number | none (we never answer) | VoIP / cloud PBX only |
| **C — Comet USB box** | Hardware on a hub tablet | none | analogue landlines |

Everything an operator needs for A and B is generated in the dashboard:
**Caller ID → Phone provider**. Pick the shop first — the address and the key
are different for every shop. The page writes the message to send the provider,
with that shop's details already in it, and shows the rings as they arrive so a
test call can be confirmed without standing at a till.

---

## Route A — provider webhook (preferred)

```
POST  {API_URL}/api/v1/customers/caller-id/voip/{locationId}
Header: x-voip-key: <the shop's key>
Body:   any JSON carrying the caller's number
```

The parser already accepts Twilio (`From` / `Caller`), sipgate (`from`), Telnyx
(`data.payload.from.phone_number`) and the generic `caller` / `caller_id` /
`phone` / `callerNumber` shapes, so most providers need no custom work.
`?key=` is still accepted for providers that cannot set a header, but it is
never what we recommend: web addresses get written into logs by every proxy
they pass through.

Three rules go in every message, and the dashboard's copy includes them:

1. **The INCOMING / RINGING event only** — not answered, ended, missed or
   voicemail. A provider posting on every event is how a till once showed a
   caller card minutes *after* staff had hung up.
2. **The caller's number, not the shop's own.**
3. **The key in the `x-voip-key` header.**

### Keys

- `VOIP_WEBHOOK_KEY` is one secret shared across the whole platform. It still
  works, so nothing in the field has to be re-keyed, but it is **never returned
  to any client at any role** — it stays an env var on the API.
- Every shop can mint **its own key** (`Location.settings.voipWebhookToken`),
  and that is the only key the dashboard ever hands out. A shop key opens one
  shop's door: whoever holds it can put a caller card on that shop's tills and
  nothing else — no orders, no customers, no takings, no other shop.
- The key is fetched by the browser when the panel is opened, only for the
  roles that may change that shop's settings (owner / manager tier), and only
  for a location inside the caller's own tenant. It is never server-rendered
  into the page, so a cashier's HTML never contains it.
- **Replace** mints a new key and retires the old one immediately.

New shops should be set up on their own key. The shared key is a migration
tail, not a design.

---

## Route B — simultaneous ring, for providers with no webhook

We give the shop a number of ours. Their provider rings it **at the same time**
as the shop's own line; we never pick up, so the call is not taken away from
staff and nothing is billed. The ringing alone carries the caller's number.

Setup:

1. Assign a Telnyx number to the shop — **AI phone number** in the location
   settings (`Location.settings.voiceNumber`).
2. Switch on **Show callers on the till, without answering**
   (`Location.settings.voiceCallerIdOnly`). With this on, the number rings and
   never answers, whether or not the AI phone line is enabled.
3. Send the provider the Route B message from the dashboard.

### Two provider-side conditions — check both, with one real shop, before promising this

Both are properties of the **provider**, not the shop, so one honest test per
provider settles it for all their shops.

**(a) Can they ring a second, OUTSIDE number at the same time?**
This is a VoIP / cloud-PBX feature (simultaneous ring, twinning, hunt groups).
A plain BT landline **cannot**: its divert only fires *after* the line has rung
out, which is long after staff have picked up — far too late for a popup.

**(b) Does the CALLER's number reach us, or do they replace it with the shop's
own?** Many systems substitute their own number when passing a call on. Then
the till shows the same number on every call and the feature is worthless.

### How to test

1. Open **Caller ID → Phone provider** for the shop.
2. Press **Send a test ring to this shop's tills**. A card for `+441632960123`
   should appear on every till. If it does, the tills and the socket path are
   fine and anything still missing is the provider's end.
3. Ring the shop from a mobile and watch the ring log (it refreshes itself).
   - Nothing at all → condition (a) failed, or the provider hasn't saved the
     webhook.
   - A ring flagged **"this is the SHOP's own number"** → condition (b) failed.
     We compare the arriving number against the shop's own lines on the last 9
     digits, so `01…` and `+44…` forms of one line count as the same.
   - A ring flagged **"refused"** → the post arrived but the key was wrong;
     re-copy it, or press Replace and send the new one.
   - A ring flagged **15 digits — two numbers stuck together** → the sender is
     mangling the number before it reaches us (see `undoubleNumber`).

The ring log is in memory and deliberately not in the database: it is a
"did the test call land?" light, looked at for a minute during setup and never
again. A row per ring would be a permanent table of customers' phone numbers
kept for a question that stops being asked once the answer is yes. It is lost
on an API restart, which is the correct trade.
