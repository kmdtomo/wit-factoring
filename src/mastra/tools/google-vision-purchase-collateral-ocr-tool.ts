import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { ImageAnnotatorClient } from '@google-cloud/vision';
import path from 'path';
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';

// 環境変数の認証ファイルパスが相対パスの場合、絶対パスに変換
// Google Cloud認証設定
let visionClient: ImageAnnotatorClient;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // JSON文字列から認証情報を読み込む（本番環境用）
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  visionClient = new ImageAnnotatorClient({ credentials });
  // GOOGLE_APPLICATION_CREDENTIALSを削除してファイルパスとして誤認識されないようにする
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
} else {
  // ファイルパスから読み込む（ローカル環境用）
  const authPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (authPath && !path.isAbsolute(authPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.cwd(), authPath);
  }
  visionClient = new ImageAnnotatorClient();
}

// 環境変数は実行時に取得するように変更
const getKintoneConfig = () => ({
  KINTONE_DOMAIN: process.env.KINTONE_DOMAIN || "",
  KINTONE_API_TOKEN: process.env.KINTONE_API_TOKEN || "",
  APP_ID: process.env.KINTONE_APP_ID || "37"
});

export const googleVisionPurchaseCollateralOcrTool = createTool({
  id: "google-vision-purchase-collateral-ocr",
  description: "買取請求書と担保謄本を一括でOCR処理するGoogle Vision APIツール",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    purchaseFieldName: z.string().describe("買取請求書のフィールド名").default("成因証書＿添付ファイル"),
    collateralFieldName: z.string().describe("担保謄本のフィールド名").default("担保情報＿添付ファイル"),
    maxPagesPerFile: z.number().describe("1ファイルあたりの最大処理ページ数").default(20),
  }).describe("Google Vision OCR処理の入力パラメータ"),
  
  outputSchema: z.object({
    success: z.boolean(),
    processingDetails: z.object({
      recordId: z.string(),
      processedFiles: z.object({
        purchase: z.number(),
        collateral: z.number(),
        total: z.number(),
      }).describe("処理されたファイル数"),
      totalPages: z.number(),
      timestamp: z.string(),
    }).describe("処理詳細情報"),
    purchaseDocuments: z.array(z.object({
      fileName: z.string().describe("ファイル名"),
      text: z.string().describe("抽出されたテキスト"),
      pageCount: z.number().describe("ページ数"),
      confidence: z.number().describe("信頼度"),
      tokenEstimate: z.number().describe("推定トークン数"),
      documentType: z.string().describe("文書種別（請求書、登記情報、債権譲渡概要、名刺など）"),
      extractedFacts: z.record(z.any()).describe("文書から抽出された事実情報（ネスト構造も可能）"),
    })).describe("買取情報フィールドのドキュメントリスト"),
    collateralDocuments: z.array(z.object({
      fileName: z.string().describe("ファイル名"),
      text: z.string().describe("抽出されたテキスト"),
      pageCount: z.number().describe("ページ数"),
      confidence: z.number().describe("信頼度"),
      tokenEstimate: z.number().describe("推定トークン数"),
      documentType: z.string().describe("文書種別（担保謄本、登記情報など）"),
      extractedFacts: z.record(z.any()).describe("文書から抽出された事実情報（ネスト構造も可能）"),
    })).describe("担保謄本ドキュメントリスト"),
    costAnalysis: z.object({
      googleVisionCost: z.number(),
      classificationCost: z.number().describe("文書分類AIコスト"),
      perDocumentType: z.object({
        purchase: z.number(),
        collateral: z.number(),
      }).describe("ドキュメントタイプ別コスト"),
      estimatedSavings: z.number(),
    }).describe("コスト分析"),
    error: z.string().optional(),
  }).describe("Google Vision OCR処理の出力結果"),
  
  execute: async ({ context }) => {
    const { recordId, purchaseFieldName, collateralFieldName, maxPagesPerFile } = context;
    const timestamp = new Date().toISOString();
    
    // 環境変数のチェック
    const { KINTONE_DOMAIN, KINTONE_API_TOKEN, APP_ID } = getKintoneConfig();
    if (!KINTONE_DOMAIN || !KINTONE_API_TOKEN) {
      throw new Error("Kintone環境変数が設定されていません");
    }
    
    try {
      // 1. KintoneからレコードIDをもとに情報を取得
      const recordUrl = `https://${KINTONE_DOMAIN}/k/v1/records.json?app=${APP_ID}&query=$id="${recordId}"`;
      
      const recordResponse = await axios.get(recordUrl, {
        headers: {
          "X-Cybozu-API-Token": KINTONE_API_TOKEN,
        },
      });
      
      if (recordResponse.data.records.length === 0) {
        return {
          success: false,
          processingDetails: {
            recordId,
            processedFiles: { purchase: 0, collateral: 0, total: 0 },
            totalPages: 0,
            timestamp,
          },
          purchaseDocuments: [],
          collateralDocuments: [],
          costAnalysis: {
            googleVisionCost: 0,
            classificationCost: 0,
            perDocumentType: { purchase: 0, collateral: 0 },
            estimatedSavings: 0,
          },
          error: "指定されたレコードIDが見つかりません。",
        };
      }
      
      const record = recordResponse.data.records[0];
      
      // 2. 買取請求書と担保謄本のファイルを取得（全ファイル処理）
      const purchaseFiles = record[purchaseFieldName]?.value || [];
      const collateralFiles = record[collateralFieldName]?.value || [];
      
      console.log(`[買取・担保OCR] 処理対象:`);
      console.log(`  - 買取情報フィールド: ${purchaseFiles.length}件`);
      console.log(`  - 担保情報フィールド: ${collateralFiles.length}件`);
      console.log(`  - 処理対象合計: ${purchaseFiles.length + collateralFiles.length}件`);
      
      if (purchaseFiles.length > 0) {
        console.log(`[買取・担保OCR] 買取情報ファイル一覧:`);
        purchaseFiles.forEach((file: any) => {
          console.log(`  - ${file.name}`);
        });
      }
      
      // ファイル処理の共通関数
      const processFiles = async (files: any[], documentType: string) => {
        const results = [];
        let totalCost = 0;
        
        for (const file of files) {
          console.log(`\n[${documentType}] 処理中: ${file.name}`);
          
          // ファイルをダウンロード
          const downloadUrl = `https://${KINTONE_DOMAIN}/k/v1/file.json?fileKey=${file.fileKey}`;
          
          const fileResponse = await axios.get(downloadUrl, {
            headers: {
              "X-Cybozu-API-Token": KINTONE_API_TOKEN,
            },
            responseType: "arraybuffer",
          });
          
          const base64Content = Buffer.from(fileResponse.data).toString("base64");
          
          // PDFと画像で処理を分ける
          const isPDF = file.contentType === 'application/pdf';
          let extractedText = "";
          let confidence = 0;
          let pageCount = 1;
          
          if (isPDF) {
            // PDFファイルの処理（5ページごとにバッチ処理、段階的処理）
            console.log(`[${documentType}] PDFを処理中...`);
            
            // まず最初に実際のページ数を確認
            let actualPageCount = 0;
            console.log(`[${documentType}] PDFのページ数を確認中...`);
            
            try {
              // 1ページ目のみで試してPDFが読めるか確認
              const testRequest = {
                requests: [{
                  inputConfig: {
                    content: base64Content,
                    mimeType: 'application/pdf',
                  },
                  features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
                  pages: [1],
                }],
              };
              
              const [testResult] = await visionClient.batchAnnotateFiles(testRequest);
              
              if (testResult.responses?.[0]?.totalPages) {
                actualPageCount = testResult.responses[0].totalPages;
                console.log(`[${documentType}] PDFの総ページ数: ${actualPageCount}ページ`);
              } else {
                // totalPagesが取得できない場合は、段階的に確認
                console.log(`[${documentType}] ページ数を段階的に確認中...`);
                for (let testPage = 1; testPage <= maxPagesPerFile; testPage += 10) {
                  try {
                    const pageTestRequest = {
                      requests: [{
                        inputConfig: {
                          content: base64Content,
                          mimeType: 'application/pdf',
                        },
                        features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
                        pages: [testPage],
                      }],
                    };
                    await visionClient.batchAnnotateFiles(pageTestRequest);
                    actualPageCount = testPage;
                  } catch (e: any) {
                    if (e.message?.includes('Invalid pages')) {
                      break;
                    }
                  }
                }
                // より正確なページ数を特定
                if (actualPageCount > 1) {
                  for (let testPage = actualPageCount - 9; testPage <= actualPageCount + 10; testPage++) {
                    if (testPage < 1) continue;
                    try {
                      const pageTestRequest = {
                        requests: [{
                          inputConfig: {
                            content: base64Content,
                            mimeType: 'application/pdf',
                          },
                          features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
                          pages: [testPage],
                        }],
                      };
                      await visionClient.batchAnnotateFiles(pageTestRequest);
                      actualPageCount = testPage;
                    } catch (e: any) {
                      if (e.message?.includes('Invalid pages')) {
                        break;
                      }
                    }
                  }
                }
              }
            } catch (error: any) {
              console.error(`[${documentType}] ページ数確認エラー:`, error.message);
              // エラーの場合はmaxPagesPerFileを使用
              actualPageCount = maxPagesPerFile;
            }
            
            // 実際のページ数とmaxPagesPerFileの小さい方を使用
            const pagesToProcess = Math.min(actualPageCount, maxPagesPerFile);
            console.log(`[${documentType}] 処理対象: ${pagesToProcess}ページ (実際: ${actualPageCount}ページ, 最大: ${maxPagesPerFile}ページ)`);
            
            const pageTexts: string[] = [];
            let totalProcessedPages = 0;
            const batchSize = 5; // Google Vision APIの制限
            const numBatches = Math.ceil(pagesToProcess / batchSize);
            let processingError: Error | null = null;
            
            // バッチ処理計画を表示
            console.log(`[${documentType}] バッチ処理計画:`);
            console.log(`  - 実際のページ数: ${actualPageCount}`);
            console.log(`  - 処理ページ数: ${pagesToProcess}`);
            console.log(`  - バッチサイズ: ${batchSize}ページ/バッチ`);
            console.log(`  - 総バッチ数: ${numBatches}`);
            
            // バッチごとに段階的に処理
            for (let batch = 0; batch < numBatches; batch++) {
              const startPage = batch * batchSize + 1;
              const endPage = Math.min(startPage + batchSize - 1, pagesToProcess);
              const pagesToProcessInBatch = Array.from(
                { length: endPage - startPage + 1 }, 
                (_, i) => startPage + i
              );
              
              console.log(`  バッチ${batch + 1}/${numBatches}: ページ${startPage}-${endPage}を処理中...`);
              
              try {
                const request = {
                  requests: [{
                    inputConfig: {
                      content: base64Content,
                      mimeType: 'application/pdf',
                    },
                    features: [
                      { type: 'DOCUMENT_TEXT_DETECTION' as const }, // fullTextAnnotation用
                      { type: 'TEXT_DETECTION' as const },          // textAnnotations用（マーカー対応）
                    ],
                    pages: pagesToProcessInBatch,
                    imageContext: { languageHints: ['ja'] }, // 日本語OCR精度向上
                  }],
                };
                
                const [result] = await visionClient.batchAnnotateFiles(request);
                
                if (result.responses?.[0]) {
                  const response = result.responses[0];
                  const pages = response.responses || [];
                  
                  // 各ページのテキストを抽出
                  const pageTextList: string[] = [];
                  pages.forEach((page: any) => {
                    const texts: string[] = [];
                    
                    // 1. fullTextAnnotation（ページ全体のテキスト）
                    if (page.fullTextAnnotation?.text) {
                      texts.push(page.fullTextAnnotation.text);
                    }
                    
                    // 2. textAnnotations（個別テキストブロック - マーカー部分も含む）
                    if (page.textAnnotations && page.textAnnotations.length > 0) {
                      const individualTexts = page.textAnnotations
                        .slice(1) // 最初の要素はページ全体なのでスキップ
                        .map((annotation: any) => annotation.description)
                        .filter((text: string) => text && text.trim().length > 0);
                      
                      const uniqueTexts = [...new Set(individualTexts)];
                      if (uniqueTexts.length > 0) {
                        texts.push('\n--- 個別検出テキスト ---\n' + uniqueTexts.join(' '));
                      }
                    }
                    
                    if (texts.length > 0) {
                      pageTextList.push(texts.join('\n'));
                    }
                  });
                  
                  const batchText = pageTextList.join('\n');
                  
                  if (batchText) {
                    pageTexts.push(batchText);
                    totalProcessedPages += pages.length;
                  }
                  
                  // 最初のバッチから信頼度を取得
                  if (batch === 0 && pages[0]?.fullTextAnnotation?.pages?.[0]) {
                    confidence = pages[0].fullTextAnnotation.pages[0].confidence || 0;
                  }
                  
                  console.log(`    - ${pages.length}ページ処理完了（fullText + 個別ブロック）`);
                }
              } catch (batchError: any) {
                // ページが存在しない場合は続行
                if (batchError.message?.includes('Invalid pages')) {
                  console.log(`    - ページ${startPage}-${endPage}は存在しません`);
                  break; // これ以降のページも存在しない可能性が高いため終了
                } else {
                  // その他のエラーの場合は、これまでの処理結果を保持して終了
                  console.error(`[${documentType}] バッチ${batch + 1}でエラー発生:`, batchError.message);
                  processingError = batchError;
                  break; // 段階的処理：エラー時点で処理を中断
                }
              }
            }
            
            // 処理結果を設定（エラーがあっても処理済みデータは保持）
            if (pageTexts.length > 0) {
              extractedText = pageTexts.join('\n');
              pageCount = totalProcessedPages;
              console.log(`[${documentType}] ${pageCount}ページの処理完了`);
              
              if (processingError) {
                // エラーがあった場合でも、処理済みページのデータは返す
                console.log(`[${documentType}] 注意: 全体の処理中にエラーが発生しましたが、${pageCount}ページ分のデータは取得できました`);
              }
            } else {
              // 1ページも処理できなかった場合
              extractedText = `PDFの処理中にエラーが発生しました: ${processingError ? processingError.message : '不明なエラー'}`;
              pageCount = 0;
            }
            
          } else {
            // 画像ファイルの処理
            try {
              const [result] = await visionClient.annotateImage({
                image: {
                  content: base64Content,
                },
                features: [
                  { type: 'DOCUMENT_TEXT_DETECTION' }, // fullTextAnnotation用
                  { type: 'TEXT_DETECTION' },          // textAnnotations用（マーカー対応）
                ],
                imageContext: { languageHints: ['ja'] }, // 日本語OCR精度向上
              });
              
              const texts: string[] = [];
              
              // 1. fullTextAnnotation（画像全体のテキスト）
              const fullTextAnnotation = result.fullTextAnnotation;
              if (fullTextAnnotation?.text) {
                texts.push(fullTextAnnotation.text);
              }
              confidence = fullTextAnnotation?.pages?.[0]?.confidence || 0;
              
              // 2. textAnnotations（個別テキストブロック - マーカー部分も含む）
              if (result.textAnnotations && result.textAnnotations.length > 0) {
                const individualTexts = result.textAnnotations
                  .slice(1) // 最初の要素は画像全体なのでスキップ
                  .map((annotation: any) => annotation.description)
                  .filter((text: string) => text && text.trim().length > 0);
                
                const uniqueTexts = [...new Set(individualTexts)];
                if (uniqueTexts.length > 0) {
                  texts.push('\n--- 個別検出テキスト ---\n' + uniqueTexts.join(' '));
                }
              }
              
              extractedText = texts.join('\n');
              
            } catch (imageError) {
              console.error(`[${documentType}] 画像処理エラー (${file.name}):`, imageError);
              extractedText = `画像の処理中にエラーが発生しました`;
            }
          }
          
          // トークン数の推定
          const japaneseChars = (extractedText.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/g) || []).length;
          const asciiChars = (extractedText.match(/[a-zA-Z0-9]/g) || []).length;
          const estimatedTokens = japaneseChars + Math.ceil(asciiChars / 4);
          
          results.push({
            fileName: file.name,
            text: extractedText,
            pageCount,
            confidence,
            tokenEstimate: estimatedTokens,
          });
          
          // コスト計算
          totalCost += 0.0015 * pageCount;
        }
        
        return { results, totalCost };
      };
      
      // 3. 文書分類と情報抽出の関数（汎用的・事実ベース）
      const classifyAndExtractInfo = async (document: any) => {
        try {
          // テキストの最初の2000文字のみを使用（コスト削減）
          const textSample = document.text.substring(0, 2000);

          // 汎用的なスキーマ：何が入っていたかの事実を記録
          const schema = z.object({
            documentType: z.string().describe("文書種別（請求書、登記情報、債権譲渡概要、名刺、契約書など、文書に記載されている内容から自由に判定）"),
            extractedFacts: z.record(z.any()).describe("抽出された事実情報（会社名、資本金、設立年月日、代表者名、請求額、期日など、文書から読み取れる情報を柔軟に記録。ネスト構造も可能）"),
          });

          const result = await generateObject({
            model: openai("gpt-4o"),
            schema,
            prompt: `以下の文書のOCRテキストを分析し、文書種別と抽出可能な情報を記録してください。

【重要】
- 文書種別は固定の選択肢ではなく、文書の内容から自由に判定してください
- 抽出された情報は、何が記載されていたかの「事実」を記録してください
- 型にはめず、存在する情報を柔軟に抽出してください
- 情報が存在しない場合は、そのフィールドを含めないでください

【OCRテキスト】
${textSample}

【抽出例】
登記情報の場合:
{
  "documentType": "登記情報",
  "extractedFacts": {
    "会社名": "株式会社〇〇",
    "資本金": 10000000,
    "設立年月日": "2020年1月1日",
    "代表者名": "山田太郎"
  }
}

債権譲渡概要の場合:
{
  "documentType": "債権譲渡概要",
  "extractedFacts": {
    "会社名": "株式会社〇〇",
    "譲渡債権額": 5000000,
    "譲渡日": "2024年12月1日",
    "状態": "閉鎖" または "現在"
  }
}

請求書の場合:
{
  "documentType": "請求書",
  "extractedFacts": {
    "請求元": "株式会社〇〇",
    "請求先": "株式会社△△",
    "請求額": 1000000,
    "支払期日": "2024年12月31日"
  }
}`,
          });

          const inputCost = (result.usage?.totalTokens || 0) * 0.000003 * 0.5;
          const outputCost = (result.usage?.totalTokens || 0) * 0.000015 * 0.5;

          return {
            documentType: result.object.documentType,
            extractedFacts: result.object.extractedFacts,
            classificationCost: inputCost + outputCost,
          };
        } catch (error) {
          console.error(`[文書分類] エラー (${document.fileName}):`, error);
          return {
            documentType: "分類不能",
            extractedFacts: {},
            classificationCost: 0,
          };
        }
      };
      
      // 4. 両方のドキュメントタイプを並列処理
      console.log("\n=== 買取情報フィールドの処理開始 ===");
      const purchaseProcessing = processFiles(purchaseFiles, "買取情報");
      
      console.log("\n=== 担保謄本の処理開始 ===");
      const collateralProcessing = processFiles(collateralFiles, "担保謄本");
      
      // 並列実行して結果を待つ
      const [purchaseResult, collateralResult] = await Promise.all([
        purchaseProcessing,
        collateralProcessing,
      ]);
      
      // 5. 買取情報ファイルと担保ファイルの文書分類と情報抽出
      console.log("\n=== 文書分類・情報抽出開始 ===");
      let totalClassificationCost = 0;

      // 買取情報ファイルの分類
      const classifiedPurchaseDocuments = await Promise.all(
        purchaseResult.results.map(async (doc) => {
          console.log(`[文書分類] ${doc.fileName} を分析中...`);
          const classification = await classifyAndExtractInfo(doc);
          totalClassificationCost += classification.classificationCost;

          console.log(`  → 種別: ${classification.documentType}`);
          if (classification.extractedFacts && Object.keys(classification.extractedFacts).length > 0) {
            console.log(`  → 抽出された情報:`, classification.extractedFacts);
          }

          return {
            ...doc,
            documentType: classification.documentType,
            extractedFacts: classification.extractedFacts,
          };
        })
      );

      // 担保ファイルの分類
      const classifiedCollateralDocuments = await Promise.all(
        collateralResult.results.map(async (doc) => {
          console.log(`[文書分類] ${doc.fileName} を分析中...`);
          const classification = await classifyAndExtractInfo(doc);
          totalClassificationCost += classification.classificationCost;

          console.log(`  → 種別: ${classification.documentType}`);
          if (classification.extractedFacts && Object.keys(classification.extractedFacts).length > 0) {
            console.log(`  → 抽出された情報:`, classification.extractedFacts);
          }

          return {
            ...doc,
            documentType: classification.documentType,
            extractedFacts: classification.extractedFacts,
          };
        })
      );
      
      // コスト分析
      const totalGoogleVisionCost = purchaseResult.totalCost + collateralResult.totalCost;
      const estimatedClaudeCost = totalGoogleVisionCost * 58.5; // 58.5倍のコスト
      const estimatedSavings = ((estimatedClaudeCost - totalGoogleVisionCost) / estimatedClaudeCost) * 100;
      
      console.log("\n[買取・担保OCR] 処理結果:");
      console.log(`  - 買取情報: ${classifiedPurchaseDocuments.length}件処理`);
      console.log(`  - 担保謄本: ${collateralResult.results.length}件処理`);
      console.log(`  - OCRコスト: $${totalGoogleVisionCost.toFixed(4)}`);
      console.log(`  - 分類コスト: $${totalClassificationCost.toFixed(4)}`);
      console.log(`  - 総コスト: $${(totalGoogleVisionCost + totalClassificationCost).toFixed(4)}`);
      
      return {
        success: true,
        processingDetails: {
          recordId,
          processedFiles: {
            purchase: classifiedPurchaseDocuments.length,
            collateral: classifiedCollateralDocuments.length,
            total: classifiedPurchaseDocuments.length + classifiedCollateralDocuments.length,
          },
          totalPages: classifiedPurchaseDocuments.reduce((sum, doc) => sum + doc.pageCount, 0) +
                      classifiedCollateralDocuments.reduce((sum, doc) => sum + doc.pageCount, 0),
          timestamp,
        },
        purchaseDocuments: classifiedPurchaseDocuments,
        collateralDocuments: classifiedCollateralDocuments,
        costAnalysis: {
          googleVisionCost: totalGoogleVisionCost,
          classificationCost: totalClassificationCost,
          perDocumentType: {
            purchase: purchaseResult.totalCost,
            collateral: collateralResult.totalCost,
          },
          estimatedSavings: Math.round(estimatedSavings),
        },
      };
      
    } catch (error: any) {
      console.error("[買取・担保OCR] エラー:", error);
      
      return {
        success: false,
        processingDetails: {
          recordId,
          processedFiles: { purchase: 0, collateral: 0, total: 0 },
          totalPages: 0,
          timestamp,
        },
        purchaseDocuments: [],
        collateralDocuments: [],
        costAnalysis: {
          googleVisionCost: 0,
          classificationCost: 0,
          perDocumentType: { purchase: 0, collateral: 0 },
          estimatedSavings: 0,
        },
        error: `処理中にエラーが発生しました: ${error.message}`,
      };
    }
  },
});