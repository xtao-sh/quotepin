import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";

// Deliberately narrow. The point of this gate is the class of bug the codebase has actually hit —
// hooks after an early return, effects with the wrong dependencies, unused bindings left behind by a
// refactor — not stylistic opinions on 16k lines of working code.
export default [
  {
    ignores: [
      "dist/**",
      "dist-mcp/**",
      "node_modules/**",
      "release/**",
      "release-*/**",
      ".venv/**",
      "app-data/**",
      "tmp/**",
      "build/**",
      ".npm-cache/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser }
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      ...js.configs.recommended.rules,
      // Working code that predates this config should not fail the build over style.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", {
        args: "none",
        caughtErrors: "none",
        // `const { a, b, ...rest } = value` is how this codebase omits keys; the named ones are
        // deliberately unused.
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_"
      }],
      "no-control-regex": "off"
    }
  },
  {
    files: ["src/**/*.jsx", "src/**/*.js"],
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      // Without this, every component referenced only from JSX reads as an unused variable.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      // The reason this config exists: nine hooks once sat after `if (!doc) return null`, and only a
      // guard at the single call site kept it from crashing.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },
  {
    files: ["electron/*.cjs"],
    languageOptions: { sourceType: "commonjs" }
  }
];
