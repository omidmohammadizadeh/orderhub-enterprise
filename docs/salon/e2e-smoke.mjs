// Salon end-to-end smoke test — drives the whole API (setup, diary, checkout,
// online booking, double-booking race, manage link, deposits fallback, time
// off, walk-in queue, reports, imports, tenant isolation) against a LOCAL API.
//
// NEVER point this at production: it books, cancels and checks out.
//
//   1. Fresh scratch DB:  createdb orderhub_salon_test && prisma migrate deploy && tsx prisma/seed.ts
//   2. API on :4610 against that DB (see docs/local-setup.md for env)
//   3. node docs/salon/e2e-smoke.mjs        (API=… LOC=… to override)
//
// Booking endpoints are rate limited (10/min per IP): wait a minute between runs.
const API = process.env.API ?? "http://localhost:4610/api/v1";
if (!/localhost|127\.0\.0\.1/.test(API)) {
  console.error(`Refusing to run against ${API} — local API only.`);
  process.exit(1);
}
const LOC = process.env.LOC ?? "loc_demo_001";
let token = "";
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log("  ✓", msg);
  else {
    failures++;
    console.log("  ✗", msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
};
async function call(method, path, body, auth = true) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const tz = "Europe/London";
function londonDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}
function at(date, hhmm) {
  // London wall time → ISO (handles BST via Intl)
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asUtc - guess)).toISOString();
}
// A weekday a few days out (skip Sunday — default hours close it).
let D = londonDate(2);
for (let i = 2; i < 9; i++) {
  const d = londonDate(i);
  const dow = new Date(d + "T12:00:00Z").getUTCDay();
  if (dow >= 1 && dow <= 5) { D = d; break; }
}

console.log("== Login");
const login = await call("POST", "/auth/login", { email: "admin@demo.orderhub.io", password: "Demo1234!" }, false);
token = login.data?.tokens?.accessToken;
ok(!!token, "logged in");

console.log("== S1: make the location a barber shop");
let r = await call("POST", "/salon/enable", { locationId: LOC, trade: "BARBER", starterServices: true, firstStaffName: "Jay" });
ok(r.status === 201 && r.data.isSalon, "enabled as SALON", r.data);
ok(r.data.settings.queueEnabled === true && r.data.settings.trade === "BARBER", "barber defaults (queue on)");
r = await call("PUT", `/salon/settings?locationId=${LOC}`, { onlineBookingEnabled: true, leadTimeMins: 0, slotStepMins: 15 });
ok(r.data.settings.onlineBookingEnabled === true, "online booking switched on");
r = await call("PUT", `/salon/settings?locationId=${LOC}`, { slotStepMins: 7, leadTimeMins: -5 });
ok(r.data.settings.slotStepMins === 15 && r.data.settings.leadTimeMins === 0, "bad settings are clamped");

r = await call("GET", `/salon/services?locationId=${LOC}`);
ok(r.data.length === 8, "8 starter services", r.data.length);
const fade = r.data.find((s) => s.name === "Skin fade");
const beard = r.data.find((s) => s.name === "Beard trim & shape");
const cut = r.data.find((s) => s.name === "Haircut");
ok(fade && fade.addons.length === 2, "skin fade has 2 add-ons");

r = await call("POST", `/salon/services?locationId=${LOC}`, { name: "", price: 10 });
ok(r.status === 400, "service needs a name");
r = await call("POST", `/salon/services?locationId=${LOC}`, { name: "Deposit cut", category: "Test", price: 30, durationMins: 45, depositType: "FIXED", depositValue: 10 });
ok(r.status === 201 && r.data.depositType === "FIXED", "service with deposit");
const depCut = r.data;

