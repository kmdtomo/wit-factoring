import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { ImageAnnotatorClient } from '@google-cloud/vision';
import path from 'path';

// Google Cloud認証設定
let visionClient: ImageAnnotatorClient;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // JSON文字列から認証情報を読み込む（本番環境用）
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  visionClient = new ImageAnnotatorClient({ credentials });
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

/**
 * 改善版: textAnnotations を併用してマーカー付きテキストも検出
 */
export const googleVisionBankStatementOcrToolImproved = createTool({
  id: "google-vision-bank-statement-ocr-improved",
  description: "メイン通帳とサブ通帳を一括でOCR処理（textAnnotations併用でマーカー付きテキストも検出）",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    mainBankFieldName: z.string().describe("メイン通帳のフィールド名").default("メイン通帳＿添付ファイル"),
    subBankFieldName: z.string().describe("サブ通帳のフィールド名").default("その他通帳＿添付ファイル"),
    maxPagesPerFile: z.number().describe("1ファイルあたりの最大処理ページ数").default(50),
  }).describe("Google Vision OCR処理の入力パラメータ"),
  
  outputSchema: z.object({
    success: z.boolean(),
    processingDetails: z.object({
      recordId: z.string(),
      processedFiles: z.object({
        mainBank: z.number(),
        subBank: z.number(),
        total: z.number(),
      }).describe("処理されたファイル数"),
      totalPages: z.number(),
      timestamp: z.string(),
    }).describe("処理詳細情報"),
    mainBankDocuments: z.array(z.object({
      fileName: z.string().describe("ファイル名"),
      text: z.string().describe("抽出されたテキスト"),
      pageCount: z.number().describe("ページ数"),
      confidence: z.number().describe("信頼度"),
      tokenEstimate: z.number().describe("推定トークン数"),
    })).describe("メイン通帳ドキュメントリスト"),
    subBankDocuments: z.array(z.object({
      fileName: z.string().describe("ファイル名"),
      text: z.string().describe("抽出されたテキスト"),
      pageCount: z.number().describe("ページ数"),
      confidence: z.number().describe("信頼度"),
      tokenEstimate: z.number().describe("推定トークン数"),
    })).describe("サブ通帳ドキュメントリスト"),
    costAnalysis: z.object({
      googleVisionCost: z.number(),
      perDocumentType: z.object({
        mainBank: z.number(),
        subBank: z.number(),
      }).describe("ドキュメントタイプ別コスト"),
      estimatedSavings: z.number(),
    }).describe("コスト分析"),
    error: z.string().optional(),
  }).describe("Google Vision OCR処理の出力結果"),
  
  execute: async ({ context }) => {
    const { recordId, mainBankFieldName, subBankFieldName, maxPagesPerFile } = context;
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
            processedFiles: { mainBank: 0, subBank: 0, total: 0 },
            totalPages: 0,
            timestamp,
          },
          mainBankDocuments: [],
          subBankDocuments: [],
          costAnalysis: {
            googleVisionCost: 0,
            perDocumentType: { mainBank: 0, subBank: 0 },
            estimatedSavings: 0,
          },
          error: "指定されたレコードIDが見つかりません。",
        };
      }
      
      const record = recordResponse.data.records[0];
      
      // 2. メイン通帳とサブ通帳のファイルを取得
      const mainBankFiles = record[mainBankFieldName]?.value || [];
      const subBankFiles = record[subBankFieldName]?.value || [];
      
      console.log(`[通帳OCR改善版] ファイル取得結果:`);
      console.log(`  - メイン通帳: ${mainBankFiles.length}件`);
      console.log(`  - サブ通帳: ${subBankFiles.length}件`);
      console.log(`  - 処理対象合計: ${mainBankFiles.length + subBankFiles.length}件`);
      
      // ファイル処理の共通関数（改善版）
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
            // PDFファイルの処理（改善版: textAnnotations も取得）
            console.log(`[${documentType}] PDFを処理中（textAnnotations併用）...`);
            
            // ページ数確認
            let actualPageCount = 0;
            try {
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
              actualPageCount = testResult.responses?.[0]?.totalPages || maxPagesPerFile;
              console.log(`[${documentType}] PDFの総ページ数: ${actualPageCount}ページ`);
            } catch (error: any) {
              console.error(`[${documentType}] ページ数確認エラー:`, error.message);
              actualPageCount = maxPagesPerFile;
            }
            
            const pagesToProcess = Math.min(actualPageCount, maxPagesPerFile);
            const pageTexts: string[] = [];
            let totalProcessedPages = 0;
            const batchSize = 5;
            const numBatches = Math.ceil(pagesToProcess / batchSize);
            
            console.log(`[${documentType}] バッチ処理開始: ${pagesToProcess}ページ、${numBatches}バッチ`);
            
            // バッチごとに処理
            for (let batch = 0; batch < numBatches; batch++) {
              const startPage = batch * batchSize + 1;
              const endPage = Math.min(startPage + batchSize - 1, pagesToProcess);
              const pagesToProcessInBatch = Array.from(
                { length: endPage - startPage + 1 }, 
                (_, i) => startPage + i
              );
              
              console.log(`  バッチ${batch + 1}/${numBatches}: ページ${startPage}-${endPage}...`);
              
              try {
                const request = {
                  requests: [{
                    inputConfig: {
                      content: base64Content,
                      mimeType: 'application/pdf',
                    },
                    features: [
                      { type: 'DOCUMENT_TEXT_DETECTION' as const },  // メインのテキスト検出
                      { type: 'TEXT_DETECTION' as const },            // 補助的なテキスト検出
                    ],
                    pages: pagesToProcessInBatch,
                    imageContext: {
                      languageHints: ['ja'],  // 日本語ヒント
                    },
                  }],
                };
                
                const [result] = await visionClient.batchAnnotateFiles(request);
                
                if (result.responses?.[0]) {
                  const response = result.responses[0];
                  const pages = response.responses || [];
                  
                  console.log(`    [DEBUG] バッチ${batch + 1}: ${pages.length}ページのレスポンス取得`);
                  
                  // ★改善ポイント: fullTextAnnotation と textAnnotations を併用
                  for (const page of pages) {
                    const texts: string[] = [];
                    
                    // 🔍 デバッグ: pageオブジェクトの構造を確認
                    console.log(`    [DEBUG] ページ${totalProcessedPages + 1}: オブジェクトキー = ${Object.keys(page).join(', ')}`);
                    console.log(`    [DEBUG]   - fullTextAnnotation存在: ${!!page.fullTextAnnotation}`);
                    console.log(`    [DEBUG]   - textAnnotations存在: ${!!page.textAnnotations}`);
                    console.log(`    [DEBUG]   - textAnnotations長さ: ${page.textAnnotations?.length || 0}`);
                    
                    // 方法1: fullTextAnnotation（ページ全体のテキスト）
                    if (page.fullTextAnnotation?.text) {
                      texts.push(page.fullTextAnnotation.text);
                      console.log(`    [DEBUG]   - fullTextAnnotation: ${page.fullTextAnnotation.text.length}文字`);
                    } else {
                      console.log(`    [DEBUG]   - fullTextAnnotation: なし`);
                    }
                    
                    // 方法2: textAnnotations（個別テキストブロック）
                    // ※ マーカー付き部分も個別ブロックとして認識される可能性が高い
                    if (page.textAnnotations && page.textAnnotations.length > 0) {
                      console.log(`    [DEBUG]   - textAnnotations処理開始: ${page.textAnnotations.length}件`);
                      
                      // 最初のtextAnnotationsはページ全体なのでスキップ
                      const individualTexts = page.textAnnotations
                        .slice(1)  // 0番目はページ全体なので除外
                        .map((annotation: any) => annotation.description)
                        .filter((text: string) => text && text.trim().length > 0);
                      
                      console.log(`    [DEBUG]   - 個別テキスト（0番目除外後）: ${individualTexts.length}件`);
                      
                      // 個別テキストを結合（重複排除付き）
                      const uniqueTexts = [...new Set(individualTexts)];
                      
                      console.log(`    [DEBUG]   - ユニーク化後: ${uniqueTexts.length}件`);
                      
                      if (uniqueTexts.length > 0) {
                        texts.push('\n--- 個別検出テキスト ---\n' + uniqueTexts.join(' '));
                        console.log(`    ✓ 個別検出: ${uniqueTexts.length}件のテキストブロック`);
                        console.log(`    [DEBUG]   - サンプル（最初の3件）: ${uniqueTexts.slice(0, 3).join(', ')}`);
                      } else {
                        console.log(`    [DEBUG]   - ユニークテキストが0件`);
                      }
                    } else {
                      console.log(`    [DEBUG]   - textAnnotations: なしまたは空配列`);
                    }
                    
                    if (texts.length > 0) {
                      pageTexts.push(texts.join('\n'));
                      totalProcessedPages++;
                    }
                    
                    // 信頼度取得
                    if (batch === 0 && totalProcessedPages === 1 && page.fullTextAnnotation?.pages?.[0]) {
                      confidence = page.fullTextAnnotation.pages[0].confidence || 0;
                    }
                  }
                  
                  console.log(`    ✓ ${pages.length}ページ処理完了`);
                }
              } catch (batchError: any) {
                if (batchError.message?.includes('Invalid pages')) {
                  console.log(`    - ページ${startPage}-${endPage}は存在しません`);
                  break;
                } else {
                  console.error(`    ✗ エラー: ${batchError.message}`);
                  break;
                }
              }
            }
            
            if (pageTexts.length > 0) {
              extractedText = pageTexts.join('\n\n');
              pageCount = totalProcessedPages;
              console.log(`[${documentType}] ✓ ${pageCount}ページ処理完了`);
            } else {
              extractedText = `PDFの処理中にエラーが発生しました`;
              pageCount = 0;
            }
            
          } else {
            // 画像ファイルの処理（改善版）
            try {
              const [result] = await visionClient.documentTextDetection({
                image: {
                  content: base64Content,
                },
                imageContext: {
                  languageHints: ['ja'],
                },
              });
              
              const fullTextAnnotation = result.fullTextAnnotation;
              const textAnnotations = result.textAnnotations || [];
              
              const texts: string[] = [];
              
              // fullTextAnnotation
              if (fullTextAnnotation?.text) {
                texts.push(fullTextAnnotation.text);
              }
              
              // textAnnotations（個別ブロック）
              if (textAnnotations.length > 1) {
                const individualTexts = textAnnotations
                  .slice(1)
                  .map((annotation: any) => annotation.description)
                  .filter((text: string) => text && text.trim().length > 0);
                
                const uniqueTexts = [...new Set(individualTexts)];
                if (uniqueTexts.length > 0) {
                  texts.push('\n--- 個別検出テキスト ---\n' + uniqueTexts.join(' '));
                }
              }
              
              extractedText = texts.join('\n');
              confidence = fullTextAnnotation?.pages?.[0]?.confidence || 0;
              
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
      
      // 3. 両方のドキュメントタイプを並列処理
      console.log("\n=== メイン通帳の処理開始 ===");
      const mainBankProcessing = processFiles(mainBankFiles, "メイン通帳");
      
      console.log("\n=== サブ通帳の処理開始 ===");
      const subBankProcessing = processFiles(subBankFiles, "サブ通帳");
      
      const [mainBankResult, subBankResult] = await Promise.all([
        mainBankProcessing,
        subBankProcessing,
      ]);
      
      // コスト分析
      const totalGoogleVisionCost = mainBankResult.totalCost + subBankResult.totalCost;
      const estimatedClaudeCost = totalGoogleVisionCost * 58.5;
      const estimatedSavings = ((estimatedClaudeCost - totalGoogleVisionCost) / estimatedClaudeCost) * 100;
      
      console.log("\n[通帳OCR改善版] 処理結果:");
      console.log(`  - メイン通帳: ${mainBankResult.results.length}件処理`);
      console.log(`  - サブ通帳: ${subBankResult.results.length}件処理`);
      console.log(`  - 総コスト: $${totalGoogleVisionCost.toFixed(4)}`);
      
      return {
        success: true,
        processingDetails: {
          recordId,
          processedFiles: {
            mainBank: mainBankResult.results.length,
            subBank: subBankResult.results.length,
            total: mainBankResult.results.length + subBankResult.results.length,
          },
          totalPages: mainBankResult.results.reduce((sum, doc) => sum + doc.pageCount, 0) +
                      subBankResult.results.reduce((sum, doc) => sum + doc.pageCount, 0),
          timestamp,
        },
        mainBankDocuments: mainBankResult.results,
        subBankDocuments: subBankResult.results,
        costAnalysis: {
          googleVisionCost: totalGoogleVisionCost,
          perDocumentType: {
            mainBank: mainBankResult.totalCost,
            subBank: subBankResult.totalCost,
          },
          estimatedSavings: Math.round(estimatedSavings),
        },
      };
      
    } catch (error: any) {
      console.error("[通帳OCR改善版] エラー:", error);
      
      return {
        success: false,
        processingDetails: {
          recordId,
          processedFiles: { mainBank: 0, subBank: 0, total: 0 },
          totalPages: 0,
          timestamp,
        },
        mainBankDocuments: [],
        subBankDocuments: [],
        costAnalysis: {
          googleVisionCost: 0,
          perDocumentType: { mainBank: 0, subBank: 0 },
          estimatedSavings: 0,
        },
        error: `処理中にエラーが発生しました: ${error.message}`,
      };
    }
  },
});

