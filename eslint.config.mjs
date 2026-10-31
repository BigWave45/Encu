import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextVitals,
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts"]
  }
];

export default eslintConfig;
