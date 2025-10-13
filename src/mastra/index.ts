import { Mastra } from '@mastra/core';
import { integratedWorkflow } from './workflows/integrated-workflow';
import { createWorkflow } from '@mastra/core/workflows';
import { phase1PurchaseCollateralStep } from './workflows/phase1-purchase-collateral-step';
import { phase2BankStatementStep } from './workflows/phase2-bank-statement-step';
import { phase3VerificationStep } from './workflows/phase3-verification-step';

// 各フェーズを個別のワークフローとして作成
const phase1Workflow = createWorkflow({
  id: 'phase1-purchase-collateral',
  description: 'Phase 1: 買取請求書と担保謄本の処理（OCR → 買取検証 → 担保検証）',
  inputSchema: phase1PurchaseCollateralStep.inputSchema,
  outputSchema: phase1PurchaseCollateralStep.outputSchema,
})
  .then(phase1PurchaseCollateralStep)
  .commit();

const phase2Workflow = createWorkflow({
  id: 'phase2-bank-statement',
  description: 'Phase 2: 通帳分析（OCR → AI分析・照合 → リスク検出）',
  inputSchema: phase2BankStatementStep.inputSchema,
  outputSchema: phase2BankStatementStep.outputSchema,
})
  .then(phase2BankStatementStep)
  .commit();

const phase3Workflow = createWorkflow({
  id: 'phase3-verification',
  description: 'Phase 3: 本人確認・企業実在性確認（本人確認OCR → エゴサーチ → 企業検証 → 代表者リスク検索）',
  inputSchema: phase3VerificationStep.inputSchema,
  outputSchema: phase3VerificationStep.outputSchema,
})
  .then(phase3VerificationStep)
  .commit();

export const mastra = new Mastra({
  workflows: {
    integratedWorkflow,
    phase1Workflow,
    phase2Workflow,
    phase3Workflow,
  },
});
