import { Mastra } from '@mastra/core';
import { kintoneFetchTool } from './tools/kintone-fetch-tool';

export const mastra = new Mastra({
  name: 'wit-factoring',
  tools: {
    kintoneFetchTool,
  },
});