r = await call("GET", `/salon/staff?locationId=${LOC}`);
ok(r.data.length === 1 && r.data[0].name === "Jay", "first barber created");
const jay = r.data[0];
r = await call("POST", `/salon/staff?locationId=${LOC}`, {
  name: "Sam",
  title: "Senior barber",
  weeklyHours: { monday: [{ from: "10:00", to: "16:00" }], tuesday: [{ from: "10:00", to: "16:00" }], wednesday: [{ from: "10:00", to: "16:00" }], thursday: [{ from: "10:00", to: "16:00" }], friday: [{ from: "10:00", to: "16:00" }] },
  priceOverrides: { [fade.id]: 26 },
  commissionPercent: 40,
});
ok(r.status === 201 && r.data.weeklyHours.monday?.[0]?.from === "10:00", "second barber with own hours");
const sam = r.data;
r = await call("POST", `/salon/staff?locationId=${LOC}`, { name: "Kid specialist", serviceIds: [r.data.id] });
ok(r.status === 400, "unknown serviceIds rejected");

console.log(`== S1: availability on ${D}`);
r = await call("GET", `/salon/availability?locationId=${LOC}&date=${D}&services=${fade.id}&staffId=${sam.id}`);
ok(r.status === 200, "availability ok", r.data);
const samSlots = r.data.slots.map((s) => new Date(s.startsAt).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }));
ok(samSlots[0] === "10:00" && samSlots.at(-1) === "15:30", `Sam 10:00–15:30 (${samSlots[0]}…${samSlots.at(-1)})`);
ok(r.data.total === 26, "Sam's own price for skin fade", r.data.total);
r = await call("GET", `/salon/availability?locationId=${LOC}&date=${D}&services=${fade.id}:${fade.addons[0].id}`);
ok(r.data.durationMins === 45, "add-on adds 15 min", r.data.durationMins);
const anySlot = r.data.slots.find((s) => s.startsAt === at(D, "10:00"));
ok(anySlot && anySlot.staffIds.length === 2, "10:00 free with either barber");

console.log("== S1: book from the diary");
r = await call("POST", "/salon/appointments", {
  locationId: LOC, staffId: jay.id, startsAt: at(D, "10:00"),
  services: [{ serviceId: fade.id, addonIds: [fade.addons[0].id] }],
  customerName: "Alex Client", customerPhone: "07700 900123", customerEmail: "alex@example.com", source: "PHONE",
});
ok(r.status === 201 && r.data.status === "CONFIRMED", "booked Alex with Jay 10:00", r.data);
const a1 = r.data;
ok(Number(a1.totalPrice) === 30, "price 22 + 8 add-on", a1.totalPrice);
r = await call("POST", "/salon/appointments", {
  locationId: LOC, staffId: jay.id, startsAt: at(D, "10:30"),
  services: [{ serviceId: cut.id }], customerName: "Clash",
});
ok(r.status === 400, "clash with Jay at 10:30 refused", r.data);
r = await call("POST", "/salon/appointments", {
  locationId: LOC, staffId: jay.id, startsAt: at(D, "10:30"),
  services: [{ serviceId: cut.id }], customerName: "Squeeze", force: true,
});
ok(r.status === 201, "…but force squeezes them in");
const squeeze = r.data;
r = await call("GET", `/salon/availability?locationId=${LOC}&date=${D}&services=${cut.id}&staffId=${jay.id}`);
const jaySlots = r.data.slots.map((s) => s.startsAt);
ok(!jaySlots.includes(at(D, "10:00")) && !jaySlots.includes(at(D, "10:30")) && jaySlots.includes(at(D, "11:00")), "Jay's 10:00 and 10:30 gone, 11:00 free");

console.log("== S1: anyone → quietest barber");
r = await call("POST", "/salon/appointments", {
  locationId: LOC, staffId: "any", startsAt: at(D, "11:00"),
  services: [{ serviceId: cut.id }], customerName: "Anyone Please",
});
ok(r.status === 201 && r.data.staffId === sam.id, "'anyone' went to Sam (Jay is busier)", r.data.staffId);
const anyAppt = r.data;

