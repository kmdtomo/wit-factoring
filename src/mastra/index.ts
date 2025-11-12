import { Mastra } from '@mastra/core/mastra';
import { integratedWorkflow } from './workflows/integrated-workflow';

import { createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { phase3VerificationStep } from './workflows/phase3-verification-step';

const phase3VerificationWorkflow = createWorkflow({
  id: 'phase3-verification-workflow',
  description: 'Phase 3（本人確認・企業実在性）のみを単独実行します。',
  inputSchema: z.object({
    recordId: z.string(),
    phase1Results: z.any().optional(),
    phase2Results: z.any().optional(),
  }),
  outputSchema: z.any(),
})
  .then(phase3VerificationStep)
  .commit();

export const mastra = new Mastra({
  workflows: {
    integratedWorkflow,
    phase3VerificationWorkflow,
  },
});