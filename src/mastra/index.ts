import { Mastra } from '@mastra/core/mastra';
import { integratedWorkflow } from './workflows/integrated-workflow';

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { phase3VerificationStep } from './workflows/phase3-verification-step';
import { googleVisionPurchaseCollateralOcrTool } from './tools/google-vision-purchase-collateral-ocr-tool';
import { googleVisionBankStatementOcrToolImproved } from './tools/google-vision-bank-statement-ocr-tool-improved';
import { RuntimeContext } from '@mastra/core/runtime-context';

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

// OCR文書分類テスト用ワークフロー
const ocrTestStep = createStep({
  id: 'ocr-test',
  description: 'OCR文書分類ツールの精度確認',

  inputSchema: z.object({
    recordId: z.string().describe('KintoneレコードID'),
  }),

  outputSchema: z.object({
    recordId: z.string(),
    ocrResults: z.object({
      purchaseDocuments: z.array(z.any()),
      collateralDocuments: z.array(z.any()),
      processingDetails: z.any(),
      costAnalysis: z.any(),
    }),
  }),

  execute: async ({ inputData }) => {
    const { recordId } = inputData;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`🔍 OCR文書分類テスト - recordId: ${recordId}`);
    console.log(`${"=".repeat(80)}\n`);

    const ocrResult = await googleVisionPurchaseCollateralOcrTool.execute!({
      context: {
        recordId,
        purchaseFieldName: "成因証書＿添付ファイル",
        collateralFieldName: "担保情報＿添付ファイル",
        maxPagesPerFile: 20,
      },
      runtimeContext: new RuntimeContext(),
    });

    console.log(`\n━━━ OCR結果詳細 ━━━`);
    console.log(`\n【買取書類】 ${ocrResult.purchaseDocuments.length}件`);
    ocrResult.purchaseDocuments.forEach((doc: any, idx: number) => {
      console.log(`\n--- 書類 ${idx + 1}: ${doc.fileName} ---`);
      console.log(`文書種別: ${doc.documentType}`);
      console.log(`ページ数: ${doc.pageCount}`);
      console.log(`\n抽出された事実情報:`);
      console.log(JSON.stringify(doc.extractedFacts, null, 2));
      console.log(`\nOCRテキスト（最初の500文字）:`);
      console.log(doc.text.substring(0, 500));
      console.log(`...（全${doc.text.length}文字）`);
    });

    console.log(`\n【担保書類】 ${ocrResult.collateralDocuments.length}件`);
    ocrResult.collateralDocuments.forEach((doc: any, idx: number) => {
      console.log(`\n--- 書類 ${idx + 1}: ${doc.fileName} ---`);
      console.log(`文書種別: ${doc.documentType}`);
      console.log(`ページ数: ${doc.pageCount}`);
      console.log(`\n抽出された事実情報:`);
      console.log(JSON.stringify(doc.extractedFacts, null, 2));
      console.log(`\nOCRテキスト（最初の500文字）:`);
      console.log(doc.text.substring(0, 500));
      console.log(`...（全${doc.text.length}文字）`);
    });

    console.log(`\n━━━ コスト分析 ━━━`);
    console.log(`Google Vision API: $${ocrResult.costAnalysis.googleVisionCost.toFixed(4)}`);
    console.log(`AI分類コスト: $${ocrResult.costAnalysis.classificationCost.toFixed(4)}`);
    console.log(`総コスト: $${(ocrResult.costAnalysis.googleVisionCost + ocrResult.costAnalysis.classificationCost).toFixed(4)}`);

    console.log(`\n${"=".repeat(80)}`);
    console.log(`✅ OCR文書分類テスト完了`);
    console.log(`${"=".repeat(80)}\n`);

    return {
      recordId,
      ocrResults: {
        purchaseDocuments: ocrResult.purchaseDocuments,
        collateralDocuments: ocrResult.collateralDocuments,
        processingDetails: ocrResult.processingDetails,
        costAnalysis: ocrResult.costAnalysis,
      },
    };
  },
});

const ocrTestWorkflow = createWorkflow({
  id: 'ocr-test-workflow',
  description: 'OCR文書分類ツールの精度を確認するテスト用ワークフロー',
  inputSchema: z.object({
    recordId: z.string(),
  }),
  outputSchema: z.any(),
})
  .then(ocrTestStep)
  .commit();

// 通帳OCRテスト用ステップ
const bankStatementOcrTestStep = createStep({
  id: 'bank-statement-ocr-test',
  description: '通帳OCRの生テキストを確認するテスト',

  inputSchema: z.object({
    recordId: z.string().describe('KintoneレコードID'),
  }),

  outputSchema: z.object({
    recordId: z.string(),
    success: z.boolean(),
    mainBankDocuments: z.array(z.object({
      fileName: z.string(),
      text: z.string(),
      pageCount: z.number(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ inputData }) => {
    const { recordId } = inputData;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`🏦 通帳OCRテスト - recordId: ${recordId}`);
    console.log(`${"=".repeat(80)}\n`);

    const ocrResult = await googleVisionBankStatementOcrToolImproved.execute!({
      context: {
        recordId,
        mainBankFieldName: 'メイン通帳＿添付ファイル',
        subBankFieldName: '',
        maxPagesPerFile: 100,
      },
      runtimeContext: new RuntimeContext(),
    });

    console.log(`\n📄 OCR結果:`);
    console.log(`  - 成功: ${ocrResult.success}`);
    console.log(`  - ファイル数: ${ocrResult.mainBankDocuments.length}`);

    // 各ファイルのOCRテキストを表示
    ocrResult.mainBankDocuments.forEach((doc, idx) => {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`📑 ファイル ${idx + 1}: ${doc.fileName}`);
      console.log(`   ページ数: ${doc.pageCount}`);
      console.log(`   文字数: ${doc.text.length}`);
      console.log(`${"─".repeat(60)}`);
      console.log(`【OCRテキスト（生データ）】`);
      console.log(doc.text);
      console.log(`${"─".repeat(60)}\n`);
    });

    console.log(`\n✅ 通帳OCRテスト完了`);
    console.log(`${"=".repeat(80)}\n`);

    return {
      recordId,
      success: ocrResult.success,
      mainBankDocuments: ocrResult.mainBankDocuments.map(doc => ({
        fileName: doc.fileName,
        text: doc.text,
        pageCount: doc.pageCount,
      })),
      error: ocrResult.error,
    };
  },
});

// 通帳OCRテスト用ワークフロー
const bankStatementOcrTestWorkflow = createWorkflow({
  id: 'bank-statement-ocr-test-workflow',
  description: '通帳OCRの生テキストを確認するテスト用ワークフロー',
  inputSchema: z.object({
    recordId: z.string(),
  }),
  outputSchema: z.any(),
})
  .then(bankStatementOcrTestStep)
  .commit();

export const mastra = new Mastra({
  workflows: {
    integratedWorkflow,
    phase3VerificationWorkflow,
    ocrTestWorkflow,
    bankStatementOcrTestWorkflow,
  },
});