// Fills the LOCAL demo location with a believable barber's day (three
// barbers, today's bookings, a lunch break, three walk-ins) for screenshots
// and demos. Local API only — never production.
const API = "http://localhost:4610/api/v1";
if (!/localhost|127\.0\.0\.1/.test(API)) {
  console.error(`Refusing to run against ${API} — local API only.`);
  process.exit(1);
}
const LOC = "loc_demo_001";
const tz = "Europe/London";
let token = "";
async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) console.log("  !", method, path, r.status, d?.message);
  return d;
}
function at(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess)).toISOString();
}
const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

const login = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@demo.orderhub.io", password: "Demo1234!" }) }).then((r) => r.json());
token = login.tokens.accessToken;

await call("POST", "/salon/enable", { locationId: LOC, trade: "BARBER", starterServices: true, firstStaffName: "Jay" });
await call("PUT", `/salon/settings?locationId=${LOC}`, { onlineBookingEnabled: true, leadTimeMins: 0, bookingPolicy: "Please arrive 5 minutes early. Running more than 10 minutes late may mean we need to rebook you." });
const services = await call("GET", `/salon/services?locationId=${LOC}`);
let staff = await call("GET", `/salon/staff?locationId=${LOC}`);
const names = staff.map((s) => s.name);
if (!names.includes("Sam")) await call("POST", `/salon/staff?locationId=${LOC}`, { name: "Sam", title: "Senior barber", bio: "Skin fades and beard sculpting. 9 years behind the chair.", commissionPercent: 45 });
if (!names.includes("Marco")) await call("POST", `/salon/staff?locationId=${LOC}`, { name: "Marco", title: "Barber", bio: "Classic scissor work and hot towel shaves.", commissionPercent: 40 });
staff = await call("GET", `/salon/staff?locationId=${LOC}`);
const S = Object.fromEntries(staff.map((s) => [s.name, s.id]));
await call("PATCH", `/salon/staff/${S.Jay}`, { title: "Owner · Master barber", bio: "Fades, tapers and the odd mullet. Owner since 2019.", commissionPercent: null });
const V = Object.fromEntries(services.map((s) => [s.name, s]));
// Shop hours 09:00–19:00 Mon–Sat via each barber's week.
const week = { monday: [{ from: "09:00", to: "19:00" }], tuesday: [{ from: "09:00", to: "19:00" }], wednesday: [{ from: "09:00", to: "19:00" }], thursday: [{ from: "09:00", to: "20:00" }], friday: [{ from: "09:00", to: "20:00" }], saturday: [{ from: "08:30", to: "17:00" }] };
for (const id of Object.values(S)) await call("PATCH", `/salon/staff/${id}`, { weeklyHours: week });
await call("PATCH", `/salon/staff/${S.Marco}`, { weeklyHours: { ...week, tuesday: [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }] } });

const people = [
  ["Jay", "09:00", "Skin fade", ["Beard trim"], "Liam Carter", "07700 900101", "liam@example.com"],
  ["Jay", "09:45", "Haircut", [], "Noah Patel", "07700 900102", null],
  ["Jay", "10:30", "Skin fade", [], "Oliver Smith", "07700 900103", "oli@example.com"],
  ["Jay", "11:15", "Kids cut (under 12)", [], "Leo Smith", null, null],
  ["Jay", "13:00", "Hot towel shave", [], "George Evans", "07700 900104", null],
  ["Jay", "15:30", "Skin fade", ["Hot towel"], "Harry Green", "07700 900105", "harry@example.com"],
  ["Sam", "09:30", "Beard trim & shape", [], "Arthur Hall", "07700 900106", null],
  ["Sam", "10:00", "Skin fade", ["Beard trim"], "Muhammad Khan", "07700 900107", "mk@example.com"],
  ["Sam", "12:00", "Scissor cut", [], "Jack Wood", "07700 900108", null],
  ["Sam", "14:15", "Skin fade", [], "Freddie Ward", "07700 900109", null],
  ["Sam", "16:00", "Haircut", [], "Theo Clarke", "07700 900110", "theo@example.com"],
  ["Marco", "09:15", "Scissor cut", [], "Henry Baker", "07700 900111", null],
  ["Marco", "10:15", "Hot towel shave", [], "Alfie Turner", "07700 900112", null],
  ["Marco", "14:00", "Buzz cut", [], "Charlie Hill", "07700 900113", null],
  ["Marco", "15:00", "Skin fade", ["Beard trim"], "Oscar Moore", "07700 900114", "oscar@example.com"],
];
const existing = await call("GET", `/salon/appointments?locationId=${LOC}&from=${at(today, "00:00")}&to=${at(today, "23:59")}`);
if (existing.length < 5) {
  for (const [who, time, svc, adds, name, phone, email] of people) {
    const s = V[svc];
    await call("POST", "/salon/appointments", {
      locationId: LOC, staffId: S[who], startsAt: at(today, time), force: true, silent: true,
      services: [{ serviceId: s.id, addonIds: adds.map((a) => s.addons.find((x) => x.name === a)?.id).filter(Boolean) }],
      customerName: name, customerPhone: phone, customerEmail: email,
      source: ["Muhammad Khan", "Theo Clarke", "Oscar Moore", "Harry Green"].includes(name) ? "ONLINE" : "PHONE",
      notes: name === "Liam Carter" ? "Grade 1 sides, scissor on top" : null,
    });
  }
  await call("POST", "/salon/time-off", { staffId: S.Sam, startsAt: at(today, "13:00"), endsAt: at(today, "14:00"), reason: "Lunch" });
}
const q = await call("GET", `/salon/queue?locationId=${LOC}`);
if ((q.entries ?? []).length === 0) {
  await call("POST", "/salon/queue", { locationId: LOC, customerName: "Daniel Price", serviceIds: [V["Skin fade"].id] });
  await call("POST", "/salon/queue", { locationId: LOC, customerName: "Ethan Rose", customerPhone: "07700 900120", serviceIds: [V["Haircut"].id], preferredStaffId: S.Marco });
  await call("POST", "/salon/queue", { locationId: LOC, customerName: "Mason Lee", serviceIds: [V["Beard trim & shape"].id] });
}
console.log("seeded", today);
