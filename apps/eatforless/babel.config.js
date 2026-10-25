module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          alias: {
            "@": "./src",
            // Menu pricing and the nested-modifier tree, shared with the web
            // storefront and the API so the app prices a basket exactly as the
            // server re-prices it. Pure TypeScript, no Node or DOM globals.
            "@shared": "../../packages/shared/src/lib",
          },
        },
      ],
      // Listed explicitly: babel-preset-expo's auto-detection didn't pick it
      // up here (the app sits outside the workspace), and without it every
      // Reanimated worklet fails at runtime. Must stay last.
      "react-native-worklets/plugin",
    ],
  };
};
