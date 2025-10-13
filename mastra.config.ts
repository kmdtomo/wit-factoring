import { defineConfig } from '@mastra/core';

export default defineConfig({
  // docs ディレクトリをビルドに含める
  build: {
    publicDir: 'docs',
  },
});

