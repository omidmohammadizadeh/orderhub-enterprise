// Virtual-brand supplier & ingredient lists for Kitchen training — what every
// kitchen buys for each brand, who sells it and the supplier's product code.
// Rebuilt from the brands' supplier PDFs; photos live in
// public/training/suppliers/<brand slug>/<item slug>.jpg.

export type SupplierCategory =
  | "Meat & protein"
  | "Bread & buns"
  | "Fresh veg & salad"
  | "Sides"
  | "Sauces & dips"
  | "Seasoning"
  | "Desserts"
  | "Drinks"
  | "Packaging"
  | "Equipment";

export const SUPPLIER_CATEGORIES: SupplierCategory[] = [
  "Meat & protein",
  "Bread & buns",
  "Fresh veg & salad",
  "Sides",
  "Sauces & dips",
  "Seasoning",
  "Desserts",
  "Drinks",
  "Packaging",
  "Equipment",
];

export interface Supplier {
  name: string;
  website?: string;
}

// One place for each supplier's name and site, so a list can't spell JJ two ways.
const SUPPLIER_DATA = {
  jj: { name: "JJ Foodservice", website: "https://www.jjfoodservice.co.uk" },
  booker: { name: "Booker", website: "https://www.booker.co.uk" },
  brakes: { name: "Brakes", website: "https://www.brake.co.uk" },
  costco: { name: "Costco", website: "https://www.costco.co.uk" },
  agora: { name: "Agora Greek", website: "https://agoragreekdelicacies.co.uk" },
  asda: { name: "Asda" },
  tesco: { name: "Tesco" },
  supermarket: { name: "Any supermarket" },
  halal: { name: "Halal supermarket" },
  hollandBazaar: { name: "Holland Bazaar" },
  cashCarry: { name: "Cash & carry" },
  ebay: { name: "eBay", website: "https://www.ebay.co.uk" },
} satisfies Record<string, Supplier>;

export type SupplierKey = keyof typeof SUPPLIER_DATA;
export const SUPPLIERS: Record<SupplierKey, Supplier> = SUPPLIER_DATA;

export interface SupplierItem {
  slug: string;
  name: string;
  category: SupplierCategory;
  /** Brand / variety to buy, e.g. "Iceberg", "Letsdough". */
  itemBrand?: string;
  /** In order of preference. */
  suppliers: SupplierKey[];
  /** The first supplier's product code. */
  code?: string;
  /** A direct product page, when the list gives one. */
  link?: string;
  /** The list names a site other than the supplier's own. */
  site?: string;
  image?: boolean;
}

export interface SupplierList {
  slug: string;
  name: string;
  accent: string;
  items: SupplierItem[];
}

const item = (slug: string, name: string, category: SupplierCategory, suppliers: SupplierKey[], extra: Partial<SupplierItem> = {}): SupplierItem => ({
  slug,
  name,
  category,
  suppliers,
  image: true,
  ...extra,
});

