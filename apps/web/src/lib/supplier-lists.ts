// Virtual-brand supplier & ingredient lists for Kitchen training — what every
// kitchen buys for each brand, who sells it and the supplier's product code.
// Rebuilt from the brands' supplier PDFs; photos live in
// public/training/suppliers/<brand slug>/<item slug>.jpg.

export type SupplierCategory =
  | 'Meat & protein'
  | 'Bread & buns'
  | 'Fresh veg & salad'
  | 'Sides'
  | 'Sauces & dips'
  | 'Seasoning'
  | 'Oil & coatings'
  | 'Desserts'
  | 'Drinks'
  | 'Packaging'
  | 'Equipment';

export const SUPPLIER_CATEGORIES: SupplierCategory[] = [
  'Meat & protein',
  'Bread & buns',
  'Fresh veg & salad',
  'Sides',
  'Sauces & dips',
  'Seasoning',
  'Oil & coatings',
  'Desserts',
  'Drinks',
  'Packaging',
  'Equipment',
];

export interface Supplier {
  name: string;
  website?: string;
}

// One place for each supplier's name and site, so a list can't spell JJ two ways.
const SUPPLIER_DATA = {
  jj: { name: 'JJ Foodservice', website: 'https://www.jjfoodservice.com' },
  booker: { name: 'Booker', website: 'https://www.booker.co.uk' },
  brakes: { name: 'Brakes', website: 'https://www.brake.co.uk' },
  costco: { name: 'Costco', website: 'https://www.costco.co.uk' },
  agora: { name: 'Agora Greek', website: 'https://agoragreekdelicacies.co.uk' },
  asda: { name: 'Asda' },
  tesco: { name: 'Tesco' },
  supermarket: { name: 'Any supermarket' },
  halal: { name: 'Halal supermarket' },
  hollandBazaar: { name: 'Holland Bazaar' },
  cashCarry: { name: 'Cash & carry' },
  ebay: { name: 'eBay', website: 'https://www.ebay.co.uk' },
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
  /** What it's for on this brand's menu, e.g. "Seoul Fire fillet". */
  note?: string;
  image?: boolean;
}

export interface SupplierList {
  slug: string;
  name: string;
  accent: string;
  /** Photo folder, when the list shares another brand's photos. */
  photos?: string;
  items: SupplierItem[];
}

const item = (
  slug: string,
  name: string,
  category: SupplierCategory,
  suppliers: SupplierKey[],
  extra: Partial<SupplierItem> = {},
): SupplierItem => ({
  slug,
  name,
  category,
  suppliers,
  image: true,
  ...extra,
});

