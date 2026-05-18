/** @type {import("prettier").Config} */
module.exports = {
  semi: true,
  singleQuote: true,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindConfig: "./apps/web/tailwind.config.ts",
  overrides: [
    {
      files: "*.json",
      options: { printWidth: 200 },
    },
  ],
};
