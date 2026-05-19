# Pilot Staff Training Guide

> Quick reference guide for restaurant staff using OrderHub.
> Keep a printed copy near the tablet/screen.

---

## Logging In

1. Open the OrderHub dashboard in your browser: `https://app.orderhub.io`
2. Enter your email and password
3. If you forget your password, click **Forgot password**
4. Contact your manager if you cannot log in

---

## Receiving Orders

New orders appear automatically on the **Orders** page.

- A sound plays and the order card flashes when a new order arrives
- Order cards show: platform (Uber Eats, Deliveroo), order number, items, total, and time
- If the tablet/screen is offline, check your internet connection

---

## Accepting an Order

1. Find the new order on the **Orders** page
2. Click **Accept**
3. The order moves to "Preparing"
4. The kitchen ticket prints automatically

If the order is unacceptable (out of stock, store closing):
- Click **Reject** and select the reason
- The customer is notified automatically

---

## Updating Order Status

As the order progresses, update its status:

| Button | When to press |
|---|---|
| **Preparing** | When kitchen starts cooking |
| **Ready** | When the order is packed and ready |
| **Dispatch** | When the delivery driver collects it (delivery orders) |
| **Complete** | When the customer has collected it (collection orders) |

---

## Kitchen Display (KDS)

The Kitchen Display shows all active orders in the kitchen.

- Orders appear automatically when accepted
- Tickets turn yellow when approaching the expected ready time
- Tickets turn red when overdue
- Press **Bump** when the order is ready — this updates the main orders page

---

## Cashier Screen

Used for collection orders and manual payments.

- Shows orders ready for customer collection
- Mark as collected when customer picks up
- Record payment type (card/cash) if applicable

---

## Dispatch Screen

Used for delivery orders.

- Shows orders that are ready for driver collection
- Assign a driver if using your own delivery staff
- Mark as dispatched when driver collects

---

## Rush Hour Mode

Activates when many orders arrive at once.

- Displays a simplified, large-font order queue
- Use this mode during peak hours
- Can be activated manually from the top menu

---

## Reprinting an Order

If the printer missed a ticket:

1. Find the order on the **Orders** page
2. Click the order to open details
3. Click **Reprint**
4. Wait for the printer to print

If the printer is offline:
- Check the printer power light (should be green)
- Check the network/ethernet cable
- Restart the printer if needed
- Tell your manager if reprinting fails

---

## Pausing an Item (Out of Stock)

If an item is unavailable:

1. Go to **Menu** in the left menu
2. Find the item
3. Toggle it to **Unavailable**
4. The item is hidden from platforms automatically
5. Toggle back to **Available** when restocked

---

## Pausing/Closing the Store

If you need to stop taking orders (unexpected closure, emergency):

1. Go to **Integrations** in the left menu
2. Find the provider (Uber Eats, Deliveroo, etc.)
3. Click **Pause** or set to Inactive
4. Contact your manager to confirm

Or ask your manager to use the Go-Live Wizard to pause the location.

---

## If Something Goes Wrong

| Problem | What to do |
|---|---|
| New order arrived, no ticket printed | Check printer, try Reprint from order details |
| Orders not appearing | Check internet, refresh the page |
| Cannot accept order | Refresh the page, try again |
| KDS not updating | Refresh the page, check internet |
| Printer shows offline in diagnostics | Restart printer, check cable |
| Provider showing error | Contact manager immediately |
| **Emergency** | Use the number below to call support |

---

## Support Contact

| Role | Name | Phone / WhatsApp |
|---|---|---|
| Manager on duty | _(name)_ | _(phone)_ |
| OrderHub support | _(name)_ | _(phone)_ |
| Technical on-call | _(name)_ | _(phone)_ |

---

## Daily Printer Check (Before Opening)

Every day before opening, complete this check:

1. Press printer power button — green light should be on
2. Check Ethernet cable is firmly pushed in at both ends (printer and router/switch)
3. Check paper roll — if near the end, replace before trading starts
4. Open OrderHub and go to the **System Status** page (`/dashboard/status`)
5. Confirm printer shows **Online**
6. Send a test print → confirm it prints a test ticket

If test print fails → see **Printer Troubleshooting** section below.

---

## Printer Troubleshooting

| Symptom | Step |
|---|---|
| Printer light off | Check power cable, switch on |
| Printer light on but no print | Check Ethernet cable — push it firmly in |
| Paper jam message | Open printer cover, clear paper jam, reload roll, press Feed |
| Out of paper | Replace paper roll (80mm), close cover, press Feed |
| Still offline after cable check | Restart printer (power off/on), wait 30 seconds |
| Still offline after restart | Call manager / OrderHub support |

If printer was offline and comes back, check **Orders** page — queued orders will print automatically.

---

## System Status Panel

Your manager or support team may ask you to check the **System Status** panel.

Ask your manager for the link: `https://app.orderhub.io/api/v1/health/staff-status?locationId=XXXX`

This page shows:
- **System status**: online / offline
- **Printer status**: online / offline
- **Last print time**: when the last successful print happened
- **Providers**: whether Uber Eats and Deliveroo are connected
- **Action required**: none / check printer / contact support

Share this information with the support team if they ask.

This page does NOT show any passwords, credentials, or financial information.

---

## Quick Reference

```
Log in:         https://app.orderhub.io
Orders page:    Accept → Preparing → Ready → Dispatch/Complete
Kitchen:        KDS page — Bump when ready
Reprint:        Order details → Reprint
Pause item:     Menu → toggle Unavailable
Daily check:    Printer power ✓ / Cable ✓ / Paper ✓ / Test print ✓
Emergency:      Call manager / OrderHub support immediately
```
