import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { annotateImage, batchAnnotateFiles } from '../lib/google-vision-rest';

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

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
      
      // 2. 買取請求書と担保謄本のファイルを取得
      const allPurchaseFiles = record[purchaseFieldName]?.value || [];
      const allCollateralFiles = record[collateralFieldName]?.value || [];

      // ファイル名フィルタリング: （現在）（閉鎖）を除外
      const shouldIncludeFile = (fileName: string): boolean => {
        // ファイル名に（現在）または（閉鎖）が含まれる場合は除外
        // 例: 会社名（現在）2025102801215337.PDF → 除外
        if (fileName.includes('（現在）') || fileName.includes('（閉鎖）')) {
          return false;
        }
        // それ以外は全て含める（（全部事項）や、どれも含まれていないファイル）
        return true;
      };

      const purchaseFiles = allPurchaseFiles.filter((file: any) => shouldIncludeFile(file.name));
      const collateralFiles = allCollateralFiles.filter((file: any) => shouldIncludeFile(file.name));

      const excludedPurchaseCount = allPurchaseFiles.length - purchaseFiles.length;
      const excludedCollateralCount = allCollateralFiles.length - collateralFiles.length;

      console.log(`[買取・担保OCR] 処理対象:`);
      console.log(`  - 買取情報フィールド: ${purchaseFiles.length}件（除外: ${excludedPurchaseCount}件）`);
      console.log(`  - 担保情報フィールド: ${collateralFiles.length}件（除外: ${excludedCollateralCount}件）`);
      console.log(`  - 処理対象合計: ${purchaseFiles.length + collateralFiles.length}件`);

      if (excludedPurchaseCount > 0 || excludedCollateralCount > 0) {
        console.log(`\n[買取・担保OCR] 除外されたファイル（現在/閉鎖）:`);
        allPurchaseFiles.filter((file: any) => !shouldIncludeFile(file.name)).forEach((file: any) => {
          console.log(`  ❌ ${file.name}`);
        });
        allCollateralFiles.filter((file: any) => !shouldIncludeFile(file.name)).forEach((file: any) => {
          console.log(`  ❌ ${file.name}`);
        });
      }

      if (purchaseFiles.length > 0) {
        console.log(`\n[買取・担保OCR] 買取情報ファイル一覧:`);
        purchaseFiles.forEach((file: any) => {
          console.log(`  ✅ ${file.name}`);
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
              const testResult = await batchAnnotateFiles(base64Content, 'application/pdf', [1]);

              if (testResult.totalPages) {
                actualPageCount = testResult.totalPages;
                console.log(`[${documentType}] PDFの総ページ数: ${actualPageCount}ページ`);
              } else {
                // totalPagesが取得できない場合は、段階的に確認
                console.log(`[${documentType}] ページ数を段階的に確認中...`);
                for (let testPage = 1; testPage <= maxPagesPerFile; testPage += 10) {
                  try {
                    await batchAnnotateFiles(base64Content, 'application/pdf', [testPage]);
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
                      await batchAnnotateFiles(base64Content, 'application/pdf', [testPage]);
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
                const result = await batchAnnotateFiles(base64Content, 'application/pdf', pagesToProcessInBatch);

                if (result.responses) {
                  const pages = result.responses || [];
                  
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
              const result = await annotateImage(base64Content);
              
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
          // テキストの最初の4000文字を使用（詳細な抽出のため）
          const textSample = document.text.substring(0, 4000);

          // 汎用的なスキーマ：何が入っていたかの事実を記録
          const schema = z.object({
            documentType: z.string().describe("文書種別（請求書、登記情報、債権譲渡概要、名刺、契約書など、文書に記載されている内容から自由に判定）"),
            extractedFactsJson: z.string().describe("抽出された事実情報をJSON文字列として記録（会社名、資本金、設立年月日、代表者名、請求額、期日など、文書から読み取れる情報を柔軟に記録。ネスト構造も可能）"),
          });

          console.log(`\n[文書分類] ${document.fileName} を分類中...`);
          console.log(`[文書分類] テキストサンプル長: ${textSample.length}文字`);

          const result = await generateObject({
            model: google("gemini-2.5-flash"),
            prompt: `以下の文書のOCRテキストを分析し、文書種別と抽出可能な情報を記録してください。

【重要】
- 文書種別は固定の選択肢ではなく、文書の内容から自由に判定してください
- 抽出された情報は、何が記載されていたかの「事実」を記録してください
- 型にはめず、存在する情報を柔軟に抽出してください
- 情報が存在しない場合は、そのフィールドを含めないでください
- **必ず完全で有効なJSONを返してください（途中で切れないように）**
- 明細が多い場合は、重要な項目のみを抽出してください（全明細を含める必要はありません）

【登記情報に関する追加ルール（同一法人判定のための抽出強化）】
- 「登記情報」「登記事項証明」「法人登記簿」等である場合は、以下を優先して extractedFacts に格納してください。
  1) 会社法人等番号（13桁、ハイフン有無は任意）: key="会社法人等番号"
  2) 商号（現商号）と旧商号の一覧: key="商号"={"現商号": string, "旧商号": string[]}
  3) 名称候補の配列（誤OCR対策）: key="名称候補"=[{"名称": string, "漢字比率": number}]
  4) 資本金の額: key="資本金の額"（例: "金900万円"、"金1000万円"など原文のまま）
  5) 会社成立の年月日: key="会社成立の年月日"（例: "平成21年9月1日"など原文のまま）
  6) 代表者名: key="代表者名"
  7) 本店所在地: key="本店"
- 商号変更の行（例: 「令和○年○月○日変更」等）があれば旧商号として追加
- 名称候補はカナのみの行は除外、漢字を多く含む候補を優先
- 値は原文をそのまま（正規化はしない）
- **重要**: 資本金の額と会社成立の年月日は必ず抽出してください。登記簿に記載がある場合は必ず含めてください。

【OCRテキスト】
${textSample}

【抽出例】
登記情報の場合:
{
  "documentType": "登記情報",
  "extractedFactsJson": "{\\"会社名\\": \\"株式会社〇〇\\", \\"会社法人等番号\\": \\"3701-01-001616\\", \\"商号\\": {\\"現商号\\": \\"城南建設株式会社\\", \\"旧商号\\": [\\"株式会社かのしき\\"]}, \\"名称候補\\": [{\\"名称\\": \\"城南建設株式会社\\", \\"漢字比率\\": 1.0}], \\"資本金の額\\": \\"金1000万円\\", \\"会社成立の年月日\\": \\"平成20年1月1日\\", \\"代表者名\\": \\"山田太郎\\", \\"本店\\": \\"東京都新宿区〇〇1-2-3\\"}"
}

債権譲渡概要の場合:
{
  "documentType": "債権譲渡概要",
  "extractedFactsJson": "{\\"会社名\\": \\"株式会社〇〇\\", \\"譲渡債権額\\": 5000000, \\"譲渡日\\": \\"2024年12月1日\\", \\"状態\\": \\"閉鎖\\"}"
}

請求書の場合:
{
  "documentType": "請求書",
  "extractedFactsJson": "{\\"請求元\\": \\"株式会社〇〇\\", \\"請求先\\": \\"株式会社△△\\", \\"請求額\\": 1000000, \\"支払期日\\": \\"2024年12月31日\\"}"
}`,
            schema,
          });

          const inputCost = (result.usage?.totalTokens || 0) * 0.000003 * 0.5;
          const outputCost = (result.usage?.totalTokens || 0) * 0.000015 * 0.5;

          console.log(`[文書分類] Geminiレスポンス:`, JSON.stringify(result.object, null, 2));

          // JSONをパース
          let extractedFacts = {};
          try {
            extractedFacts = JSON.parse(result.object.extractedFactsJson);
            console.log(`[文書分類] パース成功:`, extractedFacts);
          } catch (parseError) {
            console.warn(`[文書分類] JSON解析エラー (${document.fileName}):`, parseError);
            console.warn(`[文書分類] 受信した文字列:`, result.object.extractedFactsJson);
            extractedFacts = {};
          }

          console.log(`[文書分類] ${document.fileName} 完了 → 種別: ${result.object.documentType}`);

          return {
            documentType: result.object.documentType,
            extractedFacts,
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