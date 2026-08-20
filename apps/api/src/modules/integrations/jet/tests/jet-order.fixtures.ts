// The three worked order examples from the JET Connect OpenAPI document,
// transcribed verbatim (paths: /initial/{receiveOrder} → requestBody →
// examples: "Delivery by partner", "Delivery by restaurant", "Pick-up").
//
// ⚠️ These are SPEC examples, not captured production payloads. They are the
// best evidence available before the first pilot order and they are what the
// transformer is written against — but the receiver logs and persists the real
// envelope precisely because every other integration we have built found the
// documentation wrong somewhere. When the first live order lands, diff it
// against these and fix the fixtures first.

export const DELIVERY_BY_PARTNER = {
  id: "38bbeb45-f520-4438-a44f-0fcdbb29e166",
  third_party_order_reference: "22721763",
  type: "delivery-by-delivery-partner",
  posLocationId: "AKZ12",
  location: { id: 1296, timezone: "Europe/London" },
  items: [
    {
      name: "Cheeseburger",
      description: "",
      plu: "M2",
      price: 1700,
      notes: "",
      substitution: { preference: "bestmatch" },
      children: [
        { name: "Extra Sauce", description: "", plu: "R3", price: 100, unitDepositAmount: 10 },
      ],
    },
  ],
  created_at: "1606780145",
  channel: { name: "Just Eat", id: 32 },
  collect_at: "1606780980",
  collection_notes: "Driver will be wearing a blue shirt",
  kitchen_notes: "",
  payment_method: "CARD",
  tender_type: "Flyt",
  payment: {
    items_in_cart: { inc_tax: 2160, tax: 360 },
    adjustments: [],
    final: { inc_tax: 2160, tax: 360 },
    deposit: 10,
  },
  driver: { first_name: "John", last_name: "Smith", phone_number: "555-111-3344" },
  delivery: {
    first_name: "****************",
    last_name: "****************",
    phone_number: "55555 113 000",
    phone_masking_code: "",
    line_one: "**********************",
    line_two: "",
    city: "*****",
    postcode: "*****",
    email: "customer@email.hidden",
    coordinates: {
      latitude: 49.898498728223224,
      longitude: -97.13560152293131,
      latitude_as_string: "49.8984",
      longitude_as_string: "-122.2966",
    },
  },
  extras: {},
  promotions: [
    {
      type: "FREE_ITEM_MIN_BASKET",
      items: [
        { name: "Crispy Chicken Twist", description: "", plu: "", price: 419, notes: "", children: [] },
      ],
      promotion_id: "string",
      discount_value: 419,
      offer_id: "string",
    },
  ],
};

export const DELIVERY_BY_MERCHANT = {
  id: "7494e975-4d24-4ea5-bdd6-306b444ccc51",
  third_party_order_reference: "207217603",
  type: "delivery-by-merchant",
  posLocationId: "22617",
  location: { id: 2267, timezone: "US/Mountain" },
  items: [
    {
      name: "Cheesy Pasta",
      description: "",
      plu: "MMcc0",
      price: 500,
      unitDepositAmount: 10,
      notes: "please make it extra cheesy",
      children: [],
      substitution: { preference: "bestmatch" },
    },
  ],
  created_at: "1606780145",
  channel: { name: "Skip", id: 52 },
  deliver_at: "1606780980",
  delivery_notes: "It's the blue house at the end of the block.",
  kitchen_notes: "",
  payment_method: "CASH",
  tender_type: "Flyt",
  payment: {
    items_in_cart: { inc_tax: 600, tax: 100 },
    adjustments: [
      { name: "deliveryFee", price: { inc_tax: 240, tax: 40 } },
      { name: "serviceCharge", price: { inc_tax: 15, tax: 0 } },
    ],
    final: { inc_tax: 855, tax: 140 },
    deposit: 10,
  },
  delivery: {
    first_name: "John",
    last_name: "Doe",
    phone_number: "555-113-0000",
    phone_masking_code: "",
    line_one: "1234 Spicy Street",
    line_two: "",
    city: "Winnipeg",
    postcode: "R3B 0P4",
    email: "customer@email.hidden",
    coordinates: {
      latitude: 49.898498728223224,
      longitude: -97.13560152293131,
      latitude_as_string: "49.8984",
      longitude_as_string: "-122.2966",
    },
  },
  extras: {},
  promotions: [],
};

export const COLLECTION_BY_CUSTOMER = {
  id: "7494e975-4d24-4ea5-bdd6-306b444ccc51",
  third_party_order_reference: "122669877",
  type: "collection-by-customer",
  posLocationId: "32c8b122-f599-441f-aa3a-5081fb89f0e8",
  location: { id: 12642, timezone: "Australia/Sydney" },
  items: [
    {
      name: "Cheese Pizza (Large)",
      description: "",
      plu: "b048118f-87e7-417b-b45e-b123b2b97a52",
      price: 1000,
      unitDepositAmount: 10,
      notes: "",
      children: [],
      substitution: { preference: "bestmatch" },
    },
  ],
  created_at: "1606780145",
  channel: { name: "Menulog", id: 59 },
  collect_at: "1606780980",
  collection_notes: "I will be wearing a green dress",
  kitchen_notes: "Please add extra cheese to the pizza",
  payment_method: "CARD",
  tender_type: "Flyt",
  payment: {
    items_in_cart: { inc_tax: 1000, tax: 0 },
    adjustments: [],
    final: { inc_tax: 1000, tax: 0 },
    deposit: 10,
  },
  collector: {
    first_name: "John",
    last_name: "Doe",
    phone_number: "020 7946 0504",
    phone_masking_code: "1234567890",
  },
  extras: {},
  promotions: [],
};
