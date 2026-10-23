import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...next,
  ...nextTs,
  {
    rules: {
      // Synchronous loading/reset state at the start of data-fetching effects is intentional here.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "next-env.d.ts"] },
];

export default config;
