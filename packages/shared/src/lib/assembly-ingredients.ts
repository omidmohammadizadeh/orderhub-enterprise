/**
 * The ingredient library behind assembly charts. Each entry is drawn by one of
 * a few dozen parametric SVG "shapes" (sauce squiggle, dollop, diced, slices,
 * flatbread, box…) in its own colours, so a few hundred ingredients cost no
 * images. Collected from the group's own menus (Wanna Smash, Rudi's, WingDrop,
 * Mikos Gyros, Fattoush, Casa Mexa / Papi Taco ingredients key, Pizza Uno,
 * Snack Attack) plus the usual UK takeaway range.
 *
 * Plain data only — this package compiles without DOM or Node types.
 */

export type IngredientShape =
  | "legacy" // hand-drawn originals (buns, patty…) — key names the drawing
  | "squiggle"
  | "drizzle"
  | "dollop"
  | "diced"
  | "slices"
  | "rings"
  | "shreds"
  | "leaves"
  | "slab"
  | "strips"
  | "flatbread"
  | "pizza_base"
  | "chunks"
  | "balls"
  | "sticks"
  | "grains"
  | "beans"
  | "wedge"
  | "crumbs"
  | "wings"
  | "nuggets"
  | "wrap"
  | "chips"
  | "taco"
  | "sheet"
  | "curly"
  | "box_clam"
  | "box_burger"
  | "box_pizza"
  | "tray_taco"
  | "bowl"
  | "foil"
  | "pot"
  | "cup"
  | "bag"
  | "cone"
  | "paper"
  | "can";

export type IngredientCategory =
  | "bread"
  | "sauces"
  | "cheese"
  | "meat"
  | "veg"
  | "mexican"
  | "pizza"
  | "grill"
  | "sides"
  | "breakfast"
  | "desserts"
  | "seasoning"
  | "packaging"
  | "other";

export const INGREDIENT_CATEGORIES: Array<{ id: IngredientCategory; name: string }> = [
  { id: "bread", name: "Buns & bread" },
  { id: "sauces", name: "Sauces" },
  { id: "cheese", name: "Cheese" },
  { id: "meat", name: "Meat & protein" },
  { id: "veg", name: "Veg & toppings" },
  { id: "mexican", name: "Mexican" },
  { id: "pizza", name: "Pizza" },
  { id: "grill", name: "Grill & kebab" },
  { id: "sides", name: "Sides" },
  { id: "breakfast", name: "Breakfast" },
  { id: "desserts", name: "Desserts" },
  { id: "seasoning", name: "Seasoning" },
  { id: "packaging", name: "Packaging" },
  { id: "other", name: "Other" },
];

export interface AssemblyIngredient {
  key: string;
  name: string;
  category: IngredientCategory;
  shape: IngredientShape;
  /** [main, accent] colours for the drawing */
  colors: [string, string];
  /** Default label when added (defaults to name) */
  label?: string;
  /** Extra search words */
  aliases?: string;
  /** Sauces etc. — the editor offers a colour picker */
  recolourable?: boolean;
  /** Extra tabs it also appears under (pepperoni lives in Meat but is a pizza topping) */
  alsoIn?: IngredientCategory[];
}

type Row = [key: string, name: string, shape: IngredientShape, c1: string, c2?: string, label?: string, aliases?: string];

const SAUCY = new Set<IngredientShape>(["squiggle", "drizzle", "dollop"]);

function build(category: IngredientCategory, rows: Row[]): AssemblyIngredient[] {
  return rows.map(([key, name, shape, c1, c2, label, aliases]) => ({
    key,
    name,
    category,
    shape,
    colors: [c1, c2 ?? c1],
    ...(label ? { label } : {}),
    ...(aliases ? { aliases } : {}),
    ...(SAUCY.has(shape) ? { recolourable: true } : {}),
  }));
}

