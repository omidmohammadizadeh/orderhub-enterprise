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
  // Scottish breakfast lines (Lorne, haggis, morning rolls, tattie scones)
  // that JJ doesn't stock.
  localButcher: { name: 'Local butcher' },
  localBakery: { name: 'Local bakery' },
  // Fiesta Mexica's relaunch tracker lists branded packaging under "BY".
  brandPackaging: { name: 'BY (branded packaging)' },
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
  /**
   * Which menus are this brand's — tested against the location's menu names,
   * so Kitchen training only offers the lists a shop actually cooks.
   */
  match: RegExp;
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
  match: /monster\s*burger/i,
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
  match: /greek\s*gyros/i,
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
  match: /korean\s*fried|\bkfc\b/i,
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

// Built from the CHICAGO PIZZERIA-AYLESBURY menu's 192 assembly charts and its
// options (toppings, sauces, drinks), each matched to a JJ Foodservice product
// (searched 2026-10-11). Rows without a code aren't stocked at JJ.
const CHICAGO_PIZZERIA: SupplierList = {
  slug: 'chicago-pizzeria',
  name: 'Chicago Pizzeria',
  match: /chicago/i,
  accent: '#b91c1c',
  items: [
    item('pizza-flour', 'Pizza flour (16kg)', 'Oil & coatings', ['jj'], {
      code: 'PIZ199',
      note: 'Pizza dough, garlic bread',
    }),
    item('yeast', 'Instant yeast (500g)', 'Oil & coatings', ['jj'], {
      code: 'MIS078',
      itemBrand: 'Fermipan',
      note: 'Pizza dough',
    }),
    item('frying-oil', 'Rapeseed cooking oil drum (20L)', 'Oil & coatings', ['jj'], {
      code: 'OIL055',
      itemBrand: 'Pride',
      note: 'Fryers',
    }),
    item('pizza-sauce', 'Spiced pizza sauce (6 × 2.95kg)', 'Sauces & dips', ['jj'], {
      code: 'PIZ080',
      itemBrand: 'Falcon',
      note: 'Pizza base',
    }),
    item('mozzarella', 'Grated pure mozzarella (5 × 2kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ359',
      itemBrand: 'Buffalo',
      note: 'Pizzas, garlic bread, parmesans',
    }),
    item('grated-cheddar', 'Grated red cheddar (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHE169',
      itemBrand: 'Buttercup',
      note: 'Tacos, burritos, cheesy chips',
    }),
    item('parmesan', 'Grated Grana Padano (1kg)', 'Meat & protein', ['jj'], {
      code: 'CHE056',
      note: 'Parmesan sauce',
    }),
    item('cheese-sauce', 'Cheddar cheese sauce (1kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU932',
      itemBrand: 'Kerrymaid',
      note: 'Cheese sauce, parmesans',
    }),
    item('cheese-slice', 'Burger cheese slices (112)', 'Meat & protein', ['jj'], {
      code: 'CHE142',
      itemBrand: 'Kerrymaid',
      note: 'Smashed & chicken burgers',
    }),
    item('pepperoni', 'Halal sliced pepperoni (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ026',
      note: 'Pizza topping',
    }),
    item('salami', 'Halal sliced salami (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ034',
      note: 'Pizza topping',
    }),
    item('turkey-ham', 'Halal julienne turkey ham (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ041',
      note: 'Ham topping',
    }),
    item('pizza-chicken', 'Halal cooked plain chicken dices 12mm (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ004',
      note: 'Chicken topping',
    }),
    item('tikka-chicken', 'Halal cooked tikka chicken dices 12mm (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ002',
      note: 'Chicken tikka pizza',
    }),
    item(
      'tandoori-chicken',
      'Halal cooked tandoori chicken dices 12mm (1kg)',
      'Meat & protein',
      ['jj'],
      { code: 'PIZ003', note: 'Tandoori pizza' },
    ),
    item('spicy-beef', 'Halal spicy beef chunks (1kg)', 'Meat & protein', ['jj'], {
      code: 'PIZ031',
      note: 'Spicy beef topping',
    }),
    item('meatballs', 'Halal mini beef meatballs (1kg)', 'Meat & protein', ['jj'], {
      code: 'MEA508',
      note: 'Meatball pizzas',
    }),
    item('beef-mince', 'UK halal minced beef 10% fat (2 × 1kg)', 'Meat & protein', ['jj'], {
      code: 'MEA379',
      note: 'Bolognese (with chopped tomatoes)',
    }),
    item('doner', 'Halal cooked & cut doner kebab (2 × 2.27kg)', 'Meat & protein', ['jj'], {
      code: 'DON034',
      itemBrand: 'Ali Baba',
      note: 'Donner kebab, kebab pizza, kebab butty',
    }),
    item('chicken-gyros', 'Halal pre-cooked & cut chicken doner (1kg)', 'Meat & protein', ['jj'], {
      code: 'DON175',
      note: 'Chicken gyros wraps, bowls, platters',
    }),
    item('chicken-shish', 'Halal marinated chicken breast shish (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHI169',
      itemBrand: 'Premiumeat',
      note: 'Chicken souvlaki, peri peri chicken',
    }),
    item('kofte', 'Halal kofte (24 × 125g)', 'Meat & protein', ['jj'], {
      code: 'MEA011',
      note: 'Grill bar',
    }),
    item('chicken-thigh', 'Halal raw boneless chicken thigh (10kg)', 'Meat & protein', ['jj'], {
      code: 'CHI476',
      note: 'Chicken pastor — marinate with fajita spice',
    }),
    item('hot-dog', 'Halal beef hot dogs 22cm (10)', 'Meat & protein', ['jj'], {
      code: 'SGS230',
      itemBrand: 'The Sausage Man',
      note: 'Hot dog crust',
    }),
    item('turkey-bacon', 'Halal turkey rashers (1kg)', 'Meat & protein', ['jj'], {
      code: 'TUR022',
      itemBrand: 'Volys',
      note: 'Bacon topping, burgers',
    }),
    item('tuna', 'Tuna chunks in brine (6 × 1.7kg)', 'Meat & protein', ['jj'], {
      code: 'FSH832',
      note: 'Tuna pizzas',
    }),
    item('prawns', 'Raw vannamei prawns, peeled (1.8kg)', 'Meat & protein', ['jj'], {
      code: 'FSH659',
      note: 'Pescatore',
    }),
    item('anchovies', 'Anchovies (365g)', 'Meat & protein', ['jj'], {
      code: 'PIZ024',
      note: 'Pescatore',
    }),
    item('crunch-fillet', 'Southern fried chicken fillets', 'Meat & protein', ['jj'], {
      code: 'CHI753',
      itemBrand: 'Tyson',
      note: 'Chicken burgers, parmesans',
    }),
    item('hot-fillet', 'Hot & spicy chicken fillets (18 × 110g)', 'Meat & protein', ['jj'], {
      code: 'CHI742',
      note: 'Hot chicken burger',
    }),
    item('chicken-kiev', 'Chicken kievs (12 × 150g)', 'Meat & protein', ['jj'], {
      code: 'CHI122',
      itemBrand: 'Shyres',
      note: 'Chicken Kiev pizza & parmesan',
    }),
    item('tenders', 'Crispy southern fried chicken strips (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHI264',
      note: 'Chicken strips',
    }),
    item('popcorn-chicken', 'Southern fried poppin chicken (1kg)', 'Meat & protein', ['jj'], {
      code: 'CHI490',
      note: 'Kids popcorn chicken',
    }),
    item('nuggets', 'Halal battered chicken nuggets (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHI743',
      note: 'Nuggets, kids meal',
    }),
    item('hot-wings', 'Halal battered hot wings (2kg)', 'Meat & protein', ['jj'], {
      code: 'CHI016',
      note: 'Hot chicken wings',
    }),
    item('halloumi', 'Cyprus style cheese / halloumi (5 × 200g)', 'Meat & protein', ['jj'], {
      code: 'CHE149',
      itemBrand: 'Gonendere',
      note: 'Grilled halloumi',
    }),
    item('feta', 'Greek feta (900g)', 'Meat & protein', ['jj'], {
      code: 'CHE180',
      note: 'Greek bowls & salads',
    }),
    item('falafel', 'Moroccan falafel bites (2 × 1kg)', 'Meat & protein', ['jj'], {
      code: 'VGT017',
      itemBrand: 'Gosh',
      note: 'Falafel wrap / bowl',
    }),
    item('pulled-beef', 'Pulled beef (barbacoa)', 'Meat & protein', ['halal', 'cashCarry'], {
      image: false,
      note: 'Tacos, burritos — not stocked ready-made at JJ',
    }),
    item('brioche-bun', '4.5" gourmet sliced brioche buns (48)', 'Bread & buns', ['jj'], {
      code: 'BUN028',
      itemBrand: 'Letsdough',
      note: 'Burgers',
    }),
    item('pitta', 'Large frozen pitta breads (20 × 6)', 'Bread & buns', ['jj'], {
      code: 'BRE026',
      note: 'Kebabs, gyros, platters',
    }),
    item('tortilla-12', '12" flour tortilla wraps (6 × 12)', 'Bread & buns', ['jj'], {
      code: 'BAK306',
      note: 'Burritos, quesadillas, wraps',
    }),
    item('tortilla-6', '6" flour tortilla wraps (10 × 15)', 'Bread & buns', ['jj'], {
      code: 'BAK156',
      itemBrand: 'Santa Maria',
      note: 'Tacos',
    }),
    item('lettuce', 'Iceberg lettuce (10–12)', 'Fresh veg & salad', ['jj'], { code: 'VEG476' }),
    item('tomato', 'Tomatoes', 'Fresh veg & salad', ['jj', 'supermarket'], {
      image: false,
      note: 'Salads, burgers, pico de gallo',
    }),
    item('white-onion', 'White onions', 'Fresh veg & salad', ['jj', 'supermarket'], {
      image: false,
      note: 'Pizza topping, kebabs',
    }),
    item('red-onion', 'Red onions (10kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG490' }),
    item('cucumber', 'Cucumbers (4)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG902',
      note: 'Greek salad, tzatziki',
    }),
    item('mushrooms', 'Sliced mushrooms (2.55kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG064',
      note: 'Pizza topping, garlic mushrooms',
    }),
    item('green-peppers', 'Green peppers (5kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG605',
      note: 'Pizza topping',
    }),
    item('green-chillies', 'Green chilli peppers (3kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG765',
      note: 'Chilli topping',
    }),
    item('jalapeno', 'Sliced green jalapeños in brine (3kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG993',
    }),
    item('sweetcorn', 'Sweetcorn (2.23kg)', 'Fresh veg & salad', ['jj'], { code: 'VGT138' }),
    item('pineapple', 'Pineapple pizza-cut pieces (3kg)', 'Fresh veg & salad', ['jj'], {
      code: 'PIZ033',
      note: 'Hawaiian',
    }),
    item('black-olives', 'Sliced black olives (3kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG074',
      note: 'Pizza topping',
    }),
    item('kalamata-olives', 'Mixed marinated pitted olives (3.2kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG866',
      itemBrand: 'Gomo',
      note: 'Greek dishes',
    }),
    item('gherkins', 'Sliced dill gherkins (2.45kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG749',
      itemBrand: 'Kuhne',
      note: 'Burgers',
    }),
    item('pickled-onions', 'Pink pickled onions (5 × 1kg)', 'Fresh veg & salad', ['jj'], {
      code: 'SAU931',
      note: 'Tacos, gyros',
    }),
    item('coriander', 'Fresh coriander (20 bunches)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG668',
      note: 'Pico de gallo, tacos',
    }),
    item('spring-onion', 'Spring onions (12–14 bunches)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG402',
    }),
    item('edamame', 'Edamame in pods (1kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VGT194',
      note: 'Bowls',
    }),
    item('chopped-tomatoes', 'Chopped tomatoes (6 × 2.95kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VGT028',
      note: 'Bolognese',
    }),
    item('chips', 'Blue Label 9/16 chips (4 × 2.27kg)', 'Sides', ['jj'], {
      code: 'CHP098',
      note: 'Chips, cheesy chips, meal deals',
    }),
    item('potato-wedges', 'Double Crunch spicy wedges (4 × 2.27kg)', 'Sides', ['jj'], {
      code: 'POT142',
    }),
    item('onion-rings', 'Battered onion rings (1kg)', 'Sides', ['jj'], {
      code: 'VEG908',
      itemBrand: 'Aviko',
    }),
    item('mozzarella-sticks', 'Breaded mozzarella sticks (1kg)', 'Sides', ['jj'], {
      code: 'VGT231',
    }),
    item('jalapeno-bites', 'Green jalapeño & cheese snacks (1kg)', 'Sides', ['jj'], {
      code: 'VEG909',
      itemBrand: 'Aviko',
      note: 'Jalapeño bites',
    }),
    item('halloumi-fries', 'Breaded halloumi fries (1kg)', 'Sides', ['jj'], {
      code: 'CHE193',
      itemBrand: 'Yamas',
    }),
    item('cauliflower-bites', 'Vegan Moroccan-style cauliflower bites', 'Sides', ['jj'], {
      code: 'VGT027',
      itemBrand: 'KaterVeg',
      note: 'Cauliflower tacos & bowls',
    }),
    item('coleslaw', 'Coleslaw (2kg)', 'Sides', ['jj'], { code: 'SAN105' }),
    item('burrito-rice', 'Veg burrito rice (6 × 1kg)', 'Sides', ['jj'], {
      code: 'RIC124',
      note: 'Mexican rice',
    }),
    item('basmati-rice', 'Basmati rice (5kg)', 'Sides', ['jj'], {
      code: 'RIC036',
      itemBrand: 'Laila',
      note: 'Gyros & rice bowls',
    }),
    item('tortilla-chips', 'Salted corn tortilla chips (12 × 475g)', 'Sides', ['jj'], {
      code: 'CRP191',
      itemBrand: 'Santa Maria',
      note: 'Nachos',
    }),
    item('mayo', 'SQ-easy mayo + garlic mayo + burger sauce (3 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU240',
      note: 'Mayo, garlic mayo',
    }),
    item('vegan-mayo', 'Vegan mayonnaise (5L)', 'Sauces & dips', ['jj'], {
      code: 'SAU972',
      itemBrand: 'Heinz',
    }),
    item('garlic-sauce', 'Garlic & herb sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU716',
      itemBrand: 'Harrisons',
      note: 'Kebab garlic sauce',
    }),
    item('chilli-sauce', 'SQ-easy extra hot chilli sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU023',
      note: 'Kebab chilli sauce, chilli base',
    }),
    item('bbq-sauce', 'SQ-easy BBQ sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU144',
      note: 'BBQ base, burger sauce choice',
    }),
    item('burger-sauce', 'SQ-easy burger sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU031',
    }),
    item('ketchup', 'SQ-easy tomato ketchup (6 × 1L)', 'Sauces & dips', ['jj'], { code: 'SAU024' }),
    item('mustard', 'SQ-easy American mild mustard (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU033',
    }),
    item('sweet-chilli-sauce', 'Sweet chilli sauce (6 × 1L)', 'Sauces & dips', ['jj'], {
      code: 'SAU246',
      itemBrand: 'Crucials',
    }),
    item('buffalo-sauce', 'Red Hot buffalo wing sauce (3.78L)', 'Sauces & dips', ['jj'], {
      code: 'SAU608',
      itemBrand: "Frank's",
    }),
    item('peri-peri-sauce', 'Original piri piri hot sauce (2 × 2.27L)', 'Sauces & dips', ['jj'], {
      code: 'SAU507',
      itemBrand: 'Lion',
    }),
    item('blue-cheese', 'Blue cheese dressing (2 × 2.27L)', 'Sauces & dips', ['jj'], {
      code: 'SAU730',
      itemBrand: 'Lion',
      note: 'Wings',
    }),
    item('sriracha', 'Sriracha hot chilli sauce (570ml)', 'Sauces & dips', ['jj'], {
      code: 'SAU981',
      itemBrand: 'Panich',
      note: 'Sriracha honey sauce',
    }),
    item('korean-bbq', 'Sticky Korean barbecue sauce (875ml)', 'Sauces & dips', ['jj'], {
      code: 'SAU983',
      itemBrand: 'Heinz',
      note: 'Korean BBQ drizzle',
    }),
    item('curry-sauce', 'Curry sauce mix, no sultanas (4.54kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU097',
      itemBrand: 'Dinaclass',
      note: 'Curry dip',
    }),
    item('tikka-paste', 'Tikka masala curry paste (2 × 2.3kg)', 'Sauces & dips', ['jj'], {
      code: 'SPI265',
      itemBrand: 'Patak’s',
      note: 'Tikka base',
    }),
    item('garlic-butter', 'Garlic & butter flavoured sauce (6 × 2L)', 'Sauces & dips', ['jj'], {
      code: 'OIL154',
      note: 'Garlic bread, crust brush',
    }),
    item('garlic-puree', 'Garlic purée (1.2kg)', 'Sauces & dips', ['jj'], {
      code: 'SPI485',
      itemBrand: 'Cooks & Co',
      note: 'Garlic mushrooms',
    }),
    item('chipotle-mayo', 'Chipotle mayo', 'Sauces & dips', ['booker'], {
      image: false,
      note: 'Not stocked at JJ',
    }),
    item('caramelised-onion', 'Caramelised onion chutney', 'Sauces & dips', ['booker'], {
      image: false,
      note: 'Burgers — not stocked at JJ',
    }),
    item('sour-cream', 'Set sour cream (2kg)', 'Sauces & dips', ['jj'], {
      code: 'CRE033',
      note: 'Tacos, burritos',
    }),
    item('guacamole', 'Frozen guacamole (1kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU784',
      itemBrand: 'Santa Maria',
    }),
    item('roasted-salsa', 'Roasted salsa (8 × 1kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU921',
      note: 'Roasted salsa; base for chipotle salsa',
    }),
    item('salsa-verde', 'Green Mexican salsa (6 × 2.8kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU923',
      itemBrand: 'Del Sol',
      note: 'Salsa verde dip',
    }),
    item('hummus', 'Houmous (2kg)', 'Sauces & dips', ['jj'], { code: 'SAU014' }),
    item('tzatziki', 'Tzatziki (1.9kg)', 'Sauces & dips', ['jj'], {
      code: 'SAN162',
      itemBrand: 'Mr.Dips',
    }),
    item('miso', 'White miso paste (1kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU963',
      itemBrand: 'Emma Basic',
      note: 'Miso mayo rice',
    }),
    item('oregano', 'Oregano (800g)', 'Seasoning', ['jj'], {
      code: 'SPI597',
      note: 'Pizzas, oregano fries',
    }),
    item('paprika', 'Mild paprika (1.3kg)', 'Seasoning', ['jj'], { code: 'SPI534' }),
    item('parsley', 'Dried parsley (700g)', 'Seasoning', ['jj'], { code: 'SPI617' }),
    item('tandoori-masala', 'Tandoori masala (1kg)', 'Seasoning', ['jj'], {
      code: 'SPI749',
      itemBrand: 'Natco',
      note: 'Tandoori powder',
    }),
    item('fajita-spice', 'Mexican fajita spice mix (504g)', 'Seasoning', ['jj'], {
      code: 'SPI645',
      itemBrand: 'Santa Maria',
      note: 'Chicken pastor, Mexican rice',
    }),
    item('cinnamon', 'Ground cinnamon (390g)', 'Seasoning', ['jj'], {
      code: 'SPI389',
      itemBrand: 'Schwartz',
      note: 'Churros cinnamon sugar',
    }),
    item('churros', 'Churros loops (2 × 2kg)', 'Desserts', ['jj'], {
      code: 'DES414',
      itemBrand: 'Comida Latina',
    }),
    item('toffee-sauce', 'Toffee drizzle (500g)', 'Desserts', ['jj'], {
      code: 'ICE261',
      itemBrand: 'DaVinci Gourmet',
      note: 'Churros toffee sauce',
    }),
    item('fudge-cake', 'Devil’s fudge cake, pre-sliced (12)', 'Desserts', ['jj'], {
      code: 'DES420',
      itemBrand: 'Letscake',
      note: 'Chocolate fudge cake',
    }),
    item('cheesecake', 'Deep & creamy cheesecake, pre-sliced (12)', 'Desserts', ['jj'], {
      code: 'DES204',
      itemBrand: 'Mademoiselle',
      note: 'Mexican cheesecake',
    }),
    item('vegan-brownie', 'Vegan salted caramel brownie', 'Desserts', ['booker'], {
      image: false,
      note: 'Not stocked at JJ',
    }),
    item('ben-jerrys', "Ben & Jerry's tubs (8 × 465ml)", 'Desserts', ['jj'], {
      code: 'ICE098',
      note: 'Ben & Jerry’s tub — order other flavours to match',
    }),
    item('vanilla-ice-cream', 'Vanilla soft scoop ice cream (4L)', 'Desserts', ['jj'], {
      code: 'ICE237',
      itemBrand: 'Summertime',
      note: 'Milkshakes',
    }),
    item('whipped-cream', 'Aerosol real dairy cream (500g)', 'Desserts', ['jj'], {
      code: 'CRE017',
      note: 'Milkshake topping',
    }),
    item('oreo', 'Oreo snack packs (20)', 'Desserts', ['jj'], {
      code: 'SNA060',
      note: 'Oreo milkshake',
    }),
    item('biscoff', 'Lotus Biscoff biscuits (300)', 'Desserts', ['jj'], {
      code: 'SNA110',
      note: 'Biscoff milkshake',
    }),
    item('strawberries', 'Frozen strawberries (450g)', 'Desserts', ['jj'], {
      code: 'VEG268',
      itemBrand: 'Greens',
      note: 'Strawberry milkshake',
    }),
    item('bananas', 'Bananas', 'Desserts', ['supermarket'], {
      image: false,
      note: 'Banana milkshake',
    }),
    item('chocolate-sauce', 'Chocolate sauce / spread', 'Desserts', ['supermarket', 'booker'], {
      image: false,
      note: 'Chocolate milkshake',
    }),
    item('milk', 'Whole milk', 'Desserts', ['supermarket'], { image: false, note: 'Milkshakes' }),
    item('can-coke', 'Coca-Cola cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK063' }),
    item('can-diet-coke', 'Diet Coke cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK062' }),
    item('can-fanta', 'Fanta Orange cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK075' }),
    item('can-sprite', 'Sprite cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK447' }),
    item('can-dr-pepper', 'Dr Pepper cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK448' }),
    item('bottle-coke', 'Coca-Cola bottles (12 × 1.5L)', 'Drinks', ['jj'], { code: 'DRK051' }),
    item('bottle-diet-coke', 'Diet Coke bottles (12 × 1.5L)', 'Drinks', ['jj'], { code: 'DRK053' }),
    item('bottle-fanta', 'Fanta Orange bottles (12 × 1.5L)', 'Drinks', ['jj'], { code: 'DRN342' }),
    item('pizza-box-10', '10" plain brown pizza boxes (100)', 'Packaging', ['jj'], {
      code: 'PIZ282',
    }),
    item('pizza-box-12', '12" plain brown pizza boxes (100)', 'Packaging', ['jj'], {
      code: 'PIZ283',
    }),
    item('pizza-box-14', '14" pizza boxes', 'Packaging', ['booker', 'cashCarry'], {
      image: false,
      note: 'Not stocked at JJ',
    }),
    item('pizza-box-18', '18" pizza boxes', 'Packaging', ['booker', 'cashCarry'], {
      image: false,
      note: 'Not stocked at JJ',
    }),
    item('burger-box', '5" white bagasse burger box (500)', 'Packaging', ['jj'], {
      code: 'BOX151',
    }),
    item('clamshell', 'Large kraft clamshell food box (200)', 'Packaging', ['jj'], {
      code: 'BOX137',
      note: 'Kebab, platter & salad box',
    }),
    item('kraft-bowl', '32oz round kraft bowl (200)', 'Packaging', ['jj'], {
      code: 'CON240',
      note: 'Bowls',
    }),
    item('kraft-bowl-lid', '32oz round kraft bowl lids (200)', 'Packaging', ['jj'], {
      code: 'CON241',
    }),
    item('salad-tub', 'Oval salad container 500ml (500)', 'Packaging', ['jj'], {
      code: 'BOW011',
      note: 'Salad tub',
    }),
    item('sauce-cup-2oz', '2oz hinged sauce cups (1000)', 'Packaging', ['jj'], {
      code: 'CON096',
      note: 'Dips',
    }),
    item('sauce-cup-4oz', '4oz hinged sauce cups (500)', 'Packaging', ['jj'], {
      code: 'CON097',
      note: 'Extras, toffee sauce',
    }),
    item('taco-tray', 'Large white bagasse tray (500)', 'Packaging', ['jj'], {
      code: 'TRA024',
      note: 'Taco tray',
    }),
    item('greaseproof', 'Greaseproof paper 25 × 37.5cm (2000)', 'Packaging', ['jj'], {
      code: 'WRA016',
      note: 'Burritos, wraps',
    }),
    item('foil', 'Kitchen foil with cutter 30cm × 200m', 'Packaging', ['jj'], {
      code: 'WRA058',
      note: 'Burritos, wraps',
    }),
    item('milkshake-cup', '540ml milkshake cups + lids', 'Packaging', ['booker', 'cashCarry'], {
      image: false,
      note: 'Not stocked at JJ in 540ml',
    }),
    item('straws', 'Jumbo paper smoothie straws', 'Packaging', ['jj'], {
      code: 'CUP207',
      note: 'Milkshakes',
    }),
    item('carrier-bag', 'Medium brown paper carrier bags', 'Packaging', ['jj'], { code: 'BAG184' }),
  ],
};

