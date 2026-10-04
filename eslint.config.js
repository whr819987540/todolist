import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // .claude/worktrees 里是其他分支的工作副本，不归这里检查
  globalIgnores(["dist", "src-tauri", "node_modules", ".claude"]),

  // 前端代码
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      // rules-of-hooks、exhaustive-deps，以及 React Compiler 的一组规则（refs、immutability、purity、
      // set-state-in-effect 等）。这些规则在本项目里都开着：报出来的地方逐条看过，刻意的写法和误报
      // 就地加上 disable 注释并写明原因，没有整条关掉的
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite(),
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // const { [key]: _, ...rest } = obj 这种去掉一项的写法不算没用的变量
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // 这几个文件把 Provider / 组件和配套的 hook、常量放在一起（main.tsx、quick.tsx 是入口，没有导出）：
    // 改它们时 Vite 退回整页刷新，开发时多等一下而已，不值得为热更新把它们拆开
    files: ["src/main.tsx", "src/quick.tsx", "src/settings.tsx", "src/theme.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },

  // 构建配置、打包脚本（在 Node 里跑）
  {
    files: ["*.{js,ts}", "scripts/**/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
]);