const MONSTER_BURGERZ: SupplierList = {
  slug: 'monster-burgerz',
  name: 'Monster Burgerz',
  accent: '#16a34a',
  items: [
    item(
      'beef-mince',
      'Flank beef mince, 20% fat',
      'Meat & protein',
      ['halal', 'brakes', 'booker'],
      { itemBrand: '80/20', code: 'BUR122' },
    ),
    item('chicken-fillet', 'Chicken fillet', 'Meat & protein', ['jj'], { code: 'CHI156' }),
    item('chicken-strips', 'Chicken strips', 'Meat & protein', ['jj'], { code: 'CHI606' }),
    item(
      'chicken-strips-alt',
      'Chicken strips (alternative)',
      'Meat & protein',
      ['jj', 'booker', 'cashCarry'],
      { code: 'CHI014' },
    ),
    item('cheese-slice', 'Cheese slices', 'Meat & protein', ['jj']),
    item('brioche-bun', 'Brioche bun', 'Bread & buns', ['booker', 'jj'], {
      itemBrand: 'Letsdough',
      code: 'BUN028',
    }),
    item('lettuce', 'Lettuce', 'Fresh veg & salad', ['jj', 'supermarket'], {
      itemBrand: 'Iceberg',
    }),
    item('tomato', 'Tomato', 'Fresh veg & salad', ['jj', 'supermarket'], { itemBrand: 'Vine' }),
    item('white-onion', 'White onion', 'Fresh veg & salad', ['jj', 'supermarket']),
    item('jalapeno', 'Jalapeño slices', 'Fresh veg & salad', ['jj', 'supermarket'], {
      code: 'VEG993',
    }),
    item('pickles', 'Pickles (gherkin slices)', 'Fresh veg & salad', ['jj', 'supermarket'], {
      code: 'VEG749',
    }),
    item('caramelised-onion', 'Caramelised onion', 'Fresh veg & salad', ['booker'], {
      itemBrand: "Chef's Larder",
    }),
    item('skin-on-fries', 'Skin-on fries', 'Sides', ['booker', 'jj'], { code: 'CHP165' }),
    item('sweet-potato-fries', 'Sweet potato fries', 'Sides', ['booker', 'jj'], { code: 'POT099' }),
    item('potato-wedges', 'Potato wedges', 'Sides', ['jj'], { code: 'POT142' }),
    item('onion-rings', 'Onion rings', 'Sides', ['jj'], { code: 'VEG908' }),
    item('mozzarella-sticks', 'Mozzarella sticks', 'Sides', ['jj'], { code: 'VEG890' }),
    item('garlic-sauce', 'Garlic sauce', 'Sauces & dips', ['booker', 'jj']),
    item('mayo', 'Mayo', 'Sauces & dips', ['booker']),
    item('ketchup', 'Ketchup', 'Sauces & dips', ['booker']),
    item('bbq-sauce', 'BBQ sauce', 'Sauces & dips', ['booker']),
    item('sweet-chilli-sauce', 'Sweet chilli sauce', 'Sauces & dips', ['booker']),
    item('peri-peri-sauce', 'Peri peri sauce', 'Sauces & dips', ['booker']),
    item('sriracha-sauce', 'Sriracha sauce', 'Sauces & dips', ['booker', 'jj']),
    item('buffalo-sauce', 'Buffalo sauce', 'Sauces & dips', ['booker']),
    item('mustard', 'Mustard', 'Sauces & dips', ['booker']),
    item('cajun-powder', 'Blackened Cajun powder', 'Seasoning', ['booker']),
    item('can-coke', 'Coca-Cola (can)', 'Drinks', ['jj']),
    item('can-diet-coke', 'Diet Coke (can)', 'Drinks', ['jj']),
    item('can-dr-pepper', 'Dr Pepper (can)', 'Drinks', ['jj']),
    item('can-fanta-orange', 'Fanta Orange (can)', 'Drinks', ['jj']),
    item('can-sprite', 'Sprite (can)', 'Drinks', ['jj']),
    item('burger-box', 'Burger box', 'Packaging', ['jj', 'booker'], {
      itemBrand: 'Brown box',
      code: 'BOX138',
    }),
    item('aluminium-foil', 'Aluminium foil', 'Packaging', ['jj', 'booker'], { code: 'WRA012' }),
    item('burger-smasher', 'Burger smasher', 'Equipment', ['ebay'], {
      link: 'https://www.ebay.co.uk/itm/316544992986',
    }),
  ],
};

