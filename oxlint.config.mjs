export default {
  env: {
    node: true,
    es2022: true,
  },
  plugins: ["typescript", "unicorn", "oxc"],
  ignorePatterns: [
    "dist/**",
    "node_modules/**",
    "esbuild.js",
    ".agents/**",
    ".gemini/**",
  ],
  rules: {
    "no-unused-vars": "error",
    "no-undef": "error",
    "no-constant-condition": "error",
    "no-debugger": "error",
    "no-empty": "error",
    "no-unreachable": "error",
    "eqeqeq": "error",
  },
};