console.log("== S1: move, status, history");
r = await call("PATCH", `/salon/appointments/${anyAppt.id}`, { startsAt: at(D, "10:00"), staffId: jay.id });
ok(r.status === 400, "move onto Jay's 10:00 refused");
r = await call("PATCH", `/salon/appointments/${anyAppt.id}`, { startsAt: at(D, "12:00") });
ok(r.status === 200 && r.data.startsAt === at(D, "12:00"), "moved to 12:00");
r = await call("PATCH", `/salon/appointments/${squeeze.id}`, { staffId: sam.id, startsAt: at(D, "10:30") });
ok(r.status === 200 && r.data.staffId === sam.id, "squeeze moved to Sam");
r = await call("POST", `/salon/appointments/${squeeze.id}/status`, { status: "NO_SHOW" });
ok(r.data.status === "NO_SHOW", "no-show");
r = await call("POST", `/salon/appointments/${squeeze.id}/status`, { status: "IN_SERVICE" });
ok(r.status === 400, "can't go no-show → in service");
r = await call("POST", `/salon/appointments/${squeeze.id}/status`, { status: "CONFIRMED" });
ok(r.status === 201 && r.data.status === "CONFIRMED", "undo no-show");
r = await call("POST", `/salon/appointments/${a1.id}/status`, { status: "COMPLETED" });
ok(r.status === 400, "can't mark done without checkout");
r = await call("POST", `/salon/appointments/${a1.id}/status`, { status: "CHECKED_IN" });
ok(r.data.status === "CHECKED_IN" && r.data.checkedInAt, "checked in");
r = await call("GET", `/salon/clients?locationId=${LOC}&q=alex`);
ok(r.data.length === 1 && r.data[0].phone === "07700 900123", "client search finds Alex");

console.log("== S3: checkout (cash) → order → paid → completed");
r = await call("GET", `/salon/appointments/${a1.id}/checkout`);
ok(r.data.subtotal === 30 && r.data.lines.length === 2, "checkout preview: service + add-on lines", r.data);
r = await call("POST", `/salon/appointments/${a1.id}/checkout`, { paymentMethod: "CASH", tipAmount: 5, extras: [{ name: "Matt clay", price: 12 }] });
ok(r.status === 201 && r.data.amount === 47 && !r.data.paid, "cash bill £47 (30 + 12 clay + 5 tip)", r.data);
const order1 = r.data.orderId;
r = await call("GET", `/orders/${order1}`);
ok(r.data.items?.length === 3 && Number(r.data.tipAmount) === 5 && r.data.isWalkIn === true, "order has 3 lines, tip, walk-in", { items: r.data.items?.length, tip: r.data.tipAmount });
r = await call("PATCH", `/orders/${order1}/payment-status`, { paymentStatus: "PAID", paymentMethod: "CASH" });
ok(r.status === 200, "cash taken (till endpoint)", r.status);
await new Promise((res) => setTimeout(res, 800));
r = await call("GET", `/orders/${order1}`);
ok(r.data.status === "COMPLETED", "salon counter sale auto-completed", r.data.status);
r = await call("GET", `/salon/appointments/${a1.id}`);
ok(r.data.status === "COMPLETED" && r.data.tipAmount === 5, "appointment COMPLETED with tip via event", { s: r.data.status, tip: r.data.tipAmount });

console.log("== S3: 'from' price + discount + paid another way");
r = await call("POST", `/salon/appointments/${anyAppt.id}/checkout`, { paymentMethod: "EXTERNAL", prices: [{ index: 0, price: 20 }], discount: 5 });
ok(r.status === 201 && r.data.paid && r.data.amount === 15, "settled £15 (20 − 5)", r.data);
await new Promise((res) => setTimeout(res, 800));
r = await call("GET", `/salon/appointments/${anyAppt.id}`);
ok(r.data.status === "COMPLETED" && r.data.totalPrice === 20, "completed; final price 20 recorded", { s: r.data.status, p: r.data.totalPrice });