export const SUPPLIER_LISTS: SupplierList[] = [
  {
    slug: "monster-burgerz",
    name: "Monster Burgerz",
    accent: "#16a34a",
    items: [
      item("beef-mince", "Flank beef mince, 20% fat", "Meat & protein", ["halal", "brakes", "booker"], { itemBrand: "80/20", code: "BUR122" }),
      item("chicken-fillet", "Chicken fillet", "Meat & protein", ["jj"], { code: "CHI156" }),
      item("chicken-strips", "Chicken strips", "Meat & protein", ["jj"], { code: "CHI606" }),
      item("chicken-strips-alt", "Chicken strips (alternative)", "Meat & protein", ["jj", "booker", "cashCarry"], { code: "CHI014" }),
      item("cheese-slice", "Cheese slices", "Meat & protein", ["jj"]),
      item("brioche-bun", "Brioche bun", "Bread & buns", ["booker", "jj"], { itemBrand: "Letsdough", code: "BUN028" }),
      item("lettuce", "Lettuce", "Fresh veg & salad", ["jj", "supermarket"], { itemBrand: "Iceberg" }),
      item("tomato", "Tomato", "Fresh veg & salad", ["jj", "supermarket"], { itemBrand: "Vine" }),
      item("white-onion", "White onion", "Fresh veg & salad", ["jj", "supermarket"]),
      item("jalapeno", "Jalapeño slices", "Fresh veg & salad", ["jj", "supermarket"], { code: "VEG993" }),
      item("pickles", "Pickles (gherkin slices)", "Fresh veg & salad", ["jj", "supermarket"], { code: "VEG749" }),
      item("caramelised-onion", "Caramelised onion", "Fresh veg & salad", ["booker"], { itemBrand: "Chef's Larder" }),
      item("skin-on-fries", "Skin-on fries", "Sides", ["booker", "jj"], { code: "CHP165" }),
      item("sweet-potato-fries", "Sweet potato fries", "Sides", ["booker", "jj"], { code: "POT099" }),
      item("potato-wedges", "Potato wedges", "Sides", ["jj"], { code: "POT142" }),
      item("onion-rings", "Onion rings", "Sides", ["jj"], { code: "VEG908" }),
      item("mozzarella-sticks", "Mozzarella sticks", "Sides", ["jj"], { code: "VEG890" }),
      item("garlic-sauce", "Garlic sauce", "Sauces & dips", ["booker", "jj"]),
      item("mayo", "Mayo", "Sauces & dips", ["booker"]),
      item("ketchup", "Ketchup", "Sauces & dips", ["booker"]),
      item("bbq-sauce", "BBQ sauce", "Sauces & dips", ["booker"]),
      item("sweet-chilli-sauce", "Sweet chilli sauce", "Sauces & dips", ["booker"]),
      item("peri-peri-sauce", "Peri peri sauce", "Sauces & dips", ["booker"]),
      item("sriracha-sauce", "Sriracha sauce", "Sauces & dips", ["booker", "jj"]),
      item("buffalo-sauce", "Buffalo sauce", "Sauces & dips", ["booker"]),
      item("mustard", "Mustard", "Sauces & dips", ["booker"]),
      item("cajun-powder", "Blackened Cajun powder", "Seasoning", ["booker"]),
      item("can-coke", "Coca-Cola (can)", "Drinks", ["jj"]),
      item("can-diet-coke", "Diet Coke (can)", "Drinks", ["jj"]),
      item("can-dr-pepper", "Dr Pepper (can)", "Drinks", ["jj"]),
      item("can-fanta-orange", "Fanta Orange (can)", "Drinks", ["jj"]),
      item("can-sprite", "Sprite (can)", "Drinks", ["jj"]),
      item("burger-box", "Burger box", "Packaging", ["jj", "booker"], { itemBrand: "Brown box", code: "BOX138" }),
      item("aluminium-foil", "Aluminium foil", "Packaging", ["jj", "booker"], { code: "WRA012" }),
      item("burger-smasher", "Burger smasher", "Equipment", ["ebay"], { link: "https://www.ebay.co.uk/itm/316544992986" }),
    ],
  },
  {
    slug: "greek-gyros",
    name: "Greek Gyros",
    accent: "#2563eb",
    items: [
      item("chicken-gyros", "Chicken gyros (doner)", "Meat & protein", ["jj"], { code: "DON175" }),
      item("souvlaki-doner", "Souvlaki doner", "Meat & protein", ["jj"], { code: "DON174" }),
      item("chicken-shish", "Halal marinated chicken breast shish (2kg)", "Meat & protein", ["jj"], { itemBrand: "Premiumeat", code: "CHI169" }),
      item("halloumi", "Halloumi cheese", "Meat & protein", ["jj"], { code: "CHE149" }),
      item("falafel", "Falafel", "Meat & protein", ["jj"], { code: "VGT017" }),
      item("pita-bread", "Pita bread, frozen 17cm (10 pack)", "Bread & buns", ["agora"], { itemBrand: "Alexakis" }),
      item("lettuce", "Lettuce", "Fresh veg & salad", ["jj", "supermarket"]),
      item("tomato", "Tomato", "Fresh veg & salad", ["jj", "supermarket"]),
      item("white-onion", "White onion", "Fresh veg & salad", ["jj", "supermarket"]),
      item("olives", "Olives", "Fresh veg & salad", ["costco", "jj", "supermarket"], { code: "VEG866" }),
      item("crunchy-slaw", "Crunchy slaw", "Fresh veg & salad", ["asda", "tesco"]),
      item("skin-on-fries", "Skin-on fries", "Sides", ["booker", "jj"], { code: "CHP165" }),
      item("halloumi-fries", "Halloumi fries", "Sides", ["jj"], { code: "CHE193" }),
      item("basmati-rice", "Basmati rice (250g)", "Sides", ["asda", "tesco"]),
      item("tzatziki", "Tzatziki", "Sauces & dips", ["jj"], { code: "SAN162", site: "https://www.ormos.co.uk" }),
      item("hummus", "Hummus", "Sauces & dips", ["jj", "costco", "supermarket"]),
      item("garlic-sauce", "Garlic sauce", "Sauces & dips", ["booker", "jj"]),
      item("mayo", "Mayo", "Sauces & dips", ["booker"]),
      item("chipotle-mayo", "Chipotle mayo", "Sauces & dips", ["booker"]),
      item("buffalo-sauce", "Buffalo sauce", "Sauces & dips", ["booker"]),
      item("thousand-island", "Thousand Island", "Sauces & dips", ["booker"]),
      item("yoghurt-mint", "Yoghurt & mint", "Sauces & dips", ["booker"]),
      item("oregano", "Oregano", "Seasoning", ["jj"], { code: "SPI597" }),
      item("chocolate-cake", "Chocolate cake", "Desserts", ["booker", "jj"]),
      item("can-coke", "Coca-Cola (can)", "Drinks", ["jj"]),
      item("can-diet-coke", "Diet Coke (can)", "Drinks", ["jj"]),
      item("can-coke-zero", "Coke Zero (can)", "Drinks", ["jj"]),
      item("can-fanta-orange", "Fanta Orange (can)", "Drinks", ["jj"]),
      item("meal-box", '8" square white bagasse meal box (220×200×77mm)', "Packaging", ["jj", "booker"], { code: "BOX156" }),
      item("chips-box", "Chips box", "Packaging", ["jj"], { code: "BOX138" }),
      item("kraft-bowl", "900ml round kraft food bowls (100)", "Packaging", ["jj", "booker", "hollandBazaar"], { code: "CON157" }),
      item("kraft-bowl-lid", "900ml food bowl lids (100)", "Packaging", ["jj"], { code: "CON163" }),
      item("salad-container", "Fresco oval salad containers 375ml (500)", "Packaging", ["jj"], { code: "BOW010" }),
      item("clear-cup", "8oz heavy-duty microwave clear cups with lids (225)", "Packaging", ["jj"], { code: "CON132" }),
      item("sauce-cup", "2oz sauce cup", "Packaging", ["jj"], { code: "CON096" }),
      item("aluminium-foil", "Aluminium foil", "Packaging", ["jj", "booker"], { code: "WRA012" }),
    ],
  },
];

export const supplierListBySlug = (slug: string | null) => SUPPLIER_LISTS.find((l) => l.slug === slug) ?? null;

export const supplierImage = (list: SupplierList, it: SupplierItem) =>
  it.image ? `/training/suppliers/${list.slug}/${it.slug}.jpg` : null;

/** The suppliers a brand buys from, most-used first. */
export function suppliersOf(list: SupplierList): Array<Supplier & { key: SupplierKey; count: number }> {
  const counts = new Map<SupplierKey, number>();
  for (const it of list.items) for (const s of it.suppliers) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count, ...SUPPLIERS[key] }));
}
