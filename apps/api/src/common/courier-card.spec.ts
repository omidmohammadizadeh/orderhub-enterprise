import { cleanVehicle, courierCard, driverVehicle, uberCourierDetails } from "./courier-card";

describe("courier card", () => {
  it("cleans what a driver types", () => {
    expect(cleanVehicle({ make: "  Toyota ", model: "Prius", colour: "Silver", plate: "ab12 cde!" })).toEqual({
      type: null,
      make: "Toyota",
      model: "Prius",
      colour: "Silver",
      plate: "AB12 CDE",
    });
    expect(cleanVehicle({ plate: "-" }).plate).toBeNull();
    expect(cleanVehicle(null)).toEqual({ type: null, make: null, model: null, colour: null, plate: null });
  });

  it("gives no vehicle when the driver entered nothing", () => {
    expect(driverVehicle({ vehicleType: null, metadata: {} })).toBeNull();
    expect(driverVehicle({ vehicleType: "Car", metadata: { vehicle: { plate: "AB12CDE" } } })).toMatchObject({
      type: "Car",
      plate: "AB12CDE",
    });
  });

  it("keeps Uber's photo, car and rating", () => {
    const d = uberCourierDetails({
      name: "Maria",
      img_href: "https://d1a3f4spazzrp4.cloudfront.net/x.jpeg",
      vehicle_type: "car",
      vehicle_make: "Ford",
      vehicle_model: "Focus",
      vehicle_color: "white",
      rating: "4.93",
    });
    expect(d).toMatchObject({ name: "Maria", rating: 4.9, vehicle: { make: "Ford", colour: "white" } });
    expect(uberCourierDetails({ name: "Sam", img_href: "http://insecure/x.jpg" })!.photoUrl).toBeNull();
    expect(uberCourierDetails({})).toBeNull();
  });

  it("never shows one courier's details on another", () => {
    const saved = { name: "Maria", photoUrl: "https://x/y.jpg", vehicle: { make: "Ford" }, rating: 4.9 };
    expect(courierCard("Maria", saved)!.photoUrl).toBe("https://x/y.jpg");
    expect(courierCard("Sam", saved)).toEqual({ name: "Sam", photoUrl: null, vehicle: null, rating: null });
    expect(courierCard(null, saved)).toBeNull();
  });
});