console.log("== S3: quick walk-in sale at the chair");
r = await call("POST", "/salon/quick-sale", { locationId: LOC, staffId: sam.id, services: [{ serviceId: beard.id }], paymentMethod: "EXTERNAL" });
ok(r.status === 201 && r.data.paid, "quick sale paid", r.data);
await new Promise((res) => setTimeout(res, 800));
r = await call("GET", `/salon/appointments/${r.data.appointmentId}`);
ok(r.data.status === "COMPLETED" && r.data.source === "WALK_IN", "walk-in recorded against Sam");

console.log("== S2: public booking page");
r = await call("GET", `/salon/public/shop/${LOC}`, null, false);
ok(r.data.onlineBookingEnabled && r.data.services.length >= 8 && r.data.staff.length === 2, "public shop: services + team");
ok(!("commissionPercent" in r.data.staff[0]) && !("userId" in r.data.staff[0]), "public team has no private fields");
r = await call("GET", `/salon/public/shop/${LOC}/days?from=${D}&days=7&services=${cut.id}`, null, false);
ok(r.data.days.length === 7, "7-day strip");
r = await call("GET", `/salon/public/shop/${LOC}/slots?date=${D}&services=${cut.id}&staffId=${sam.id}`, null, false);
const pubSlot = r.data.slots.find((s) => s.startsAt === at(D, "14:00"));
ok(!!pubSlot, "Sam free at 14:00 online");
r = await call("POST", `/salon/public/shop/${LOC}/book`, { staffId: sam.id, startsAt: at(D, "14:00"), services: [{ serviceId: cut.id }], customerName: "Online Olly", customerPhone: "07700900222" }, false);
ok(r.status === 400, "online needs an email", r.data);
const bookBody = { staffId: sam.id, startsAt: at(D, "14:00"), services: [{ serviceId: cut.id }], customerName: "Online Olly", customerPhone: "07700900222", customerEmail: "olly@example.com" };
// Race: two guests, same slot, same moment.
const [b1, b2] = await Promise.all([
  call("POST", `/salon/public/shop/${LOC}/book`, bookBody, false),
  call("POST", `/salon/public/shop/${LOC}/book`, { ...bookBody, customerName: "Racer", customerEmail: "racer@example.com" }, false),
]);
const wins = [b1, b2].filter((x) => x.status === 201);
ok(wins.length === 1, "double-booking race: exactly one wins", [b1.status, b2.status, b1.data?.message, b2.data?.message]);
const olly = wins[0].data.appointment;
ok(olly.status === "CONFIRMED" && olly.token, "online booking confirmed with manage token");

console.log("== S2: manage my booking");
r = await call("GET", `/salon/public/booking/${olly.token}`, null, false);
ok(r.data.reference.startsWith("S-") && r.data.canChange && r.data.freeChange, "manage page: can change free", r.data);
ok(!("staffNotes" in r.data) && !("customerPhone" in r.data), "manage page hides staff-only fields");
r = await call("GET", `/salon/public/booking/${olly.token}/slots?date=${D}`, null, false);
ok(r.data.slots.some((s) => s.startsAt === at(D, "15:00")), "reschedule slots offered");
r = await call("POST", `/salon/public/booking/${olly.token}/reschedule`, { startsAt: at(D, "15:00") }, false);
ok(r.status === 201 && r.data.startsAt === at(D, "15:00"), "guest moved to 15:00", r.data);
r = await call("POST", `/salon/public/booking/${olly.token}/reschedule`, { startsAt: at(D, "10:30") }, false);
ok(r.status === 400, "guest can't move onto a taken slot (Sam has the squeeze at 10:30)", r.status);
r = await call("POST", `/salon/public/booking/${olly.token}/cancel`, null, false);
ok(r.data.status === "CANCELLED", "guest cancelled");
r = await call("POST", `/salon/public/booking/${olly.token}/cancel`, null, false);
ok(r.status === 400, "can't cancel twice");

