import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { googleVisionPurchaseCollateralOcrTool } from "../tools/google-vision-purchase-collateral-ocr-tool";
import { purchaseVerificationToolMinimal } from "../tools/purchase-verification-tool-minimal";
import { collateralVerificationTool } from "../tools/collateral-verification-tool";

/**
 * Phase 1: 買取・担保情報処理ステップ
 * エージェントを使わず、ワークフロー内でツールを直接実行
 */
export const phase1PurchaseCollateralStep = createStep({
  id: "phase1-purchase-collateral",
  description: "買取請求書と担保謄本の処理（OCR → 買取検証 → 担保検証）",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
  }),
  
  outputSchema: z.object({
    recordId: z.string(),
    phase1Results: z.object({
      purchaseDocuments: z.array(z.object({
        fileName: z.string(),
        documentType: z.string(),
        extractedFacts: z.record(z.any()),
      })),
      collateralDocuments: z.array(z.object({
        fileName: z.string(),
        documentType: z.string(),
        extractedFacts: z.record(z.any()),
      })),
      purchaseVerification: z.object({
        kintoneMatch: z.enum(["一致", "部分一致", "不一致"]).describe("買取請求書とKintone買取情報の照合結果"),
      }),
      collateralExtraction: z.object({
        findings: z.array(z.string()).describe("担保書類から抽出された重要な発見事項"),
      }),
    }),
    summary: z.object({
      processingTime: z.number(),
      totalCost: z.number(),
    }),
  }),
  
  execute: async ({ inputData }) => {
    const { recordId } = inputData;
    
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[Phase 1] 買取・担保情報処理開始 - recordId: ${recordId}`);
    console.log(`${"=".repeat(80)}\n`);
    
    try {
      // ========================================
      // ステップ1: OCR処理（ツールを直接実行）
      // ========================================
      console.log(`[Phase 1 - Step 1/3] OCR処理開始`);
      const ocrStartTime = Date.now();
      
      const ocrResult = await googleVisionPurchaseCollateralOcrTool.execute!({
        context: {
          recordId,
          purchaseFieldName: "成因証書＿添付ファイル",
          collateralFieldName: "担保情報＿添付ファイル",
          maxPagesPerFile: 20,
        },
        runtimeContext: new RuntimeContext(),
      });
      
      const ocrDuration = Date.now() - ocrStartTime;
      console.log(`[Phase 1 - Step 1/3] OCR処理完了 - 処理時間: ${ocrDuration}ms`);
      console.log(`  - 買取書類: ${ocrResult.purchaseDocuments.length}件`);
      console.log(`  - 担保書類: ${ocrResult.collateralDocuments.length}件`);
      console.log(`  - 総ページ数: ${ocrResult.processingDetails.totalPages}ページ`);
      
      // OCR結果の詳細表示（文書種別ごとに分類）
      console.log(`\n━━━ OCR抽出結果（買取情報フィールド） ━━━`);

      // 文書種別の判定を柔軟に（部分一致で判定）
      const invoiceDocuments = ocrResult.purchaseDocuments.filter((doc: any) =>
        doc.documentType?.includes("請求書") || doc.documentType?.includes("invoice")
      );
      const registrationDocuments = ocrResult.purchaseDocuments.filter((doc: any) =>
        doc.documentType?.includes("登記") || doc.documentType?.includes("registration")
      );
      const businessCardDocuments = ocrResult.purchaseDocuments.filter((doc: any) =>
        doc.documentType === "名刺" || doc.documentType === "business card"
      );
      const otherDocuments = ocrResult.purchaseDocuments.filter((doc: any) =>
        !invoiceDocuments.includes(doc) &&
        !registrationDocuments.includes(doc) &&
        !businessCardDocuments.includes(doc)
      );
      
      if (invoiceDocuments.length > 0) {
        console.log(`\n【買取請求書】${invoiceDocuments.length}件`);
        invoiceDocuments.forEach((doc: any) => {
          console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
          console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
        });
      } else {
        console.log(`\n【買取請求書】 ⚠️ ファイルなし`);
      }
      
      if (registrationDocuments.length > 0) {
        console.log(`\n【登記情報・企業資料】${registrationDocuments.length}件`);
        registrationDocuments.forEach((doc: any) => {
          console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
          console.log(`     種別: ${doc.documentType}`);
          if (doc.extractedFacts && Object.keys(doc.extractedFacts).length > 0) {
            console.log(`     抽出情報:`, JSON.stringify(doc.extractedFacts, null, 2).substring(0, 200) + "...");
          } else {
            console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
          }
        });
      }
      
      if (businessCardDocuments.length > 0) {
        console.log(`\n【名刺】${businessCardDocuments.length}件`);
        businessCardDocuments.forEach((doc: any) => {
          console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
          console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
        });
      }
      
      if (otherDocuments.length > 0) {
        console.log(`\n【その他】${otherDocuments.length}件`);
        otherDocuments.forEach((doc: any) => {
          console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
          console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
        });
      }
      
      if (ocrResult.collateralDocuments.length > 0) {
        console.log(`\n【担保謄本】${ocrResult.collateralDocuments.length}件`);
        ocrResult.collateralDocuments.forEach((doc: any) => {
          console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
          console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
        });
      } else {
        console.log(`\n【担保謄本】 ⚠️ ファイルなし`);
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      if (!ocrResult.success) {
        throw new Error(`OCR処理失敗: ${ocrResult.error}`);
      }
      
      // ========================================
      // ステップ2: 買取検証（請求書のみを渡す）
      // ========================================
      console.log(`\n[Phase 1 - Step 2/3] 買取検証開始`);
      
      // 請求書ファイルがない場合の処理
      if (invoiceDocuments.length === 0) {
        console.log(`\n━━━ 買取検証 ━━━`);
        console.log(`\n⚠️  買取請求書ファイルなし（検証スキップ）`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        throw new Error(`買取請求書ファイルが見つかりません。処理を中断します。`);
      }
      
      const purchaseStartTime = Date.now();
      
      const purchaseResult = await purchaseVerificationToolMinimal.execute!({
        context: {
          recordId,
          purchaseDocuments: invoiceDocuments, // 請求書のみを渡す
          model: "gpt-4o",
        },
        runtimeContext: new RuntimeContext(),
      });
      
      const purchaseDuration = Date.now() - purchaseStartTime;
      console.log(`[Phase 1 - Step 2/3] 買取検証完了 - 処理時間: ${purchaseDuration}ms`);
      
      // 買取検証結果の詳細表示
      console.log(`\n━━━ 買取検証 ━━━`);
      console.log(`  判定: ${purchaseResult.verificationResult}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      if (!purchaseResult.success) {
        throw new Error(`買取検証失敗: ${purchaseResult.verificationResult}`);
      }
      
      // ========================================
      // ステップ3: 担保検証（事実抽出のみ）
      // ========================================
      console.log(`\n[Phase 1 - Step 3/3] 担保検証開始`);
      const collateralStartTime = Date.now();

      const collateralResult = await collateralVerificationTool.execute!({
        context: {
          recordId,
          collateralDocuments: ocrResult.collateralDocuments,
          model: "gpt-4o",
        },
        runtimeContext: new RuntimeContext(),
      });
      
      const collateralDuration = Date.now() - collateralStartTime;
      console.log(`[Phase 1 - Step 3/3] 担保検証完了 - 処理時間: ${collateralDuration}ms`);
      
      // 担保検証結果の詳細表示
      console.log(`\n━━━ 担保検証（事実抽出） ━━━`);
      if (collateralResult.keyFindings.length > 0) {
        collateralResult.keyFindings.forEach((finding: string, index: number) => {
          console.log(`  ${index + 1}. ${finding}`);
        });
      } else {
        console.log(`  ⚠️ 担保ファイルなし`);
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      if (!collateralResult.success && ocrResult.collateralDocuments.length > 0) {
        // 担保ファイルがある場合のみエラーとする
        throw new Error(`担保検証失敗: ${collateralResult.keyFindings.join(', ')}`);
      }
      
      // ========================================
      // 結果のサマリー生成
      // ========================================
      const totalDuration = ocrDuration + purchaseDuration + collateralDuration;
      const totalCost = ocrResult.costAnalysis.googleVisionCost +
                       ocrResult.costAnalysis.classificationCost;

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Phase 1 処理完了`);
      console.log(`  処理時間: ${(totalDuration / 1000).toFixed(2)}秒`);
      console.log(`  総コスト: $${totalCost.toFixed(4)}`);
      console.log(`  照合結果: ${purchaseResult.verificationResult}`);
      console.log(`  担保発見: ${collateralResult.keyFindings.length}件`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      return {
        recordId,
        phase1Results: {
          purchaseDocuments: ocrResult.purchaseDocuments.map((doc: any) => ({
            fileName: doc.fileName,
            documentType: doc.documentType,
            extractedFacts: doc.extractedFacts,
          })),
          collateralDocuments: ocrResult.collateralDocuments.map((doc: any) => ({
            fileName: doc.fileName,
            documentType: doc.documentType,
            extractedFacts: doc.extractedFacts,
          })),
          purchaseVerification: {
            kintoneMatch: purchaseResult.verificationResult,
          },
          collateralExtraction: {
            findings: collateralResult.keyFindings,
          },
        },
        summary: {
          processingTime: totalDuration / 1000,
          totalCost,
        },
      };
      
    } catch (error: any) {
      console.error(`\n[Phase 1] エラー発生:`, error.message);
      console.error(error);
      
      throw new Error(`Phase 1 処理失敗: ${error.message}`);
    }
  },
});

