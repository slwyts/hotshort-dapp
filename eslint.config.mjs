import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "workers/**",
    "contracts/**",
    "lib/forge-std/**",
    "script/**",
    "broadcast/**",
  ]),
  {
    // React 19 实验性规则：和 fetch-in-useEffect 这种主流模式冲突，关闭。
    //   - set-state-in-effect: useEffect 内 fetch → setState 是数据加载标准模式
    //   - purity: render 内 Date.now() 用于判断订单到期、彩票号码等时间敏感 UI
    //   迁移到 react-query/SWR 才是根本解，但工作量大，当前暂关。
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
]);