console.log("== S2: deposit service (no Stripe locally → books without deposit, says why)");
r = await call("POST", `/salon/public/shop/${LOC}/book`, { staffId: jay.id, startsAt: at(D, "15:00"), services: [{ serviceId: depCut.id }], customerName: "Dee Posit", customerPhone: "07700900333", customerEmail: "dee@example.com" }, false);
ok(r.status === 201 && r.data.checkoutUrl === null && r.data.appointment.status === "CONFIRMED", "falls back to no deposit", r.data);
r = await call("GET", `/salon/appointments?locationId=${LOC}&from=${at(D, "00:00")}&to=${at(D, "23:59")}`);
const dee = r.data.find((x) => x.customerName === "Dee Posit");
ok(dee && /Deposit not taken/.test(dee.staffNotes ?? ""), "diary note explains missing deposit");

console.log("== S2: guard rails");
r = await call("PUT", `/salon/settings?locationId=${LOC}`, { onlineBookingEnabled: false });
r = await call("POST", `/salon/public/shop/${LOC}/book`, bookBody, false);
ok(r.status === 400, "online booking off → refused");
r = await call("PUT", `/salon/settings?locationId=${LOC}`, { onlineBookingEnabled: true, leadTimeMins: 0 });
r = await call("PATCH", `/salon/services/${beard.id}`, { bookableOnline: false });
r = await call("POST", `/salon/public/shop/${LOC}/book`, { ...bookBody, services: [{ serviceId: beard.id }], startsAt: at(D, "13:00") }, false);
ok(r.status === 400 && /can't be booked online/.test(r.data.message), "phone-only service refused online", r.data);

console.log("== S2: time off blocks slots");
r = await call("POST", "/salon/time-off", { staffId: sam.id, startsAt: at(D, "13:00"), endsAt: at(D, "16:00"), reason: "Dentist" });
ok(r.status === 201, "time off added (no clash)", r.data);
r = await call("POST", "/salon/time-off", { staffId: jay.id, startsAt: at(D, "09:00"), endsAt: at(D, "18:00") });
ok(r.status === 400, "time off over bookings refused", r.data?.message);
r = await call("GET", `/salon/availability?locationId=${LOC}&date=${D}&services=${cut.id}&staffId=${sam.id}`);
ok(!r.data.slots.some((s) => s.startsAt >= at(D, "13:00") && s.startsAt < at(D, "16:00")), "Sam has nothing 13:00–16:00");

console.log("== S4: walk-in queue");
r = await call("POST", "/salon/queue", { locationId: LOC, customerName: "Walk One", serviceIds: [cut.id] });
ok(r.status === 201 && r.data.entries.length === 1, "joined queue (staff)", r.data);
r = await call("POST", `/salon/public/queue/${LOC}/join`, { customerName: "Phone Two", customerPhone: "07700900444", serviceIds: [fade.id] }, false);
ok(r.status === 201 && r.data.token, "joined queue online", r.data);
const ticket = r.data.token;
r = await call("POST", `/salon/public/queue/${LOC}/join`, { customerName: "Phone Two", customerPhone: "07700900444" }, false);
ok(r.data.already === true && r.data.token === ticket, "same phone doesn't queue twice");
r = await call("GET", `/salon/public/queue/ticket/${ticket}`, null, false);
ok(r.data.position === 2 && r.data.ahead === 1, "ticket: 2nd in line", r.data);
r = await call("GET", `/salon/public/queue/${LOC}`, null, false);
ok(r.data.waiting.length === 2 && !JSON.stringify(r.data).includes("07700900444"), "TV board: no phone numbers", r.data);
r = await call("GET", `/salon/queue?locationId=${LOC}`);
const first = r.data.entries.find((e) => e.customerName === "Walk One");
r = await call("POST", `/salon/queue/${first.id}/call`, { staffId: jay.id });
ok(r.data.entries.find((e) => e.id === first.id).status === "CALLED", "called up");
r = await call("POST", `/salon/queue/${first.id}/start`, { staffId: jay.id });
ok(r.status === 201 && r.data.appointmentId, "in the chair → appointment made", r.data);
const qAppt = r.data.appointmentId;
r = await call("POST", `/salon/appointments/${qAppt}/checkout`, { paymentMethod: "EXTERNAL" });
await new Promise((res) => setTimeout(res, 800));
r = await call("GET", `/salon/queue?locationId=${LOC}`);
ok(!r.data.entries.some((e) => e.id === first.id), "paid → leaves the queue (DONE)");
r = await call("POST", `/salon/public/queue/ticket/${ticket}/leave`, null, false);
ok(r.data.status === "LEFT", "guest left the queue");

console.log("== S5: reports");
r = await call("GET", `/salon/reports?locationId=${LOC}&from=${D}&to=${D}`);
ok(r.status === 200, "report ok", r.data);
const jr = r.data.staff.find((s) => s.name === "Jay");
const sr = r.data.staff.find((s) => s.name === "Sam");
ok(jr && jr.completed === 1 && jr.takings === 30 && jr.tips === 5, "Jay: 1 done, £30, £5 tip (product sale not counted as service takings)", jr);
ok(sr && sr.commission === round2(sr.takings * 0.4), "Sam commission 40%", sr);
ok(r.data.totals.noShows === 0 && r.data.byDay.length === 1, "totals + byDay");

console.log("== S5: imports from another system");
r = await call("POST", `/salon/services/import?locationId=${LOC}`, { csv: "Service name,Category,Duration,Retail price\nSkin fade,Haircuts,35min,£24.00\nDesigner line,Extras,15 min,£6", preview: true });
ok(r.status === 201 && r.data.plan.length === 2 && r.data.plan[0].action === "update" && r.data.plan[1].action === "create" && r.data.created === 0, "price list preview: 1 update, 1 new, nothing written", r.data);
r = await call("POST", `/salon/services/import?locationId=${LOC}`, { csv: "Service name,Category,Duration,Retail price\nSkin fade,Haircuts,35min,£24.00\nDesigner line,Extras,15 min,£6", preview: false });
ok(r.data.created === 1 && r.data.updated === 1, "price list imported", r.data);
r = await call("GET", `/salon/services?locationId=${LOC}`);
ok(r.data.find((x) => x.name === "Skin fade").price === 24 && r.data.find((x) => x.name === "Skin fade").durationMins === 35, "skin fade updated to £24 / 35 min");
r = await call("POST", `/salon/clients/import?locationId=${LOC}`, { csv: "First Name,Last Name,Mobile Number,Email\nZara,Imported,07700 900777,zara@example.com\nNobody,,,", preview: true });
ok(r.data.new === 1 && r.data.imported === 0 && r.data.skipped.length === 1, "client preview: 1 new, 1 skipped", r.data);
r = await call("POST", `/salon/clients/import?locationId=${LOC}`, { csv: "First Name,Last Name,Mobile Number,Email\nZara,Imported,07700 900777,zara@example.com", preview: false });
ok(r.data.imported === 1, "client imported", r.data);
r = await call("POST", `/salon/clients/import?locationId=${LOC}`, { csv: "First Name,Last Name,Mobile Number,Email\nZara,Imported,07700 900777,zara@example.com", preview: true });
ok(r.data.new === 0 && r.data.alreadyKnown === 1, "re-import recognises her (phone normalised)", r.data);
r = await call("GET", `/salon/clients?locationId=${LOC}&q=zara`);
ok(r.data.length === 1 && r.data[0].name === "Zara Imported", "diary search finds the imported client", r.data);
r = await call("GET", `/salon/clients?locationId=${LOC}&q=07700900777`);
ok(r.data.length === 1, "…and by her number as typed", r.data);

console.log("== Cross-tenant isolation");
const admin = await call("POST", "/auth/login", { email: "admin@orderhub.io", password: "Admin!OrderHub2026" }, false);
const save = token; token = admin.data?.tokens?.accessToken;
r = await call("GET", `/salon/appointments/${a1.id}`);
ok(r.status === 404, "another tenant can't read the appointment", r.status);
token = save;

function round2(n) { return Math.round(n * 100) / 100; }
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
