import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build-tsc/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".codex/**",
      ".loopx/**",
      ".superpowers/**",
      ".trae/**",
      ".workbuddy/**",
      // 品牌迁移的分阶段验收脚本：Node 脚本里嵌 page.evaluate 的浏览器上下文回调，
      // 全局对象两边都有，静态 lint 无法分类，故整体排除（不影响产品代码）。
      ".phase-tests/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // 下划线前缀 = 有意忽略的占位（解构剔除、参数预留）。约定写进规则，不靠记忆。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 独立 Node 脚本（.mjs）不在 tseslint 覆盖内，显式声明 Node 全局，
    // 否则 no-undef 会把 process/Buffer/console 全部误报。
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