const GREEK_GYROS: SupplierList = {
  slug: 'greek-gyros',
  name: 'Greek Gyros',
  accent: '#2563eb',
  items: [
    item('chicken-gyros', 'Chicken gyros (doner)', 'Meat & protein', ['jj'], { code: 'DON175' }),
    item('souvlaki-doner', 'Souvlaki doner', 'Meat & protein', ['jj'], { code: 'DON174' }),
    item('chicken-shish', 'Halal marinated chicken breast shish (2kg)', 'Meat & protein', ['jj'], {
      itemBrand: 'Premiumeat',
      code: 'CHI169',
    }),
    item('halloumi', 'Halloumi cheese', 'Meat & protein', ['jj'], { code: 'CHE149' }),
    item('falafel', 'Falafel', 'Meat & protein', ['jj'], { code: 'VGT017' }),
    item('pita-bread', 'Pita bread, frozen 17cm (10 pack)', 'Bread & buns', ['agora'], {
      itemBrand: 'Alexakis',
    }),
    item('lettuce', 'Lettuce', 'Fresh veg & salad', ['jj', 'supermarket']),
    item('tomato', 'Tomato', 'Fresh veg & salad', ['jj', 'supermarket']),
    item('white-onion', 'White onion', 'Fresh veg & salad', ['jj', 'supermarket']),
    item('olives', 'Olives', 'Fresh veg & salad', ['costco', 'jj', 'supermarket'], {
      code: 'VEG866',
    }),
    item('crunchy-slaw', 'Crunchy slaw', 'Fresh veg & salad', ['asda', 'tesco']),
    item('skin-on-fries', 'Skin-on fries', 'Sides', ['booker', 'jj'], { code: 'CHP165' }),
    item('halloumi-fries', 'Halloumi fries', 'Sides', ['jj'], { code: 'CHE193' }),
    item('basmati-rice', 'Basmati rice (250g)', 'Sides', ['asda', 'tesco']),
    item('tzatziki', 'Tzatziki', 'Sauces & dips', ['jj'], {
      code: 'SAN162',
      site: 'https://www.ormos.co.uk',
    }),
    item('hummus', 'Hummus', 'Sauces & dips', ['jj', 'costco', 'supermarket']),
    item('garlic-sauce', 'Garlic sauce', 'Sauces & dips', ['booker', 'jj']),
    item('mayo', 'Mayo', 'Sauces & dips', ['booker']),
    item('chipotle-mayo', 'Chipotle mayo', 'Sauces & dips', ['booker']),
    item('buffalo-sauce', 'Buffalo sauce', 'Sauces & dips', ['booker']),
    item('thousand-island', 'Thousand Island', 'Sauces & dips', ['booker']),
    item('yoghurt-mint', 'Yoghurt & mint', 'Sauces & dips', ['booker']),
    item('oregano', 'Oregano', 'Seasoning', ['jj'], { code: 'SPI597' }),
    item('chocolate-cake', 'Chocolate cake', 'Desserts', ['booker', 'jj']),
    item('can-coke', 'Coca-Cola (can)', 'Drinks', ['jj']),
    item('can-diet-coke', 'Diet Coke (can)', 'Drinks', ['jj']),
    item('can-coke-zero', 'Coke Zero (can)', 'Drinks', ['jj']),
    item('can-fanta-orange', 'Fanta Orange (can)', 'Drinks', ['jj']),
    item(
      'meal-box',
      '8" square white bagasse meal box (220×200×77mm)',
      'Packaging',
      ['jj', 'booker'],
      { code: 'BOX156' },
    ),
    item('chips-box', 'Chips box', 'Packaging', ['jj'], { code: 'BOX138' }),
    item(
      'kraft-bowl',
      '900ml round kraft food bowls (100)',
      'Packaging',
      ['jj', 'booker', 'hollandBazaar'],
      { code: 'CON157' },
    ),
    item('kraft-bowl-lid', '900ml food bowl lids (100)', 'Packaging', ['jj'], { code: 'CON163' }),
    item('salad-container', 'Fresco oval salad containers 375ml (500)', 'Packaging', ['jj'], {
      code: 'BOW010',
    }),
    item('clear-cup', '8oz heavy-duty microwave clear cups with lids (225)', 'Packaging', ['jj'], {
      code: 'CON132',
    }),
    item('sauce-cup', '2oz sauce cup', 'Packaging', ['jj'], { code: 'CON096' }),
    item('aluminium-foil', 'Aluminium foil', 'Packaging', ['jj', 'booker'], { code: 'WRA012' }),
  ],
};