export const ASSEMBLY_INGREDIENTS: AssemblyIngredient[] = [
  ...build("bread", [
    ["bun_top", "Top bun", "legacy", "#f6b649", "#e3871f", "Toasted", "brioche sesame crown"],
    ["bun_bottom", "Bottom bun", "legacy", "#f2a23a", "#f8c66b", "Toasted", "heel brioche"],
    ["bun_upside_down", "Upside-down bun", "legacy", "#f6b649", "#e3871f", "Upside down bun", "flipped"],
    ["toast", "Toast", "slab", "#e9b56a", "#f6d9a0", "Toasted bread", "sliced bread"],
    ["tortilla_12", '12" tortilla', "flatbread", "#f1dfb0", "#d9b679", '12" tortilla', "flour wrap burrito"],
    ["tortilla_6", '6" tortilla', "flatbread", "#f1dfb0", "#d9b679", '6" tortilla', "flour taco"],
    ["corn_tortilla", "Corn tortilla", "flatbread", "#e8c25a", "#c9962f", "Corn tortillas", "taco"],
    ["wrap", "Wrap", "flatbread", "#f4ead0", "#d9c08e", "Wrap", "tortilla flatbread"],
    ["pitta", "Pitta", "flatbread", "#f0d29a", "#d8a865", "Pitta", "pita greek"],
    ["naan", "Naan", "flatbread", "#f3d7a2", "#c98a3f", "Naan", "flatbread garlic"],
    ["flatbread", "Flatbread", "flatbread", "#efd3a0", "#c7924c"],
    ["garlic_bread", "Garlic bread", "slab", "#e8b866", "#5d8a2a", "Garlic bread"],
    ["hot_dog_bun", "Hot dog bun", "sticks", "#f2a23a", "#f8c66b", "Hot dog bun", "roll"],
    ["burrito_wrap", "Rolled burrito", "wrap", "#f1dfb0", "#d9b679", "Roll & fold", "burrito wrapped"],
  ]),
  ...build("sauces", [
    ["sauce", "Sauce (any colour)", "squiggle", "#f39a2b", "#f39a2b", "Sauce"],
    ["ketchup", "Ketchup", "squiggle", "#d7261e", "#d7261e", "Ketchup", "tomato red"],
    ["bbq_sauce", "BBQ sauce", "squiggle", "#4a2516", "#4a2516", "BBQ sauce", "smoky kansas sticky barbecue"],
    ["mustard", "Mustard", "squiggle", "#e8b81a", "#e8b81a", "Mustard", "american yellow"],
    ["mayo", "Mayo", "squiggle", "#f3e6bf", "#f3e6bf", "Mayo", "mayonnaise"],
    ["garlic_mayo", "Garlic mayo", "squiggle", "#efe2c4", "#efe2c4", "Garlic mayo", "aioli"],
    ["garlic_sauce", "Garlic sauce", "squiggle", "#f1ecdc", "#f1ecdc", "Garlic sauce", "kebab white"],
    ["burger_sauce", "Burger sauce", "squiggle", "#f39a2b", "#f39a2b", "Burger sauce", "house special"],
    ["biggie_mac", "Biggie Mac sauce", "squiggle", "#f0a04b", "#f0a04b", "Biggie Mac sauce", "big mac thousand island"],
    ["og_sauce", "OG / house sauce", "squiggle", "#e8823a", "#e8823a", "OG sauce", "slutty special house"],
    ["ranch", "Ranch", "squiggle", "#f4ecd6", "#f4ecd6", "Ranch", "buttermilk"],
    ["peri_mild", "Peri peri (mild)", "squiggle", "#e8682a", "#e8682a", "Mild peri peri", "piri lemon"],
    ["peri_hot", "Peri peri (hot)", "squiggle", "#c9321b", "#c9321b", "Hot peri peri", "piri extra hot"],
    ["lemon_herb", "Lemon & herb", "squiggle", "#e6c13a", "#e6c13a", "Lemon & herb", "peri"],
    ["chilli_sauce", "Chilli sauce", "squiggle", "#c72a1a", "#c72a1a", "Chilli sauce", "kebab red hot"],
    ["sweet_chilli", "Sweet chilli", "squiggle", "#e8532b", "#e8532b", "Sweet chilli"],
    ["hot_sauce", "Hot sauce", "squiggle", "#e2531b", "#e2531b", "Hot sauce", "og hellraiser"],
    ["buffalo", "Buffalo sauce", "squiggle", "#e2611b", "#e2611b", "Buffalo sauce", "tang wings"],
    ["nashville", "Nashville hot", "squiggle", "#b8321f", "#b8321f", "Nashville heat"],
    ["hot_honey", "Hot honey", "drizzle", "#e0a019", "#e0a019", "Hot honey", "sweet"],
    ["honey_mustard", "Honey mustard", "squiggle", "#dcae2a", "#dcae2a", "Honey mustard"],
    ["chipotle_mayo", "Chipotle mayo", "squiggle", "#e0803e", "#e0803e", "Chipotle mayo", "smoky"],
    ["sriracha_mayo", "Sriracha mayo", "squiggle", "#ef7a4a", "#ef7a4a", "Sriracha mayo", "spicy"],
    ["truffle_mayo", "Truffle mayo", "squiggle", "#e8c98a", "#e8c98a", "Truffle mayo"],
    ["tartare", "Tartare sauce", "squiggle", "#ece6cc", "#ece6cc", "Tartare sauce", "fish"],
    ["korean_glaze", "Sweet Korean glaze", "squiggle", "#b4401f", "#b4401f", "Korean glaze", "gochujang sticky"],
    ["teriyaki", "Teriyaki", "squiggle", "#5a2a14", "#5a2a14", "Teriyaki", "soy"],
    ["gyros_sauce", "Gyros sauce", "squiggle", "#f3ece0", "#f3ece0", "Gyros sauce", "greek"],
    ["curry_sauce", "Curry sauce", "squiggle", "#c98a1a", "#c98a1a", "Curry sauce", "chip shop"],
    ["gravy", "Gravy", "squiggle", "#6b3d1d", "#6b3d1d", "Gravy"],
    ["harissa", "Harissa", "squiggle", "#b0301c", "#b0301c", "Harissa"],
    ["pesto", "Pesto", "squiggle", "#5d8a2a", "#5d8a2a", "Pesto", "basil"],
    ["tahini", "Tahini", "drizzle", "#d9c08e", "#d9c08e", "Tahini", "sesame"],
    ["balsamic", "Balsamic glaze", "drizzle", "#3a1a14", "#3a1a14", "Balsamic glaze"],
    ["cheese_sauce", "Cheese sauce", "drizzle", "#f6b928", "#ffd766", "Cheese sauce", "nacho queso"],
    ["garlic_butter", "Garlic butter", "drizzle", "#f3d77a", "#5d8a2a", "Garlic butter"],
    ["tzatziki", "Tzatziki", "dollop", "#eef0e4", "#9bbf7a", "Tzatziki", "yoghurt cucumber"],
    ["hummus", "Hummus", "dollop", "#e6c99a", "#c79a5c", "Hummus", "houmous chickpea"],
    ["raita", "Mint yoghurt", "dollop", "#e9f0dc", "#7fb069", "Mint yoghurt", "raita"],
  ]),
  ...build("cheese", [
    ["cheese", "Cheese slice", "legacy", "#f7c22f", "#ffe58a", "1 slice American cheese", "american burger"],
    ["cheddar", "Cheddar slice", "sheet", "#f0a830", "#ffcf6a", "Cheddar", "orange slice"],
    ["swiss", "Swiss slice", "sheet", "#f6e7a6", "#fff4c8", "Swiss cheese", "emmental"],
    ["grated_cheese", "Grated cheese", "shreds", "#f5c542", "#ffe17a", "Grated cheese", "cheddar shredded"],
    ["mozzarella", "Mozzarella", "shreds", "#f8f3e3", "#e8dfc4", "Mozzarella", "grated pizza cheese"],
    ["halloumi", "Halloumi", "slab", "#f4ead2", "#c9a36a", "Grilled halloumi", "grilled cheese"],
    ["feta", "Feta", "diced", "#fbf8ee", "#e6e0cc", "Feta", "greek"],
    ["parmesan", "Parmesan", "crumbs", "#f3e3b3", "#e0c98a", "Parmesan"],
    ["goats_cheese", "Goat's cheese", "crumbs", "#fbfaf2", "#e6e1d2", "Goat's cheese"],
    ["blue_cheese", "Blue cheese", "crumbs", "#eef0ec", "#7a8fa6", "Blue cheese"],
    ["vegan_cheese", "Vegan cheese", "sheet", "#f6d36a", "#fff0b0", "Vegan cheese"],
  ]),
  ...build("meat", [
    ["patty_cheese", "Patty + cheese", "legacy", "#5b2f17", "#f7c22f", "85g smash patty with cheese", "smash burger beef"],
    ["patty", "Patty", "legacy", "#5b2f17", "#7b4424", "85g smash patty", "smash beef burger"],
    ["quarter_pounder", "Quarter pounder", "slab", "#5b2f17", "#7b4424", "1/4lb beef patty", "beef burger"],
    ["plant_patty", "Plant patty", "slab", "#6b4a2a", "#8a6a3a", "Plant patty", "vegan veggie"],
    ["chicken", "Fried chicken fillet", "legacy", "#c97f2c", "#e3a64c", "Fried chicken fillet", "crispy breast"],
    ["grilled_chicken", "Grilled chicken breast", "slab", "#d9a05b", "#8a5a2a", "Grilled chicken", "breast fillet"],
    ["chicken_strips", "Chicken strips", "strips", "#d9a05b", "#a8742a", "Chicken strips", "sliced"],
    ["chicken_tenders", "Chicken tenders", "sticks", "#c97f2c", "#e3a64c", "3 chicken tenders", "goujons"],
    ["popcorn_chicken", "Popcorn chicken", "nuggets", "#c97f2c", "#e3a64c", "Popcorn chicken"],
    ["nuggets", "Nuggets", "nuggets", "#d99a3a", "#f2c46a", "Nuggets"],
    ["wings", "Chicken wings", "wings", "#b8501f", "#e07a35", "6 wings", "buffalo hot"],
    ["bbq_wings", "BBQ wings", "wings", "#5a2614", "#8a3a1a", "BBQ wings", "kansas sticky"],
    ["drumsticks", "Drumsticks", "wings", "#c97f2c", "#e3a64c", "Drumsticks", "fried chicken legs"],
    ["bacon", "Bacon", "legacy", "#b8322b", "#f2b4a0", "2 bacon rashers", "streaky"],
    ["turkey_bacon", "Turkey bacon", "strips", "#c4553f", "#f2b4a0", "2 turkey bacon rashers", "halal"],
    ["ham", "Ham", "sheet", "#f1a7a0", "#f8cfc8", "Ham"],
    ["pepperoni", "Pepperoni", "slices", "#b8321f", "#8a1f12", "Pepperoni", "pizza"],
    ["salami", "Salami", "slices", "#b8424a", "#f1c2c2", "Salami", "milano pizza"],
    ["chicken_pieces", "Chicken", "chunks", "#e0b070", "#c98a3a", "Chicken", "cooked chicken pieces"],
    ["diced_chicken", "Diced chicken", "diced", "#e6bd80", "#c98a3a", "Diced chicken", "cubed chicken breast"],
    ["pulled_chicken", "Pulled chicken", "shreds", "#e0b070", "#b9853f", "Pulled chicken", "shredded"],
    ["chicken_tikka_meat", "Chicken tikka", "chunks", "#d3552a", "#f08a4a", "Chicken tikka", "tikka pieces"],
    ["diced_chicken_tikka", "Diced chicken tikka", "diced", "#d3552a", "#f08a4a", "Diced chicken tikka", "tikka cubed"],
    ["tandoori_chicken", "Tandoori chicken", "wings", "#c8321f", "#e8682a", "Tandoori chicken", "tandori leg"],
    ["diced_tandoori", "Diced tandoori chicken", "diced", "#c8321f", "#e8682a", "Diced tandoori chicken", "tandori cubed"],
    ["doner_meat", "Doner meat", "strips", "#8a5434", "#b9835a", "Doner meat", "donner kebab lamb gyros"],
    ["bolognese", "Bolognese beef", "dollop", "#8a2a1a", "#5a2a14", "Bolognese", "beef mince ragu sauce"],
    ["sausage", "Sausage", "sticks", "#8a4a2a", "#b06a3a", "Sausage", "banger"],
    ["hot_dog", "Hot dog", "sticks", "#c0532c", "#e07a4a", "Hot dog", "frankfurter"],
    ["pulled_beef", "Pulled beef", "chunks", "#5a2a1a", "#7b3f25", "Pulled beef", "brisket shredded"],
    ["pulled_pork", "Pulled pork", "chunks", "#8a4a2a", "#b06a3a", "Pulled pork"],
    ["steak", "Steak", "slab", "#7a3a20", "#b05a35", "Steak", "sirloin beef"],
    ["meatballs", "Meatballs", "balls", "#6b3a20", "#8a5434", "Meatballs"],
    ["mince", "Beef mince", "crumbs", "#6b3a20", "#8a5434", "Beef mince", "spicy beef ground"],
    ["tuna", "Tuna", "shreds", "#d9c3a2", "#b9a07a", "Tuna"],
    ["prawns", "Prawns", "nuggets", "#f39a7a", "#ffc4a8", "Prawns", "shrimp king"],
    ["fish_fillet", "Fish fillet", "slab", "#d99a3a", "#f2c46a", "Battered fish", "cod haddock"],
    ["falafel", "Falafel", "balls", "#8a5a2a", "#b9853f", "Falafel", "vegan chickpea"],
    ["tofu", "Tofu", "diced", "#f2ead2", "#d9cfae", "Tofu", "vegan"],
    ["egg", "Fried egg", "legacy", "#fbfaf4", "#f5a623", "Fried egg"],
  ]),
  ...build("veg", [
    ["lettuce", "Lettuce leaf", "legacy", "#5aa832", "#9bd35c", "Lettuce", "iceberg cos"],
    ["shredded_lettuce", "Shredded lettuce", "shreds", "#7cc04a", "#b6e07a", "Shredded lettuce", "iceberg"],
    ["rocket", "Rocket", "leaves", "#4f8a2a", "#7fb04a", "Rocket", "arugula"],
    ["spinach", "Spinach", "leaves", "#3f7a2a", "#6a9a3a", "Spinach"],
    ["salad_mix", "Mixed salad", "leaves", "#5aa832", "#d7261e", "All salad", "lettuce tomato onion"],
    ["tomato", "Tomato slice", "legacy", "#d4271f", "#ec4b3a", "Tomato", "fresh sliced"],
    ["cherry_tomatoes", "Cherry tomatoes", "balls", "#d7261e", "#f26a5a", "Cherry tomatoes"],
    ["diced_tomato", "Diced tomato", "diced", "#d7261e", "#f26a5a", "Diced tomato"],
    ["onions", "Diced onions", "legacy", "#f6f3e6", "#cfc9a6", "Diced onions", "white"],
    ["sliced_onion", "Sliced onion", "rings", "#efe9d6", "#d8cfae", "Sliced onion", "rings raw white"],
    ["red_onion", "Red onion", "rings", "#a3436b", "#e9b8cf", "Red onion", "sliced"],
    ["crispy_onions", "Crispy onions", "shreds", "#c9822a", "#e8b060", "Crispy onions", "fried shallots"],
    ["caramelised_onions", "Caramelised onions", "shreds", "#a25a1f", "#d18a3a", "Caramelised onions", "grilled"],
    ["spring_onion", "Spring onion", "rings", "#6aa33a", "#cfe8a0", "Spring onion", "scallion"],
    ["pickled_onions", "Pickled onions", "shreds", "#e0457a", "#f7a3c4", "Pickled onions", "pink red"],
    ["red_cabbage", "Red cabbage", "shreds", "#7a2a6a", "#b45aa0", "Red cabbage", "kebab salad"],
    ["white_cabbage", "White cabbage", "shreds", "#e8edc9", "#bfcf8a", "Cabbage"],
    ["coleslaw", "Coleslaw", "shreds", "#f1ecd4", "#f08a2a", "Coleslaw", "slaw"],
    ["cucumber", "Cucumber", "slices", "#4f8a2a", "#cfe8a0", "Cucumber"],
    ["pickles", "Pickles", "legacy", "#7aa33a", "#b9d36a", "4x pickles", "gherkins"],
    ["jalapeno", "Jalapeños", "legacy", "#3f8d2c", "#cfe8a0", "Jalapeños", "green chilli sliced"],
    ["green_peppers", "Green peppers", "strips", "#3f8d2c", "#6fbf4a", "Green peppers", "capsicum"],
    ["red_peppers", "Red peppers", "strips", "#d7261e", "#f26a5a", "Red peppers", "capsicum"],
    ["house_peppers", "Mixed peppers", "diced", "#e8532b", "#3f8d2c", "House peppers", "bell peppers diced"],
    ["mushrooms", "Mushrooms", "legacy", "#8b5a3c", "#e9d6bf", "Mushrooms", "sliced"],
    ["sweetcorn", "Sweetcorn", "grains", "#f6cf3a", "#e8b81a", "Sweetcorn", "corn"],
    ["black_olives", "Black olives", "rings", "#2a2a2a", "#555555", "Black olives"],
    ["green_olives", "Green olives", "rings", "#6b7a2a", "#9aa64a", "Green olives", "kalamata"],
    ["avocado", "Avocado", "slices", "#8fb43a", "#e3edb0", "Avocado", "sliced"],
    ["pineapple", "Pineapple", "diced", "#f6d34a", "#e8b81a", "Pineapple"],
    ["grilled_pineapple", "Grilled pineapple", "slab", "#f2c44a", "#a8742a", "Grilled pineapple"],
    ["coriander", "Coriander", "leaves", "#3f8d2c", "#6fbf4a", "Coriander", "cilantro"],
    ["parsley", "Parsley", "leaves", "#2f7a2a", "#5aa832", "Parsley"],
    ["basil", "Basil", "leaves", "#2f7a2a", "#4f9a3a", "Basil"],
    ["mint", "Mint", "leaves", "#3f9a4a", "#7fcf8a", "Mint"],
    ["chillies", "Fresh chillies", "rings", "#c62f20", "#f08a5d", "Chillies", "red green"],
    ["lemon_wedge", "Lemon wedge", "wedge", "#f6d34a", "#fbe9a0", "Lemon wedge"],
    ["lime_wedge", "Lime wedge", "wedge", "#8fbf3a", "#d9ec9a", "Lime wedge"],
    ["grated_carrot", "Grated carrot", "shreds", "#f08a2a", "#f6b060", "Carrot"],
    ["grilled_veg", "Grilled veg", "strips", "#d7261e", "#3f8d2c", "Grilled vegetables", "courgette peppers"],
  ]),
  ...build("mexican", [
    ["guacamole", "Guacamole", "dollop", "#8fb43a", "#c6dc6b", "Guacamole", "guac avocado"],
    ["sour_cream", "Sour cream", "dollop", "#fbfaf4", "#e6e1d2", "Sour cream"],
    ["mild_salsa", "Mild salsa", "dollop", "#d23b2b", "#f08a5d", "Mild salsa", "tomato"],
    ["medium_salsa", "Medium salsa", "dollop", "#6d8f2c", "#a9c45a", "Medium salsa", "green"],
    ["spicy_salsa", "Spicy salsa", "dollop", "#b22416", "#e2531b", "Spicy salsa", "hot"],
    ["salsa_verde", "Salsa verde", "dollop", "#6f9a2e", "#a9c45a", "Salsa verde"],
    ["chipotle_salsa", "Chipotle salsa", "dollop", "#9b3a1a", "#c95a2a", "Chipotle salsa", "roasted"],
    ["pico_de_gallo", "Pico de gallo", "diced", "#d23b2b", "#6aa33a", "Pico de gallo", "fresh salsa"],
    ["house_beans", "House beans", "beans", "#2a2220", "#4a3a34", "House beans", "black beans"],
    ["refried_beans", "Refried beans", "dollop", "#6b3a20", "#8a5434", "Refried beans"],
    ["mexican_rice", "Mexican rice", "grains", "#e0803e", "#f3a85a", "Mexican rice", "spanish"],
    ["lime_rice", "Coriander-lime rice", "grains", "#f4f1e4", "#8fbf5a", "Coriander lime rice", "cilantro"],
    ["chicken_pastor", "Chicken pastor", "chunks", "#b4552a", "#d98a3c", "Chicken pastor", "al pastor"],
    ["birria", "Birria beef", "chunks", "#7a2a14", "#a8421f", "Birria beef", "consome"],
    ["carne_asada", "Carne asada", "strips", "#6b3a20", "#9a5a30", "Carne asada", "steak"],
    ["chipotle_chicken", "Chipotle chicken", "chunks", "#b9531f", "#e0803e", "Chipotle chicken"],
    ["cauliflower_bites", "Cauliflower bites", "nuggets", "#d8a24a", "#f2c46a", "Cauliflower bites", "vegan crispy"],
    ["tortilla_chips", "Tortilla chips", "chips", "#e8b05a", "#f3cf7a", "Tortilla chips", "nachos"],
    ["taco_shell", "Hard taco shell", "taco", "#e8b05a", "#c9862f", "Taco shell", "crunchy"],
    ["jalapeno_poppers", "Jalapeño poppers", "nuggets", "#e8a032", "#f6c45a", "Jalapeño poppers"],
    ["taquitos", "Taquitos", "sticks", "#c98a3a", "#e8b062", "Taquitos", "rolled"],
    ["quesadilla", "Quesadilla", "wedge", "#e8c25a", "#f6b928", "Quesadilla"],
  ]),
  ...build("pizza", [
    ["pizza_dough", "Pizza dough", "pizza_base", "#f0d29a", "#f0d29a", "Dough base", "stretched"],
    ["tomato_base", "Tomato base", "pizza_base", "#e8c07a", "#c62f20", "Tomato sauce base", "pizza sauce marinara"],
    ["bbq_base", "BBQ base", "pizza_base", "#e8c07a", "#4a2516", "BBQ base"],
    ["garlic_base", "Garlic butter base", "pizza_base", "#e8c07a", "#f3d77a", "Garlic base", "white"],
    ["cream_base", "White / cream base", "pizza_base", "#e8c07a", "#f6f1e0", "Cream base", "bianca"],
    ["pizza_mozzarella", "Pizza mozzarella", "shreds", "#f8f3e3", "#e8dfc4", "Mozzarella", "cheese"],
    ["sausage_slices", "Sausage slices", "slices", "#a0522d", "#c9744a", "Sausage", "italian"],
    ["spicy_beef", "Spicy beef", "crumbs", "#7a3a1a", "#b0401f", "Spicy beef", "mince"],
    ["pizza_chicken", "Chicken pieces", "chunks", "#e0b070", "#c98a3a", "Chicken", "tikka pieces"],
    ["anchovies", "Anchovies", "strips", "#8a7a6a", "#b0a08a", "Anchovies"],
    ["garlic", "Garlic", "crumbs", "#f6f1e0", "#e0d7b8", "Garlic", "chopped"],
    ["oregano", "Oregano", "crumbs", "#6b8a2a", "#8aa64a", "Oregano"],
    ["chilli_flakes", "Chilli flakes", "crumbs", "#c62f20", "#e8682a", "Chilli flakes"],
    ["pizza_slice", "Pizza slice", "wedge", "#f0c050", "#d7261e", "Slice"],
    ["calzone", "Calzone fold", "taco", "#e8b866", "#c98a3f", "Fold & seal", "folded"],
  ]),
  ...build("grill", [
    ["doner", "Lamb doner", "strips", "#8a5434", "#b9835a", "Lamb doner", "donner kebab gyros meat"],
    ["chicken_doner", "Chicken doner", "strips", "#d7a462", "#b17a3c", "Chicken doner", "donner shawarma gyros"],
    ["shawarma", "Shawarma", "strips", "#c98a4a", "#8a5a2a", "Shawarma"],
    ["lamb_shish", "Lamb shish", "chunks", "#7a4026", "#a8603a", "Lamb shish", "kebab cubes"],
    ["chicken_shish", "Chicken shish", "chunks", "#e0a050", "#b9742a", "Chicken shish", "kebab cubes"],
    ["kofte", "Kofte", "sticks", "#6b3a20", "#8a5434", "Kofte", "kofta lamb chicken"],
    ["chicken_tikka", "Chicken tikka", "chunks", "#d3552a", "#f08a4a", "Chicken tikka"],
    ["lamb_chops", "Lamb chops", "slab", "#7a3a20", "#f3e3c8", "Lamb chops"],
    ["quarter_chicken", "Quarter chicken", "wings", "#c9742a", "#a84a1a", "1/4 chicken", "peri grilled leg"],
    ["skewer", "Skewer", "sticks", "#d9b98a", "#a8742a", "Skewer", "stick"],
    ["rice", "Rice", "grains", "#f6f3ea", "#e3dccb", "Rice", "basmati plain white"],
    ["pilau_rice", "Pilau rice", "grains", "#f2c94a", "#e8a032", "Pilau rice", "yellow"],
  ]),
  ...build("sides", [
    ["fries", "Fries", "sticks", "#f4c142", "#f9dd7a", "Fries", "chips classic skin on"],
    ["curly_fries", "Curly fries", "curly", "#e8a032", "#f6c45a", "Curly fries"],
    ["sweet_potato_fries", "Sweet potato fries", "sticks", "#e8732a", "#f4a060", "Sweet potato fries"],
    ["wedges", "Potato wedges", "chunks", "#d99a3a", "#f2c46a", "Wedges"],
    ["tots", "Tater tots", "balls", "#d99a3a", "#f2c46a", "Tots", "potato"],
    ["onion_rings", "Onion rings", "legacy", "#c9852f", "#eab45c", "Onion rings"],
    ["mozzarella_sticks", "Mozzarella sticks", "sticks", "#e7a64a", "#f6d28a", "Mozzarella sticks"],
    ["mac_cheese", "Mac & cheese", "dollop", "#f6c44a", "#e8a032", "Mac & cheese", "croquettes"],
    ["chilli_cheese_bites", "Chilli cheese bites", "nuggets", "#e8a032", "#f6c45a", "Chilli cheese bites"],
    ["loaded_topping", "Loaded fries topping", "dollop", "#f6b928", "#d7261e", "Loaded toppings"],
  ]),
  ...build("breakfast", [
    ["hash_brown", "Hash brown", "slab", "#d99a3a", "#f2c46a", "Hash brown"],
    ["baked_beans", "Baked beans", "beans", "#d2552a", "#f08a4a", "Beans", "heinz"],
    ["scrambled_egg", "Scrambled egg", "shreds", "#f6d34a", "#fbe58a", "Scrambled egg"],
    ["black_pudding", "Black pudding", "slices", "#2a1410", "#4a2418", "Black pudding"],
    ["pancakes", "Pancakes", "slab", "#e9b56a", "#c98a3a", "Pancakes"],
    ["waffle", "Waffle", "slab", "#e8b062", "#c98a3a", "Waffle"],
    ["croissant", "Croissant", "wings", "#e8a640", "#c9822a", "Croissant"],
    ["grilled_tomato", "Grilled tomato", "slices", "#c62f20", "#e86a4a", "Grilled tomato"],
  ]),
  ...build("desserts", [
    ["churros", "Churros", "sticks", "#c98a3a", "#e8b062", "Churros", "cinnamon sugar"],
    ["brownie", "Brownie", "slab", "#3b1f14", "#5a3420", "Brownie"],
    ["cheesecake", "Cheesecake", "wedge", "#f7e7c0", "#c9a36a", "Cheesecake"],
    ["brownie_cheesecake", "Brownie cheesecake", "wedge", "#f3e3b8", "#3b1f14", "Brownie cheesecake"],
    ["cookie", "Cookie", "slices", "#c98a3a", "#5a3420", "Cookie", "choc chip"],
    ["ice_cream", "Ice cream scoop", "balls", "#f7efe0", "#f6c4d0", "Ice cream", "vanilla"],
    ["whipped_cream", "Whipped cream", "dollop", "#ffffff", "#efe9dc", "Whipped cream"],
    ["choc_sauce", "Chocolate sauce", "drizzle", "#3b1f14", "#3b1f14", "Choc sauce", "chocolate nutella"],
    ["caramel", "Caramel sauce", "drizzle", "#c27b2a", "#c27b2a", "Caramel", "toffee"],
    ["white_choc", "White chocolate", "drizzle", "#f3ead8", "#f3ead8", "White choc"],
    ["biscoff_spread", "Biscoff spread", "dollop", "#b06a2c", "#c98a3a", "Biscoff", "lotus"],
    ["biscoff_crumb", "Biscoff crumb", "crumbs", "#b06a2c", "#d9a05b", "Lotus crumbs", "biscoff"],
    ["oreo_crumb", "Oreo crumb", "crumbs", "#2a2220", "#f3ead8", "Oreo crumbs"],
    ["sprinkles", "Sprinkles", "crumbs", "#e0457a", "#3fa9e0", "Sprinkles"],
    ["strawberries", "Strawberries", "balls", "#d7261e", "#f26a5a", "Strawberries"],
    ["banana", "Banana slices", "slices", "#f6e7a0", "#e8d070", "Banana"],
    ["cinnamon_sugar", "Cinnamon sugar", "crumbs", "#c98a3a", "#f3e3b3", "Cinnamon sugar"],
  ]),
  ...build("seasoning", [
    ["salt", "Salt", "crumbs", "#ffffff", "#e3e3e3", "Salt"],
    ["chicken_salt", "Chicken salt", "crumbs", "#e8a032", "#f6c45a", "Chicken salt"],
    ["red_salt", "American red salt", "crumbs", "#c94a2a", "#e8732a", "Red salt", "american"],
    ["peri_salt", "Peri salt", "crumbs", "#d9531f", "#f08a4a", "Peri salt"],
    ["cajun", "Cajun / bayou spice", "crumbs", "#b9531f", "#d9822a", "Cajun spice", "bayou"],
    ["paprika", "Paprika", "crumbs", "#c0401f", "#e0603a", "Paprika"],
    ["black_pepper", "Black pepper", "crumbs", "#2a2a2a", "#555555", "Black pepper"],
    ["sesame", "Sesame seeds", "grains", "#f3e3b3", "#e0c98a", "Sesame seeds"],
    ["dried_herbs", "Dried herbs", "crumbs", "#6b8a2a", "#9aa64a", "Herbs", "mixed oregano"],
  ]),
  ...build("packaging", [
    ["clamshell", "Clamshell", "box_clam", "#f4f1ea", "#d9d4c6", "Clamshell", "foam polystyrene box"],
    ["kraft_clamshell", "Kraft clamshell", "box_clam", "#c9a06a", "#a8804a", "Kraft box", "cardboard"],
    ["burger_box", "Burger box", "box_burger", "#c9a06a", "#a8804a", "Burger box", "kraft"],
    ["pizza_box", "Pizza box", "box_pizza", "#d8b98a", "#b08a5a", "Pizza box"],
    ["tin_foil", "Tin foil", "foil", "#c9ccd1", "#eef0f2", "Tin foil", "wrap"],
    ["foil_tray", "Foil container", "foil", "#b9bec5", "#e2e5e8", "Foil tray", "aluminium"],
    ["taco_tray", "Taco tray", "tray_taco", "#c9a06a", "#a8804a", "Taco tray"],
    ["bowl", "Bowl", "bowl", "#c9a06a", "#a8804a", "Bowl", "kraft salad"],
    ["clear_bowl", "Clear bowl + lid", "bowl", "#e8eef2", "#c5d0d8", "Bowl", "plastic"],
    ["pot_4oz", "4oz pot", "pot", "#eef3f6", "#c5d0d8", "4oz pot", "dip sauce"],
    ["pot_2oz", "2oz dip pot", "pot", "#eef3f6", "#c5d0d8", "2oz pot", "sauce dip"],
    ["cup", "Drink cup", "cup", "#ffffff", "#d7261e", "Cup", "milkshake"],
    ["can", "Drink can", "can", "#d7261e", "#e3e3e3", "Can", "coke soft drink"],
    ["paper_bag", "Paper bag", "bag", "#c9a06a", "#a8804a", "Paper bag", "carrier kraft"],
    ["chip_cone", "Chip cone", "cone", "#f4f1ea", "#d7261e", "Chip cone", "fries scoop"],
    ["greaseproof", "Greaseproof paper", "paper", "#f4ecd6", "#d7261e", "Greaseproof paper", "wrap checked"],
    ["burger_wrap", "Burger wrap paper", "paper", "#f7f3e8", "#d9b98a", "Wrap paper"],
    ["napkin", "Napkin", "paper", "#ffffff", "#e3e3e3", "Napkin"],
    ["cutlery", "Wooden cutlery", "sticks", "#d9b98a", "#b9945a", "Cutlery", "fork"],
    ["sticker", "Seal sticker", "paper", "#ffffff", "#e0457a", "Seal sticker", "label"],
  ]),
  ...build("other", [["custom", "Own photo", "legacy", "#f4f4f5", "#d4d4d8", "", "upload picture"]]),
];