// From the client's Mexican Re-Launch Tracker (Oct 2026). Codes checked on
// jjfoodservice.com; the eight new relaunch lines (salsas, guacamole, chipotle
// chicken, pulled beef, churros, taquitos, 4" tortillas, Jarritos mango) aren't
// on the website yet, so they keep the tracker's code and have no photo.
const NOT_ONLINE = 'not on the JJ website yet';
const FIESTA_MEXICA: SupplierList = {
  slug: 'fiesta-mexica',
  name: 'Fiesta Mexica',
  match: /fiesta\s*mex/i,
  accent: '#16a34a',
  items: [
    item('chipotle-chicken', 'Halal chipotle chicken (6 × 1kg)', 'Meat & protein', ['jj'], {
      code: 'RDY105',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item('pulled-beef', 'Halal Mexican pulled beef (6 × 1kg)', 'Meat & protein', ['jj'], {
      code: 'RDY106',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item('grated-cheese', 'Grated white cheese (2kg)', 'Meat & protein', ['jj'], {
      itemBrand: 'Kerrymaid',
      code: 'CHE148',
      note: 'Chilled',
    }),
    item('tortilla-12', '12" ambient flour tortilla wraps (6 × 18)', 'Bread & buns', ['jj'], {
      itemBrand: 'Letsdough',
      code: 'BAK461',
      note: 'Ambient · burritos',
    }),
    item('tortilla-6', '6" flour tortilla wraps (10 × 15)', 'Bread & buns', ['jj'], {
      itemBrand: 'Santa Maria',
      code: 'BAK156',
      note: 'Frozen · tacos',
    }),
    item('tortilla-4', '4" tortillas (6 × 24)', 'Bread & buns', ['jj'], {
      code: 'BRE165',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item('lettuce', 'Iceberg lettuce (10–12)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG476',
      note: 'Chilled',
    }),
    item('tomatoes', 'Loose tomatoes, class I (6kg)', 'Fresh veg & salad', ['jj'], {
      code: 'VEG007',
      note: 'Chilled',
    }),
    item('onions', 'Spanish onions', 'Fresh veg & salad', ['jj'], {
      code: 'VGT215',
      note: 'Chilled',
    }),
    item(
      'coriander',
      'Fresh coriander, bunched (100g)',
      'Fresh veg & salad',
      ['supermarket', 'jj'],
      {
        note: 'Self-sourced (tracker SSV007) · JJ sells VEG668, 20 bunches',
      },
    ),
    item('pickled-onions', 'Pink pickled onions (5 × 1kg)', 'Fresh veg & salad', ['jj'], {
      code: 'SAU931',
      note: 'Frozen',
    }),
    item('burrito-rice', 'Veg burrito rice (6 × 1kg)', 'Sides', ['jj'], {
      code: 'RIC124',
      note: 'Frozen',
    }),
    item('black-beans', 'Black turtle beans in water (2.5kg tin)', 'Sides', ['jj'], {
      code: 'VGT050',
      note: 'Ambient',
    }),
    item('tortilla-chips', 'Salted corn tortilla chips (12 × 475g)', 'Sides', ['jj'], {
      itemBrand: 'Santa Maria',
      code: 'CRP191',
      note: 'Ambient · nachos',
    }),
    item('jalapeno-bites', 'Green jalapeño & cheese snacks (1kg)', 'Sides', ['jj'], {
      itemBrand: 'Aviko',
      code: 'VEG909',
      note: 'Frozen',
    }),
    item('taquitos', 'Chilli cheese taquitos (48 × 80g)', 'Sides', ['jj'], {
      code: 'BAK484',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item(
      'cauliflower-bites',
      'Gluten free & vegan Moroccan style cauliflower bites (3 × 1kg)',
      'Sides',
      ['jj'],
      { itemBrand: 'KaterVeg', code: 'VGT027', note: 'Frozen · no photo on JJ', image: false },
    ),
    item('chips', 'Super Crisp double crunch 3/8 skin-on chips (4 × 2.27kg)', 'Sides', ['jj'], {
      code: 'CHP165',
      note: 'Frozen',
    }),
    item('nacho-cheese', 'Nacho cheese sauce (1L)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Macphie',
      code: 'SAU731',
      note: 'Ambient',
    }),
    item('green-salsa', 'Green Mexican salsa (6 × 2.8kg)', 'Sauces & dips', ['jj'], {
      itemBrand: 'Del Sol',
      code: 'SAU923',
      note: 'Ambient',
    }),
    item('chipotle-salsa', 'Chipotle salsa sauce (6 × 2.8kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU920',
      note: `Ambient · ${NOT_ONLINE}`,
      image: false,
    }),
    item('roasted-salsa', 'Roasted salsa (8 × 1kg)', 'Sauces & dips', ['jj'], {
      code: 'SAU921',
      note: 'Frozen · code found on JJ (blank on the tracker)',
    }),
    item('guacamole', 'Premium guacamole (6 × 500g)', 'Sauces & dips', ['jj'], {
      code: 'SAU922',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item('sour-cream', 'Set sour cream (2kg)', 'Sauces & dips', ['jj'], {
      code: 'CRE033',
      note: 'Chilled',
    }),
    item('lime-juice', 'Lime juice (1L)', 'Seasoning', ['jj'], {
      itemBrand: 'Gomo',
      code: 'SAU783',
      note: 'Chilled',
    }),
    item('rapeseed-oil', 'Extended life rapeseed oil (20L drum)', 'Oil & coatings', ['jj'], {
      code: 'OIL115',
      note: 'Ambient · fryer',
    }),
    item('churros', 'Churros loops (4 × 1kg)', 'Desserts', ['jj'], {
      itemBrand: 'Aviko',
      code: 'DES458',
      note: `Frozen · ${NOT_ONLINE}`,
      image: false,
    }),
    item('toffee-sauce', 'Toffee & Devon cream drizzle sauce (500g)', 'Desserts', ['jj'], {
      itemBrand: 'DaVinci Gourmet',
      code: 'ICE261',
      note: 'Ambient · churros',
    }),
    item('sugar', 'Granulated sugar (5kg)', 'Desserts', ['jj', 'supermarket'], {
      itemBrand: 'Tate & Lyle',
      code: 'SPI524',
      note: 'Ambient · churros · tracker says self-source',
    }),
    item('coke', 'Coca-Cola cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK063' }),
    item('coke-zero', 'Coca-Cola Zero Sugar cans (24 × 330ml)', 'Drinks', ['jj'], {
      code: 'DRK329',
    }),
    item('diet-coke', 'Diet Coke cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK062' }),
    item('water', 'Harrogate still spring water (24 × 500ml)', 'Drinks', ['jj'], {
      code: 'DRK025',
    }),
    item('jarritos-lime', 'Jarritos lime, glass bottle (12 × 370ml)', 'Drinks', ['jj'], {
      code: 'DRN786',
    }),
    item('jarritos-mango', 'Jarritos mango, glass bottle (12 × 370ml)', 'Drinks', ['jj'], {
      code: 'DRN788',
      note: NOT_ONLINE,
      image: false,
    }),
    item('burger-box', '6" white bagasse burger box (500)', 'Packaging', ['jj'], {
      code: 'BOX152',
    }),
    item('sauce-cup-4oz', '4oz hinged sauce cups (500)', 'Packaging', ['jj'], { code: 'CON097' }),
    item(
      'kraft-container-750',
      '750ml kraft rectangular food container (300)',
      'Packaging',
      ['jj'],
      {
        code: 'CON220',
        note: 'Lid CON222',
      },
    ),
    item(
      'kraft-container-1000',
      '1000ml kraft rectangular food container (300)',
      'Packaging',
      ['jj'],
      { code: 'CON221', note: 'Lid CON222' },
    ),
    item('kraft-lids', 'Kraft food container lids, 500–1000ml (300)', 'Packaging', ['jj'], {
      code: 'CON222',
    }),
    item('stickers', 'Branded stickers (500)', 'Packaging', ['brandPackaging'], { image: false }),
    item('bags', 'Branded bags (250)', 'Packaging', ['brandPackaging'], { image: false }),
    item('honeycomb-foil', 'Honeycomb foil (500)', 'Packaging', ['brandPackaging'], {
      image: false,
    }),
    item('greaseproof', 'Mexican stack greaseproof (1000)', 'Packaging', ['brandPackaging'], {
      image: false,
    }),
  ],
};

// Built 2026-10-24 from the SNACK ATTACK-HADDON menu's assembly charts and
// options, each matched to a JJ Foodservice product. Scottish breakfast lines
// JJ doesn't stock (Lorne, haggis, morning rolls, tattie scones, Morton's
// rolls) come from a local butcher / bakery.
const SNACK_ATTACK: SupplierList = {
  slug: 'snack-attack',
  name: 'Snack Attack',
  match: /snack\s*attack/i,
  accent: '#7c3aed',
  items: [
    item('back-bacon', 'A1 rindless back bacon (2.27kg)', 'Meat & protein', ['jj'], { code: 'BAC002', note: 'Breakfasts, rolls, wraps, Hunters fries, burger add-on' }),
    item('lorne-sausage', 'Lorne (square) sausage', 'Meat & protein', ['localButcher'], { note: 'Breakfasts, rolls, wraps', image: false }),
    item('link-sausage', 'Cumberland-style pork sausages', 'Meat & protein', ['jj'], { code: 'SGS035', note: 'Link sausage — breakfasts and kids sausages' }),
    item('haggis', 'Haggis', 'Meat & protein', ['localButcher', 'supermarket'], { itemBrand: 'Macsween', note: 'Big Scottish breakfast, rolls', image: false }),
    item('black-pudding', 'Black pudding (1.36kg)', 'Meat & protein', ['jj'], { itemBrand: 'The Bury', code: 'POR082', note: 'Breakfasts, rolls' }),
    item('veggie-sausage', 'Vegan sausages (2kg)', 'Meat & protein', ['jj'], { itemBrand: 'Quorn', code: 'VEG965', note: 'Veggie & vegan breakfasts' }),
    item('vegan-haggis', 'Vegetarian haggis', 'Meat & protein', ['supermarket'], { itemBrand: 'Macsween', note: 'Vegan breakfast, rolls', image: false }),
    item('vegan-black-pudding', 'Vegan black pudding', 'Meat & protein', ['supermarket'], { note: 'Vegan breakfast, rolls', image: false }),
    item('eggs', 'Free range medium eggs (360)', 'Meat & protein', ['jj'], { code: 'EGG031', note: 'Fried & scrambled egg, French toast, egg mayo' }),
    item('ham', 'Sliced gammon ham (500g)', 'Meat & protein', ['jj'], { itemBrand: 'Wessex', code: 'GAM038', note: 'Sandwiches, toasties, kids lunch box' }),
    item('corned-beef', 'Corned beef', 'Meat & protein', ['cashCarry', 'supermarket'], { note: 'Sandwich filling', image: false }),
    item('chopped-pork', 'Chopped pork', 'Meat & protein', ['cashCarry', 'supermarket'], { note: 'Sandwich filling', image: false }),
    item('cooked-chicken', 'Halal cooked chicken breast', 'Meat & protein', ['jj'], { code: 'CHI498', note: 'Chicken mayo, piri-piri & honey chilli chicken' }),
    item('tuna', 'Tuna chunks in brine (6 × 1.7kg)', 'Meat & protein', ['jj'], { code: 'FSH832', note: 'Tuna mayo' }),
    item('doner', 'Classic doner kebab (5kg)', 'Meat & protein', ['jj'], { itemBrand: 'Ali Baba', code: 'DON103', note: 'Kebab fries' }),
    item('vegan-kebab', 'Vegan kebab meat', 'Meat & protein', ['supermarket'], { note: 'Vegan kebab fries', image: false }),
    item('crispy-chicken', 'Crispy popcorn chicken', 'Meat & protein', ['jj'], { code: 'CHI833', note: 'Hunters & salt n chilli chicken fries' }),
    item('vegan-chicken', 'Vegan chicken pieces', 'Meat & protein', ['supermarket'], { note: 'Vegan salt n chilli fries', image: false }),
    item('beef-burger', 'Halal superior beef burger 4oz (48)', 'Meat & protein', ['jj'], { code: 'BUR121', note: 'Beef burger' }),
    item('chicken-fillet', 'Battered whole-muscle chicken fillet', 'Meat & protein', ['jj'], { code: 'CHI834', note: 'Chicken burger' }),
    item('spicy-chicken-fillet', 'Hot & spicy chicken fillet', 'Meat & protein', ['jj'], { code: 'CHI742', note: 'Spicy chicken burger' }),
    item('nuggets', 'Battered crispy chicken nuggets', 'Meat & protein', ['jj'], { code: 'CHI743', note: 'Kids chicken nuggets' }),
    item('fish-fingers', 'MSC whitefish fish fingers', 'Meat & protein', ['jj'], { code: 'FSH616', note: 'Kids fish fingers' }),
    item('hot-dog', 'Frankfurters 7.5" (60)', 'Meat & protein', ['jj'], { itemBrand: 'Malones', code: 'SGS042', note: 'Hot dog fries' }),
    item('cheddar', 'Grated red cheddar (2kg)', 'Meat & protein', ['jj'], { itemBrand: 'Buttercup', code: 'CHE169', note: 'Chips & cheese, toasties, wraps, Hunters fries' }),
    item('cheese-slices', 'Mature cheddar slices (1kg)', 'Meat & protein', ['jj'], { code: 'CHE036', note: 'Sandwiches, burgers, French toast' }),
    item('vegan-cheese', 'Grated vegan cheddar', 'Meat & protein', ['jj'], { itemBrand: 'Green Vie', code: 'CHE204', note: 'Vegan kebab fries, vegan burger add-on' }),
    item('morning-rolls', 'Scottish morning rolls', 'Bread & buns', ['localBakery'], { note: 'Filled rolls, Wee breakfast, soup roll', image: false }),
    item('bloomer', 'White & brown bloomer loaves', 'Bread & buns', ['localBakery'], { note: 'Sandwiches, French toast', image: false }),
    item('burger-rolls', 'Morton\'s rolls', 'Bread & buns', ['localBakery'], { itemBrand: 'Morton\'s', note: 'Every burger', image: false }),
    item('sliced-bread', 'Thick sliced white bread', 'Bread & buns', ['jj'], { itemBrand: 'Kingsmill', code: 'BRE062', note: 'Toasties, kids sandwiches' }),
    item('wholemeal-bread', 'Thick sliced wholemeal bread', 'Bread & buns', ['jj'], { itemBrand: 'Kingsmill', code: 'BRE064', note: 'Toasties, sandwiches' }),
    item('panini', 'Part-baked panini 27cm (30)', 'Bread & buns', ['jj'], { itemBrand: 'Letsdough', code: 'BAK071', note: 'Pannini' }),
    item('wraps', '12" flour tortilla wraps', 'Bread & buns', ['jj'], { code: 'BAK306', note: 'Breakfast wrap, wraps' }),
    item('tattie-scones', 'Tattie (potato) scones', 'Bread & buns', ['localBakery', 'supermarket'], { note: 'Breakfasts, rolls', image: false }),
    item('lettuce', 'Iceberg lettuce (10–12)', 'Fresh veg & salad', ['jj'], { code: 'VEG476', note: 'Burgers, sandwiches, salad box' }),
    item('tomatoes', 'Tomatoes (6kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG007', note: 'Grilled tomato, burgers, salad' }),
    item('red-onion', 'Red onions (10kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG490', note: 'Burgers, sandwiches, salad box' }),
    item('onions', 'Brown onions (4kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG696', note: 'Fried onions, salt n chilli fries' }),
    item('peppers', 'Mixed peppers (5kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG026', note: 'Salt n chilli fries, salad box' }),
    item('mushrooms', 'Button mushrooms (2.5kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG879', note: 'Breakfasts' }),
    item('spring-onions', 'Spring onions', 'Fresh veg & salad', ['jj'], { code: 'VEG402', note: 'Vegan kebab fries' }),
    item('cucumber', 'Cucumbers', 'Fresh veg & salad', ['jj'], { code: 'VEG902', note: 'Detox Delight smoothie, salads' }),
    item('spinach', 'Fresh spinach leaves (5 × 200g)', 'Fresh veg & salad', ['jj'], { code: 'VEG791', note: 'Detox Delight smoothie' }),
    item('coleslaw', 'Coleslaw (2kg)', 'Fresh veg & salad', ['jj'], { code: 'SAN105', note: 'Salad box, add-ons' }),
    item('baking-potatoes', 'Baking potatoes (approx 40, 15kg)', 'Fresh veg & salad', ['jj'], { code: 'POT166', note: 'Baked potato' }),
    item('jalapenos', 'Sliced jalapeños (3kg tin)', 'Fresh veg & salad', ['jj'], { code: 'VGT111', note: 'Filling / extra' }),
    item('sweetcorn', 'Sweetcorn (2.23kg)', 'Fresh veg & salad', ['jj'], { code: 'VGT138', note: 'Filling / extra' }),
    item('bananas', 'Bananas', 'Fresh veg & salad', ['supermarket'], { note: 'Smoothies, banana shake', image: false }),
    item('strawberries', 'Frozen strawberries', 'Fresh veg & salad', ['jj'], { itemBrand: 'Greens', code: 'VEG268', note: 'Strawberry Split, strawberry shake' }),
    item('mango', 'Frozen diced mango (1kg)', 'Fresh veg & salad', ['jj'], { itemBrand: 'Greens', code: 'FRU121', note: 'Blue Lagoon, Tropical Delight' }),
    item('peach', 'Peach slices in juice (2.65kg)', 'Fresh veg & salad', ['jj'], { code: 'VEG202', note: 'Blue Lagoon, Tropical Delight' }),
    item('coconut', 'Desiccated coconut (1kg)', 'Fresh veg & salad', ['jj'], { code: 'SPI627', note: 'Blue Lagoon' }),
    item('passion-fruit', 'Passion fruit', 'Fresh veg & salad', ['supermarket'], { note: 'Tropical Delight', image: false }),
    item('spirulina', 'Blue spirulina powder', 'Fresh veg & salad', ['supermarket'], { note: 'Blue Lagoon', image: false }),
    item('pineapple-juice', 'Pineapple juice (12 × 250ml)', 'Fresh veg & salad', ['jj'], { itemBrand: 'Folkington’s', code: 'DRN982', note: 'Detox Delight' }),
    item('chips', 'Crispy 3/8 chips (4 × 2.27kg)', 'Sides', ['jj'], { code: 'CHP216', note: 'Chips, loaded fries, kids meals, burger add-on' }),
    item('hash-browns', 'Hash browns (2.27kg)', 'Sides', ['jj'], { code: 'POT184', note: 'Breakfasts' }),
    item('baked-beans', 'Baked beans (6 × 2.62kg)', 'Sides', ['jj'], { itemBrand: 'Heinz', code: 'VEG063', note: 'Breakfasts, kids meals' }),
    item('red-lentils', 'Red split lentils (2kg)', 'Sides', ['jj'], { itemBrand: 'Laila', code: 'LEN031', note: 'Lentil soup' }),
    item('veg-bouillon', 'Vegetable bouillon (1kg)', 'Sides', ['jj'], { itemBrand: 'Gomo', code: 'MIS112', note: 'Lentil soup' }),
    item('pancakes', 'American buttermilk pancakes', 'Sides', ['jj'], { code: 'BAK439', note: 'Pancakes' }),
    item('crispy-onions', 'Crispy fried onions (1kg)', 'Sides', ['jj'], { code: 'SPI700', note: 'Loaded fries' }),
    item('butter', 'Butter portions (600)', 'Sauces & dips', ['jj'], { itemBrand: 'Lakeland', code: 'DAI219', note: 'Morning rolls, soup roll, baked potato' }),
    item('spread', 'Soft spread (2kg)', 'Sauces & dips', ['jj'], { itemBrand: 'Golden Summer', code: 'SPR045', note: 'Sandwiches; dairy-free for vegan orders' }),
    item('egg-mayo', 'Egg mayonnaise filling (1kg)', 'Sauces & dips', ['jj'], { code: 'SAN100', note: 'Egg mayo filling' }),
    item('tuna-mayo', 'Tuna mayonnaise filling (1kg)', 'Sauces & dips', ['jj'], { code: 'SAN101', note: 'Tuna mayo filling' }),
    item('mayo', 'Mayonnaise (10L)', 'Sauces & dips', ['jj'], { itemBrand: 'Hellmann’s', code: 'SAU470', note: 'Chicken mayo, dips' }),
    item('garlic-mayo', 'Mayo + garlic mayo squeezy pack', 'Sauces & dips', ['jj'], { code: 'SAU240', note: 'Kebab fries, dips' }),
    item('sweet-chilli', 'Sweet chilli sauce (6 × 1L)', 'Sauces & dips', ['jj'], { itemBrand: 'Crucials', code: 'SAU246', note: 'Dip, honey chilli chicken' }),
    item('franks', 'Frank’s RedHot original', 'Sauces & dips', ['jj'], { code: 'SAU551', note: 'Franks hot sauce mayo dip' }),
    item('bbq', 'Kansas City BBQ sauce', 'Sauces & dips', ['jj'], { itemBrand: 'Santa Maria', code: 'SCS011', note: 'Hunters chicken fries, dip' }),
    item('curry-sauce', 'Curry sauce mix', 'Sauces & dips', ['jj'], { itemBrand: 'Dinaclass', code: 'SAU097', note: 'Chips & curry, curry dip (or Young’s from a supermarket)' }),
    item('sriracha', 'Sriracha hot chilli sauce', 'Sauces & dips', ['jj'], { itemBrand: 'Panich', code: 'SAU869', note: 'Kebab fries, sriracha mayo' }),
    item('piri-piri', 'Piri piri hot sauce', 'Sauces & dips', ['jj'], { itemBrand: 'Lion', code: 'SAU507', note: 'Piri-piri chicken mayo, dip' }),
    item('ketchup', 'Tomato ketchup top-down (4L)', 'Sauces & dips', ['jj'], { itemBrand: 'Heinz', code: 'SAU971', note: 'Hot dog fries, breakfasts' }),
    item('mustard', 'American mild mustard', 'Sauces & dips', ['jj'], { code: 'SAU033', note: 'Hot dog fries' }),
    item('gravy', 'Gravy granules', 'Sauces & dips', ['supermarket', 'cashCarry'], { itemBrand: 'Bisto', note: 'Chips & gravy', image: false }),
    item('pickle', 'Gherkins (2.45kg jar)', 'Sauces & dips', ['jj'], { code: 'VEG055', note: 'Pickle filling (Branston from a supermarket)' }),
    item('maple-syrup', 'Pure maple syrup', 'Sauces & dips', ['jj'], { itemBrand: 'Buckwud', code: 'ICE192', note: 'Pancakes, French toast' }),
    item('honey', 'Squeezy honey', 'Sauces & dips', ['jj'], { itemBrand: 'Rowse', code: 'MIS220', note: 'Honey chilli chicken' }),
    item('salt-chilli', 'Salt n chilli seasoning', 'Seasoning', ['supermarket', 'cashCarry'], { note: 'Homemade salt n chilli fries', image: false }),
    item('salt', 'Table salt', 'Seasoning', ['jj'], { code: 'SPI082', note: 'Chips' }),
    item('vinegar', 'Malt vinegar (2 × 5L)', 'Seasoning', ['jj'], { code: 'SAU449', note: 'Chips' }),
    item('oil', 'Rapeseed frying oil (20L)', 'Oil & coatings', ['jj'], { itemBrand: 'Pride', code: 'OIL055', note: 'All frying' }),
    item('milkshake-mix', 'Thick shake mix (12 × 1L)', 'Desserts', ['jj'], { itemBrand: 'Kerrymaid', code: 'ICE008', note: 'Shmoo-style thick shakes' }),
    item('ice-cream', 'Soft ice cream mix (12 × 1L)', 'Desserts', ['jj'], { itemBrand: 'Kerrymaid', code: 'ICE010', note: 'Shakes' }),
    item('whipped-cream', 'Aerosol real dairy cream', 'Desserts', ['jj'], { code: 'CRE017', note: 'Hot chocolate & shake toppings' }),
    item('marshmallows', 'Mini marshmallows', 'Desserts', ['supermarket'], { note: 'Hot chocolate topping', image: false }),
    item('sprinkles', 'Hundreds and thousands', 'Desserts', ['supermarket'], { note: 'Hot chocolate topping', image: false }),
    item('custard', 'Ready-to-serve custard (1L)', 'Desserts', ['jj'], { itemBrand: 'Kerrymaid', code: 'CRE021', note: 'Served hot with custard' }),
    item('carrot-cake', 'Carrot cake, pre-sliced (16)', 'Desserts', ['jj'], { itemBrand: 'Letscake', code: 'DES427', note: 'Snacks' }),
    item('scones', 'Sultana scones', 'Desserts', ['jj'], { itemBrand: 'Kara', code: 'BAK041', note: 'Fruit scones (or bake in house)' }),
    item('coffee-beans', 'Coffee beans (1kg)', 'Drinks', ['jj'], { itemBrand: 'Lavazza Top Class', code: 'COF091', note: 'Americano, latte, cappuccino, mocha, iced latte' }),
    item('decaf-beans', 'Decaf coffee beans (1kg)', 'Drinks', ['jj'], { itemBrand: 'Lavazza Dek', code: 'COF089', note: 'Make it decaf' }),
    item('tea-bags', 'Tea bags (1100)', 'Drinks', ['jj'], { itemBrand: 'Tetley', code: 'TEA027', note: 'Tea' }),
    item('hot-chocolate', 'Drinking hot chocolate (2kg)', 'Drinks', ['jj'], { itemBrand: 'Cadbury', code: 'DRK089', note: 'Hot chocolate, mocha' }),
    item('milk', 'Fresh semi-skimmed milk (2L)', 'Drinks', ['jj'], { code: 'DAI006', note: 'Hot drinks, iced latte, matcha' }),
    item('oat-milk', 'Oat milk barista (1L)', 'Drinks', ['jj'], { itemBrand: 'Alpro', code: 'DAI201', note: 'Add oat milk' }),
    item('almond-milk', 'Almond milk barista (1L)', 'Drinks', ['jj'], { itemBrand: 'Alpro', code: 'DAI182', note: 'Add almond milk' }),
    item('coconut-milk', 'Coconut milk drink', 'Drinks', ['supermarket'], { itemBrand: 'Alpro', note: 'Add coconut milk', image: false }),
    item('matcha', 'Matcha powder (250g)', 'Drinks', ['jj'], { itemBrand: 'PerfectTed', code: 'TEA111', note: 'Iced matcha' }),
    item('syrup-vanilla', 'Vanilla syrup (70cl)', 'Drinks', ['jj'], { itemBrand: 'Monin', code: 'DRN161', note: 'Coffee syrups — other flavours from Monin too' }),
    item('syrup-caramel', 'Caramel syrup (70cl)', 'Drinks', ['jj'], { itemBrand: 'Monin', code: 'DRN162', note: 'Coffee syrups' }),
    item('syrup-hazelnut', 'Hazelnut syrup (70cl)', 'Drinks', ['jj'], { itemBrand: 'Monin', code: 'DRN160', note: 'Coffee syrups' }),
    item('coca-cola', 'Coca-Cola cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK063' }),
    item('diet-coke', 'Diet Coke cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK062' }),
    item('coke-zero', 'Coca-Cola Zero cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK329' }),
    item('sprite', 'Sprite cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK447' }),
    item('fanta-orange', 'Fanta Orange cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK075' }),
    item('fanta-lemon', 'Fanta Lemon cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK074' }),
    item('irn-bru', 'Irn-Bru cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK155' }),
    item('vimto', 'Vimto cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK512' }),
    item('dr-pepper', 'Dr Pepper cans (24 × 330ml)', 'Drinks', ['jj'], { code: 'DRK448' }),
    item('red-bull', 'Red Bull (24 × 250ml)', 'Drinks', ['jj'], { code: 'DRK135' }),
    item('monster', 'Monster Energy (12 × 500ml)', 'Drinks', ['jj'], { code: 'DRN296' }),
    item('monster-mango', 'Monster Mango Loco (12 × 500ml)', 'Drinks', ['jj'], { code: 'DRN582' }),
    item('water', 'Still water (24 × 500ml)', 'Drinks', ['jj'], { code: 'DRS008' }),
    item('oasis', 'Oasis Summer Fruits', 'Drinks', ['jj'], { code: 'DRN080' }),
    item('orange-juice', 'Orange juice (12 × 250ml)', 'Drinks', ['jj'], { code: 'DRN824' }),
    item('simply-fruity-orange', 'Simply Fruity Orange (12 × 330ml)', 'Drinks', ['jj'], { code: 'DRN623', note: 'Kids meals' }),
    item('simply-fruity-blackcurrant', 'Simply Fruity Blackcurrant (12 × 330ml)', 'Drinks', ['jj'], { code: 'DRN624', note: 'Kids meals' }),
    item('crisps-ready-salted', 'Walkers Ready Salted (32 × 32.5g)', 'Desserts', ['jj'], { code: 'CRP152', note: 'Snacks, kids lunch box' }),
    item('crisps-cheese-onion', 'Walkers Cheese & Onion (32 × 32.5g)', 'Desserts', ['jj'], { code: 'CRP154', note: 'Snacks' }),
    item('kitkat', 'KitKat 4 finger (24)', 'Desserts', ['jj'], { code: 'CHO088', note: 'Snacks' }),
    item('galaxy', 'Galaxy bars (24 × 42g)', 'Desserts', ['jj'], { code: 'CHO040', note: 'Snacks' }),
    item('jaffa', 'Jaffa Cakes 4-pack', 'Desserts', ['jj'], { itemBrand: 'McVitie’s', code: 'SNA143', note: 'Snacks' }),
    item('tunnocks', 'Tunnock’s tea cakes, caramel logs, wafers', 'Desserts', ['cashCarry', 'supermarket'], { itemBrand: 'Tunnock’s', note: 'Snacks', image: false }),
    item('pick-mix', 'Pick and mix sweets', 'Desserts', ['supermarket'], { itemBrand: 'Rokozy', note: 'Small / big mix', image: false }),
    item('clamshell', 'Large card clamshell box', 'Packaging', ['jj'], { code: 'BOX120', note: 'Kids meals, loaded fries' }),
    item('burger-box', 'Small gourmet burger box', 'Packaging', ['jj'], { code: 'BOX138', note: 'Burgers' }),
    item('foil-lids', 'No.6A foil container lids', 'Packaging', ['jj'], { code: 'CON150', note: 'Breakfasts, chips, fries (order matching No.6A trays)' }),
    item('soup-pots', '750ml round microwave containers', 'Packaging', ['jj'], { code: 'CON145', note: 'Soup, salad box' }),
    item('hot-cups', '12oz ripple hot cups', 'Packaging', ['jj'], { code: 'CUP258', note: 'Hot drinks' }),
    item('cup-lids', '12/16oz cup lids', 'Packaging', ['jj'], { code: 'CUP265', note: 'Hot drinks' }),
    item('smoothie-cups', '12oz smoothie cups', 'Packaging', ['jj'], { code: 'CUP234', note: 'Smoothies, shakes, iced drinks (lid CUP236)' }),
    item('paper-bags', 'Hot food bags 6" × 9"', 'Packaging', ['jj'], { code: 'BAG209', note: 'Rolls, toasties, panini' }),
    item('greaseproof', 'Greaseproof paper sheets', 'Packaging', ['jj'], { code: 'WRA016', note: 'Wraps, rolls' }),
    item('napkins', '2-ply white napkins', 'Packaging', ['jj'], { code: 'HYG186' }),
    item('cutlery', 'Wooden cutlery packs', 'Packaging', ['jj'], { code: 'CUT068' }),
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
    match: /burger[sz]?\s*(and|&)\s*frie[sz]/i,
    accent: '#ea580c',
    photos: MONSTER_BURGERZ.slug,
  },
  GREEK_GYROS,
  {
    ...GREEK_GYROS,
    slug: 'greek-bite',
    name: 'Greek Bite',
    match: /greek\s*bite/i,
    accent: '#0891b2',
    photos: GREEK_GYROS.slug,
  },
  KOREAN_FRIED_CHICKEN,
  CHICAGO_PIZZERIA,
  FIESTA_MEXICA,
  SNACK_ATTACK,
];

/** The lists for brands on these menus (by menu name), in registry order. */
export const supplierListsForMenus = (menuNames: string[]) =>
  SUPPLIER_LISTS.filter((l) => menuNames.some((n) => l.match.test(n)));

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