// Built from the Korean Fried Chicken — DUXTON TURN menu's assembly charts and
// options, each matched to a JJ Foodservice product (searched 2026-10-11).
// Signature dips JJ doesn't sell ready-made list their base product.
const KOREAN_FRIED_CHICKEN: SupplierList = {
  slug: 'korean-fried-chicken',
  name: 'Korean Fried Chicken',
  accent: '#dc2626',
  items: [
    item(
      'chicken-drumsticks',
      'Halal raw chicken drumsticks, frozen (10kg)',
      'Meat & protein',
      ['jj'],
      { code: 'CHI426', note: 'Golden Classic chicken on the bone — breaded in store' },
    ),
    item(
      'chicken-thighs',
      'Halal oyster-cut chicken thigh, frozen (10kg)',
      'Meat & protein',
      ['jj'],
      { code: 'CHI740', note: 'Golden Classic chicken on the bone — breaded in store' },
    ),
    item(
      'crunch-fillet',
      'Southern fried chicken fillets, whole muscle',
      'Meat & protein',
      ['jj'],
      { itemBrand: 'Tyson', code: 'CHI753', note: 'Crunch fillet — burgers, wraps, rice bowls' },
    ),
    item('seoul-fire-fillet', 'Hot & spicy chicken fillets (18 × 110g)', 'Meat & protein', ['jj'], {
      code: 'CHI742',
      note: 'Seoul Fire fillet',
    }),
    item('mini-fillet', 'Halal raw chicken breast mini fillets', 'Meat & protein', ['jj'], {
      code: 'CHI846',
      note: 'Mini crunch fillet (kids) — breaded in store',
    }),
    item('tenders', 'Crispy southern fried chicken strips (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHI264',
      note: 'Golden Tenders',
    }),
    item('wings', 'Halal raw chicken mid wings, frozen (10kg)', 'Meat & protein', ['jj'], {
      code: 'CHI349',
      note: 'Fire Wings',
    }),
    item('popcorn-chicken', 'Southern fried poppin chicken (1kg)', 'Meat & protein', ['jj'], {
      code: 'CHI490',
      note: 'K-Pop Chicken',
    }),
    item('glazed-bites', 'Southern fried chunky chicken bites', 'Meat & protein', ['jj'], {
      code: 'CHI606',
      note: 'Kansas BBQ / Sweet Chilli glazed bites',
    }),
    item('quorn-fillet', 'Quorn vegan fillets (2kg)', 'Meat & protein', ['jj'], {
      itemBrand: 'Quorn',
      code: 'VEG958',
      note: 'Vegan fillet burger / wrap',
    }),
    item('mozzarella-sticks', 'Breaded mozzarella sticks (1kg)', 'Meat & protein', ['jj'], {
      code: 'VGT231',
      note: 'Molten Mozza Sticks',
    }),
    item('cheese-slice', 'Burger cheese slices (112)', 'Meat & protein', ['jj'], {
      itemBrand: 'Kerrymaid',
      code: 'CHE142',
    }),
    item('sesame-bun', '4.5" seeded burger buns (48)', 'Bread & buns', ['jj'], {
      code: 'BUN038',
      note: 'Glazed sesame bun',
    }),
    item('mini-bun', '4" seeded burger buns (48)', 'Bread & buns', ['jj'], {
      code: 'BUN037',
      note: 'Mini / kids burger',
    }),
    item('tortilla-12', '12" flour tortilla wraps (6 × 12)', 'Bread & buns', ['jj'], {
      code: 'BAK306',
      note: 'Wraps',
    }),
    item('tortilla-10', '10" flour tortilla wraps (6 × 12)', 'Bread & buns', ['jj'], {
      code: 'BAK307',
      note: 'Kids wraps',
    }),
    item('lettuce', 'Iceberg lettuce (10–12)', 'Fresh veg & salad', ['jj'], { code: 'VEG476' }),
    item('mixed-leaves', 'Mixed leaves (2 × 500g)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG790',
      note: 'Garden salad',
    }),
    item('red-cabbage', 'Red cabbage (10kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG001',
      note: 'Crunchy pickled slaw',
    }),
    item('jalapeno', 'Sliced green jalapeños in brine (3kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG993',
      note: 'Jalapeño Ranch dip',
    }),
    item('corn-cob', 'Corn on the cob (2 × 24)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG027',
      note: 'Golden Corn Cob, charred Cajun corn',
    }),
    item('sweet-potato', 'Frozen diced sweet potato (1kg)', 'Fresh veg & salad', ['jj'], {
      itemBrand: 'Greens',
      code: 'VEG856',
      note: 'Roasted sweet potato',
    }),
    item('fries', 'Super Crisp Double Crunch 9/16 chips (4 × 2.27kg)', 'Sides', ['jj'], {
      code: 'CHP181',
      note: 'Crunch Fries, Loaded Seoul Fries',
    }),
    item('hash-brown', 'Hash browns (4 × 2.27kg)', 'Sides', ['jj'], { code: 'POT097' }),
    item('baked-beans', 'Baked beans (6 × 2.65kg)', 'Sides', ['jj'], {
      code: 'VEG072',
      note: 'Smoky Beans',
    }),
    item('rice', 'Easy cook long grain rice (5kg)', 'Sides', ['jj'], {
      itemBrand: 'Aunt Caroline',
      code: 'RIC024',
      note: 'Cajun Dirty Rice, rice bowls',
    }),
    item('coleslaw', 'Coleslaw (2kg)', 'Sides', ['jj'], { code: 'SAN105', note: 'Kids coleslaw' }),
    item('mayo', 'Real mayonnaise bucket (10L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Heinz',
      code: 'SAU043',
      note: 'Mayo, pepper mayo, Golden Mayo; base for Golden House Sauce & Garlic Parmesan dip',
    }),
    item('vegan-mayo', 'Vegan mayonnaise (5L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Heinz',
      code: 'SAU972',
    }),
    item('ranch', 'Ranch dressing (2 × 2.27L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Lion',
      code: 'SAU823',
      note: 'Golden ranch, Seoul Fire ranch, Jalapeño Ranch dip',
    }),
    item('bbq-sauce', 'Smoky BBQ sauce (2 × 2.27L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Crucials',
      code: 'SAU049',
      note: 'Smokehouse BBQ dip, Kansas BBQ glaze',
    }),
    item('gochujang', 'Halal gochujang sauce (300g)', 'Sauces & dips', ['jj'], {
      itemBrand: "O'Food",
      code: 'SAU991',
      note: 'Gochu Blaze sauce, dip & mayo',
    }),
    item('sweet-chilli-sauce', 'Sweet chilli sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Crucials',
      code: 'SAU246',
      note: 'Sweet chilli glaze; base for Mango Chilli dip',
    }),
    item('honey-mustard', 'Honey & mustard dressing (2 × 2.27L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Lion',
      code: 'SAU729',
      note: 'Honey Mustard dip',
    }),
    item('teriyaki', 'Teriyaki marinade (975ml)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Kikkoman',
      code: 'SAU994',
      note: 'Sesame Teriyaki dip',
    }),
    item('chilli-honey', 'Chilli Fusion honey (680g)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Rowse',
      code: 'SPR069',
      note: 'Hot Honey Habanero dip',
    }),
    item('salsa', 'Salsa sauce (950g)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Santa Maria',
      code: 'SAU666',
      note: 'Spicy salsa',
    }),
    item('ketchup', 'SQ-easy tomato ketchup (6 × 1L)', 'Sauces & dips', ['jj'], { code: 'SAU024' }),
    item('cajun-seasoning', 'Blackened Cajun seasoning', 'Seasoning', ['jj'], {
      itemBrand: 'Schwartz',
      code: 'SPI366',
      note: 'Cajun Dirty Rice, Cajun corn',
    }),
    item('black-pepper', 'Black pepper powder (1.75kg)', 'Seasoning', ['jj'], {
      code: 'SPI596',
      note: 'Black pepper mayo',
    }),
    item('breading', 'Chicken breading (25kg)', 'Oil & coatings', ['jj'], {
      code: 'FLO012',
      note: 'Golden Classic chicken, mini fillets',
    }),
    item('frying-oil', 'Rapeseed cooking oil drum (20L)', 'Oil & coatings', ['jj'], {
      itemBrand: 'Pride',
      code: 'OIL055',
      note: 'Fryers',
    }),
    item('cookie', 'Milk chocolate cookie dough (90 × 50g)', 'Desserts', ['jj'], {
      itemBrand: 'Baker and Baker',
      code: 'BAK168',
      note: 'Choc chip cookie, kids treat',
    }),
    item('can-pepsi-max', 'Pepsi Max cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK698' }),
    item('can-tango-orange', 'Tango Orange cans (24 × 330ml)', 'Drinks', ['jj'], {
      code: 'DRK115',
    }),
    item(
      'can-7up-zero',
      '7UP Zero Sugar Lemon & Lime cans (24 × 330ml)',
      'Drinks',
      ['booker', 'cashCarry'],
      { image: false, note: 'Not stocked in cans at JJ' },
    ),
    item('bottle-pepsi-max', 'Pepsi Max bottles (12 × 1.5L)', 'Drinks', ['jj'], { code: 'DRN377' }),
    item('bottle-diet-pepsi', 'Diet Pepsi bottles (12 × 1.5L)', 'Drinks', ['jj'], {
      code: 'DRN380',
    }),
    item('bottle-7up-zero', '7UP Zero Sugar bottles (12 × 1.5L)', 'Drinks', ['jj'], {
      code: 'DRN376',
    }),
    item('bottle-tango-orange', 'Tango Orange bottles (12 × 1.5L)', 'Drinks', ['jj'], {
      code: 'DRK111',
    }),
    item('fruit-shoot-apple', 'Fruit Shoot Apple & Blackcurrant (24 × 275ml)', 'Drinks', ['jj'], {
      code: 'DRK142',
    }),
    item('fruit-shoot-orange', 'Fruit Shoot Orange (24 × 275ml)', 'Drinks', ['jj'], {
      code: 'DRK141',
    }),
    item('still-water', 'Still spring water (24 × 500ml)', 'Drinks', ['jj'], {
      itemBrand: 'Vivat',
      code: 'DRN837',
    }),
    item('chicken-box', 'FC3 large chicken boxes', 'Packaging', ['jj'], {
      code: 'BOX117',
      note: 'Feast box, snack box',
    }),
    item('chicken-bucket', 'Chicken bucket with lid', 'Packaging', ['booker', 'cashCarry'], {
      image: false,
      note: 'Buckets — not stocked at JJ',
    }),
    item('burger-box', '5" white bagasse burger box (50)', 'Packaging', ['jj'], {
      code: 'BOX151',
      note: 'Burgers, Little Champ box',
    }),
    item('loaded-fries-box', 'S9 bagasse burger & chips box', 'Packaging', ['jj'], {
      code: 'BOX179',
      note: 'Loaded fries',
    }),
    item('rice-bowl', '32oz bagasse round bowl (200)', 'Packaging', ['jj'], {
      code: 'BOX194',
      note: 'Rice bowls',
    }),
    item('rice-bowl-lid', 'Lids for bagasse round bowl (200)', 'Packaging', ['jj'], {
      code: 'CON261',
    }),
    item('sauce-cup', '2oz hinged sauce cups (1000)', 'Packaging', ['jj'], {
      code: 'CON096',
      note: 'Dips',
    }),
    item('meal-bag', 'Medium brown paper carrier bags', 'Packaging', ['jj'], {
      code: 'BAG184',
      note: 'Meal bag',
    }),
    item('cookie-bag', 'Hot food bag 5" × 8"', 'Packaging', ['jj'], {
      code: 'BAG208',
      note: 'Cookie bag',
    }),
  ],
};