/** Cross-listing so each cuisine tab holds everything its kitchen uses. */
const ALSO_IN: Partial<Record<IngredientCategory, string[]>> = {
  pizza: [
    "salami", "diced_chicken", "pulled_chicken", "diced_chicken_tikka",
    "tandoori_chicken", "diced_tandoori", "doner_meat", "bolognese",
    "pepperoni", "ham", "turkey_bacon", "bacon", "meatballs", "mince", "tuna", "prawns", "grilled_chicken",
    "chicken_tikka", "doner", "mushrooms", "sliced_onion", "red_onion", "onions", "green_peppers", "red_peppers",
    "house_peppers", "sweetcorn", "pineapple", "black_olives", "green_olives", "jalapeno", "chillies",
    "cherry_tomatoes", "tomato", "diced_tomato", "spinach", "rocket", "basil", "feta", "goats_cheese", "parmesan",
    "blue_cheese", "halloumi", "bbq_sauce", "garlic_mayo", "hot_honey", "pesto", "balsamic", "garlic_butter",
    "pizza_box", "greaseproof", "pot_2oz",
  ],
  mexican: [
    "pulled_chicken", "diced_chicken",
    "tortilla_12", "tortilla_6", "corn_tortilla", "burrito_wrap", "cheese_sauce", "grated_cheese", "pickled_onions",
    "coriander", "jalapeno", "house_peppers", "pulled_beef", "chipotle_mayo", "hot_sauce", "lime_wedge",
    "shredded_lettuce", "sweetcorn", "choc_sauce", "churros", "brownie_cheesecake", "cinnamon_sugar",
    "clamshell", "tin_foil", "taco_tray", "bowl", "pot_4oz",
  ],
  grill: [
    "doner_meat", "diced_chicken", "diced_chicken_tikka", "tandoori_chicken", "diced_tandoori",
    "naan", "pitta", "wrap", "flatbread", "halloumi", "falafel", "wings", "bbq_wings", "drumsticks", "grilled_chicken",
    "steak", "salad_mix", "shredded_lettuce", "red_cabbage", "white_cabbage", "sliced_onion", "red_onion",
    "tomato", "cucumber", "chillies", "lemon_wedge", "garlic_sauce", "chilli_sauce", "gyros_sauce", "tzatziki",
    "hummus", "raita", "peri_mild", "peri_hot", "lemon_herb", "fries", "foil_tray", "tin_foil", "clamshell",
  ],
  sides: ["chicken_tenders", "nuggets", "popcorn_chicken", "jalapeno_poppers", "cauliflower_bites", "coleslaw", "tortilla_chips", "chip_cone", "pot_2oz"],
  breakfast: ["egg", "bacon", "turkey_bacon", "sausage", "mushrooms", "toast", "tomato", "cheese", "hot_dog_bun"],
  desserts: ["churros", "whipped_cream"],
  meat: [
    "doner", "chicken_doner", "shawarma", "lamb_shish", "chicken_shish", "kofte",
    "quarter_chicken", "lamb_chops", "spicy_beef", "sausage_slices", "chicken_pastor",
    "birria", "carne_asada", "chipotle_chicken",
  ],
};
for (const [cat, keys] of Object.entries(ALSO_IN) as Array<[IngredientCategory, string[]]>) {
  for (const k of keys) {
    const ing = ASSEMBLY_INGREDIENTS.find((i) => i.key === k);
    if (ing && ing.category !== cat) (ing.alsoIn ??= []).push(cat);
  }
}

const BY_KEY = new Map(ASSEMBLY_INGREDIENTS.map((i) => [i.key, i]));

export function assemblyIngredient(key: string | null | undefined): AssemblyIngredient | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

export function isAssemblyIngredientKey(key: unknown): key is string {
  return typeof key === "string" && BY_KEY.has(key);
}

/** Case-insensitive search over name, aliases and category name. */
export function searchAssemblyIngredients(
  query: string,
  category?: IngredientCategory | "all",
): AssemblyIngredient[] {
  const q = query.trim().toLowerCase();
  const catName = new Map(INGREDIENT_CATEGORIES.map((c) => [c.id, c.name.toLowerCase()]));
  return ASSEMBLY_INGREDIENTS.filter((i) => {
    if (category && category !== "all" && i.category !== category && !i.alsoIn?.includes(category)) return false;
    if (!q) return true;
    const hay = `${i.name} ${i.aliases ?? ""} ${catName.get(i.category) ?? ""}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}
