import { Mastra } from '@mastra/core';
import { kintoneFetchTool } from './tools/kintone-fetch-tool';
// Google Vision APIツールはREST API経由で呼び出すため@grpc/grpc-js不要
import { googleVisionPurchaseCollateralOcrTool } from './tools/google-vision-purchase-collateral-ocr-tool';
import { purchaseVerificationToolMinimal } from './tools/purchase-verification-tool-minimal';
import { collateralVerificationTool } from './tools/collateral-verification-tool';
import { googleVisionBankStatementOcrToolImproved } from './tools/google-vision-bank-statement-ocr-tool-improved';
import { googleVisionIdentityOcrTool } from './tools/google-vision-identity-ocr-tool';
import { identityVerificationTool } from './tools/identity-verification-tool';
import { egoSearchTool } from './tools/ego-search-tool';
import { companyVerifyBatchTool } from './tools/company-verify-batch-tool';
import { kintonePhase4DataTool } from './tools/kintone-phase4-data-tool';
import { integratedWorkflow } from './workflows/integrated-workflow';

export const mastra = new Mastra({
  name: 'wit-factoring',
  tools: {
    kintoneFetchTool,
    googleVisionPurchaseCollateralOcrTool,
    purchaseVerificationToolMinimal,
    collateralVerificationTool,
    googleVisionBankStatementOcrToolImproved,
    googleVisionIdentityOcrTool,
    identityVerificationTool,
    egoSearchTool,
    companyVerifyBatchTool,
    kintonePhase4DataTool,
  },
  workflows: {
    integratedWorkflow,
  },
});
