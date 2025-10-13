import { defineConfig } from '@mastra/core';

export default defineConfig({
  // docs ディレクトリをビルドに含める
  build: {
    publicDir: 'docs',
  },
  // デプロイヤーの互換性のため設定を追加
  telemetry: {
    enabled: false,
  },
});