// Burgerz and Friez runs the Monster Burgerz recipe and Greek Bite the Greek
// Gyros one — same ingredients, same suppliers, same photos.
export const SUPPLIER_LISTS: SupplierList[] = [
  MONSTER_BURGERZ,
  {
    ...MONSTER_BURGERZ,
    slug: 'burgerz-and-friez',
    name: 'Burgerz and Friez',
    accent: '#ea580c',
    photos: MONSTER_BURGERZ.slug,
  },
  GREEK_GYROS,
  {
    ...GREEK_GYROS,
    slug: 'greek-bite',
    name: 'Greek Bite',
    accent: '#0891b2',
    photos: GREEK_GYROS.slug,
  },
  KOREAN_FRIED_CHICKEN,
];

export const supplierListBySlug = (slug: string | null) =>
  SUPPLIER_LISTS.find((l) => l.slug === slug) ?? null;

export const supplierImage = (list: SupplierList, it: SupplierItem) =>
  it.image ? `/training/suppliers/${list.photos ?? list.slug}/${it.slug}.jpg` : null;

/** The suppliers a brand buys from, most-used first. */
export function suppliersOf(
  list: SupplierList,
): Array<Supplier & { key: SupplierKey; count: number }> {
  const counts = new Map<SupplierKey, number>();
  for (const it of list.items)
    for (const s of it.suppliers) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count, ...SUPPLIERS[key] }));
}
