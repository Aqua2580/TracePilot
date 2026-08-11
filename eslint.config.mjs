/**
 * ESLint flat config —— TracePilot workspace 共享配置。
 *
 * 设计原则：
 * - 全部 workspace 共用此根配置；子包通过 `eslint .` 向上查找自动应用。
 * - 仅启用不依赖类型信息的 recommended 规则，避免为每个子包单独配置
 *   tsconfig project；类型安全由 `pnpm typecheck`（tsc --noEmit）把关。
 * - 不对注释语言做规则约束（中文规则由 AGENTS.md §11 人工约定）。
 * - 关闭与 TypeScript 重复的 base 规则，交给 @typescript-eslint/* 接管。
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      // 交给 @typescript-eslint/no-unused-vars 接管
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      // Fastify / Pino 测试输出允许 console
      "no-console": "off",
      // 允许 ts-eslint 推断类型，避免误报 no-explicit-any
      // 仍保留该规则为 warn，提示后续收敛
      "@typescript-eslint/no-explicit-any": "warn",
      // 测试与脚本常需要 any 断言
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off"
    }
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  }
);
