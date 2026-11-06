// What a customer sees about the person bringing their food, in one shape
// whoever that is: our own driver (car details they typed into the driver
// app), an Uber Direct courier (photo, car and rating from Uber), or a
// courier we only know by name (JET Go, a shop driver with no details).
// Every field but the name is optional and the card shows what it has.

export type Vehicle = {
  type: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  plate: string | null;
};

export type CourierCard = {
  name: string;
  photoUrl: string | null;
  vehicle: Vehicle | null;
  rating: number | null;
};

const MAX_TEXT = 30;

function text(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
}

/** UK-style plates are letters, digits and one space; anything else is a typo. */
function plate(v: unknown): string | null {
  const t = text(v, 12)?.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  return t && /[A-Z0-9]{2,}/.test(t.replace(/ /g, "")) ? t : null;
}

/** A vehicle with nothing in it is no vehicle. */
function orNull(v: Vehicle): Vehicle | null {
  return v.make || v.model || v.colour || v.plate || v.type ? v : null;
}

/** What a driver typed into the driver app, cleaned for storage. */
export function cleanVehicle(input: any): Vehicle {
  return {
    type: text(input?.type, 20),
    make: text(input?.make),
    model: text(input?.model),
    colour: text(input?.colour),
    plate: plate(input?.plate),
  };
}

/** Our own driver's vehicle: details in Driver.metadata.vehicle, the type in
 *  its own column (set by the shop when they added the driver). */
export function driverVehicle(driver: { vehicleType?: string | null; metadata?: unknown }): Vehicle | null {
  const v = (driver.metadata as any)?.vehicle ?? {};
  return orNull({ ...cleanVehicle(v), type: text(driver.vehicleType, 20) ?? text(v.type, 20) });
}

/** The courier block Uber Direct sends, reduced to what we keep. Stored with
 *  the courier's name so a later courier on the same order never wears it. */
export function uberCourierDetails(courier: any): Record<string, unknown> | null {
  const name = text(courier?.name, 80);
  if (!name) return null;
  const photo = typeof courier?.img_href === "string" && /^https:\/\//.test(courier.img_href) ? courier.img_href : null;
  const rating = Number(courier?.rating);
  return {
    name,
    photoUrl: photo,
    vehicle: orNull({
      type: text(courier?.vehicle_type, 20),
      make: text(courier?.vehicle_make),
      model: text(courier?.vehicle_model),
      colour: text(courier?.vehicle_color),
      plate: plate(courier?.vehicle_license_plate ?? courier?.license_plate),
    }),
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? Math.round(rating * 10) / 10 : null,
  };
}

/** A third-party courier's card: the extras only if they're this courier's. */
export function courierCard(courierName: string | null | undefined, saved: unknown): CourierCard | null {
  const name = text(courierName, 80);
  if (!name) return null;
  const s = saved as any;
  const mine = s && s.name === name;
  return {
    name,
    photoUrl: mine ? s.photoUrl ?? null : null,
    vehicle: mine ? s.vehicle ?? null : null,
    rating: mine ? s.rating ?? null : null,
  };
}
