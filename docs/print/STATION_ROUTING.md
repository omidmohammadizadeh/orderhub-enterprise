# Station routing

## The walk

For each order item at print-job creation time, the routing engine
walks **most specific first**:

1. `MenuItemStation` — explicit item → station override
2. `ModifierGroupStation` — first matching modifier group wins
3. `MenuCategoryStation` — category default
4. `Brand.defaultStationId` — brand fallback
5. `Location.defaultKitchenStationId` — location fallback
6. **null** → unrouted (surfaces in the unrouted-warning panel)

Each station has a `defaultPrinterId`. The PrintJob row is created
with that printerId. If a station has no default printer, the job is
created with `printerId = null` and reported as unrouted.

## Assigning rules

API (operator dashboard / future Menu Manager UI):

```
PUT /v1/printer-stations/menu-items/:menuItemId/routes
PUT /v1/printer-stations/categories/:categoryId/routes
PUT /v1/printer-stations/modifier-groups/:groupId/routes
   body: { stationIds: ["…","…"] }   // replace wholesale
```

## Worked example

Order: 1× Margherita pizza, 1× Chicken burger, 1× Ben&Jerry's tub.

Stations at the location:
- Pizza station → Kitchen printer A
- Burger station → Kitchen printer B
- Dessert station → Label printer

Rules:
- Margherita → Pizza station (MenuItemStation)
- Burger category → Burger station (CategoryStation)
- "Ben&Jerry's choice" modifier group → Dessert station
  (ModifierGroupStation)

Engine output:
- Kitchen printer A → ticket for Margherita
- Kitchen printer B → ticket for Burger
- Label printer → ticket for ice cream
- Receipt printer (Location.receiptPrinterId) → one customer receipt
- Dispatch printer (Location.dispatchPrinterId) → driver slip (delivery
  order only)

Five PrintJob rows, each idempotency-keyed so a retry doesn't
duplicate.
