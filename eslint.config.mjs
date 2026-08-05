import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // 写操作唯一入口约束：IPC 层与业务模块禁止直接引用 node:fs，
    // 统一走 src/main/core/fs-ops.mjs（只读扫描 core/scanner.mjs 除外）
    files: ['src/main/index.ts', 'src/main/ipc/**/*.{ts,mjs}', 'src/main/modules/**/*.{ts,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: '文件写操作请统一经过 core/fs-ops.mjs' },
            { name: 'node:fs', message: '文件写操作请统一经过 core/fs-ops.mjs' },
            { name: 'fs/promises', message: '文件写操作请统一经过 core/fs-ops.mjs' },
            { name: 'node:fs/promises', message: '文件写操作请统一经过 core/fs-ops.mjs' }
          ]
        }
      ]
    }
  },
  {
    // 纯 JS 测试与脚本不要求显式返回类型
    files: ['test/**/*.mjs', '**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
