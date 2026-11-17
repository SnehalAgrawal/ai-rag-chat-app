import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "models/", "data/", "results/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
