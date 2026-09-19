// Transcribed from the Order model's field `example` values in Glovo's
// restaurant Partners API spec (definition.yaml, 2026-09-19). NOT a real
// envelope — the first real `order dispatched` must be diffed against these.

/** A Glovo-courier order: no address, "N/A" phone, delivery fields null. */
export const GLOVO_COURIER_ORDER = {
  order_id: "12345",
  store_id: "OH-TESTSTORE1",
  order_time: "2018-06-08 14:24:53",
  estimated_pickup_time: "2018-06-08 14:45:44",
  utc_offset_minutes: "60",
  payment_method: "DELAYED",
  currency: "EUR",
  order_code: "BA7DWBUL",
  allergy_info: "I am allergic to tomato",
  special_requirements: "Make sure there is no meat",
  estimated_total_price: 3080,
  delivery_fee: null,
  minimum_basket_surcharge: null,
  customer_cash_payment_amount: null,
  courier: { name: "Flash", phone_number: "+34666666666" },
  customer: {
    name: "Waldo",
    phone_number: "N/A",
    hash: "11111111-2222-3333-4444-555555555555",
    invoicing_details: null,
  },
  products: [
    {
      id: "pd1",
      purchased_product_id: "A1",
      name: "Burger",
      price: 1000,
      discount: 0,
      quantity: 2,
      attributes: [
        { id: "at1", name: "Extra meat", price: 300, quantity: 1 },
        { id: "at2", name: "Water (33 cl)", price: 0, quantity: 1 },
      ],
    },
    {
      id: "pd2",
      purchased_product_id: "A2",
      name: "Ice cream",
      price: 480,
      discount: 0,
      quantity: 1,
      attributes: [{ id: "at5", name: "Vanilla", price: 0, quantity: 1 }],
    },
  ],
  delivery_address: null,
  bundled_orders: ["order-id-1", "order-id-2"],
  pick_up_code: "433",
  is_picked_up_by_customer: false,
  cutlery_requested: true,
  partner_discounts_products: 0,
  glovo_discounts_products: 0,
  partner_discounted_products_total: 3080,
  discounted_products_total: 3080,
  total_customer_to_pay: null,
  loyalty_card: null,
  voucher_code: null,
  service_fee: null,
};

/** A marketplace order: the store delivers, so address + customer totals arrive. */
export const GLOVO_MARKETPLACE_ORDER = {
  ...GLOVO_COURIER_ORDER,
  order_id: "67890",
  order_code: "MKT0001",
  payment_method: "CASH",
  delivery_fee: 250,
  minimum_basket_surcharge: 0,
  service_fee: 120,
  customer_cash_payment_amount: 5000,
  total_customer_to_pay: 3450,
  customer: { name: "Waldo", phone_number: "+34611222333", hash: "h-2" },
  delivery_address: {
    label: "123 Fake Street, Gotham",
    latitude: 41.3971955,
    longitude: 2.2001737,
    street_name: "Fake Street",
    street_number: "123",
    province: "Barcelona",
    postal_code: "08001",
    floor_number: "2",
    door_number: "4",
    building_name: "The Conrad",
    additional_information: "The red door next to the blue sign.",
  },
  bundled_orders: null,
};

/** The customer collects. */
export const GLOVO_PICKUP_ORDER = {
  ...GLOVO_COURIER_ORDER,
  order_id: "24680",
  order_code: "PICK0001",
  is_picked_up_by_customer: true,
};

/** The spec's combo example, with a promotion. */
export const GLOVO_COMBO_ORDER = {
  ...GLOVO_COURIER_ORDER,
  order_id: "13579",
  estimated_total_price: 10500,
  partner_discounts_products: 1000,
  glovo_discounts_products: 500,
  discounted_products_total: 9000,
  products: [
    {
      id: "pd3",
      purchased_product_id: "A3",
      name: "Burger Combo!",
      price: 10000,
      discount: 0,
      quantity: 1,
      attributes: [{ id: "at7", name: "Very large!", price: 300, quantity: 1 }],
      sub_products: [
        {
          id: "sp1",
          name: "Cheese Burger",
          price: 0,
          discount: 0,
          quantity: 1,
          attributes: [{ id: "at8", name: "Extra cheese", price: 100, quantity: 1 }],
        },
        { id: "sp2", name: "Fries", price: 0, discount: 0, quantity: 1, attributes: [] },
        {
          id: "sp3",
          name: "Coke",
          price: 0,
          discount: 0,
          quantity: 1,
          attributes: [{ id: "at9", name: "Extra ice", price: 100, quantity: 1 }],
        },
      ],
    },
  ],
};

export const GLOVO_CANCELLATION = {
  order_id: "12345",
  store_id: "OH-TESTSTORE1",
  cancel_reason: "USER_ERROR",
  payment_strategy: "PAY_PRODUCTS",
};
