import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { googleVisionBankStatementOcrToolImproved } from "../tools/google-vision-bank-statement-ocr-tool-improved";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import axios from "axios";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

// 環境変数取得
const getEnvConfig = () => ({
  KINTONE_DOMAIN: process.env.KINTONE_DOMAIN || "",
  KINTONE_API_TOKEN: process.env.KINTONE_API_TOKEN || "",
  APP_ID: process.env.KINTONE_APP_ID || "37"
});

/**
 * Phase 2: 通帳分析ステップ（改善版）
 * - AI判定を1回のAPI呼び出しで完結
 * - 企業名の表記ゆれを自動考慮
 * - 分割入金・合算入金の自動検出
 */
export const phase2BankStatementStep = createStep({
  id: "phase2-bank-statement",
  description: "通帳分析（OCR → AI分析・照合 → リスク検出）",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    phase1Results: z.any().optional().describe("Phase 1の結果（オプション）"),
  }),
  
  outputSchema: z.object({
    recordId: z.string(),
    phase1Results: z.any().optional().describe("Phase 1の結果（引き継ぎ）"),
    phase2Results: z.object({
      mainBankAnalysis: z.object({
        collateralMatches: z.array(z.object({
          company: z.string(),
          monthlyResults: z.array(z.object({
            month: z.string(),
            expected: z.number(),
            actual: z.number(),
            matched: z.boolean(),
            matchType: z.string(),
            confidence: z.number(),
          })),
          hasTransactionHistory: z.boolean().describe("過去3ヶ月で¥0以外の入金実績があるか（true=継続取引、false=初回取引）"),
          transactionHistorySummary: z.string().describe("入金実績の要約（30文字以内、改行なし。例: '3ヶ月連続入金あり' or '過去3ヶ月入金実績なし'）"),
        })),
        riskDetection: z.object({
          gambling: z.array(z.object({
            date: z.string(),
            amount: z.number(),
            destination: z.string(),
            keyword: z.string(),
          })),
        }),
      }).optional(),
      factoringAnalysis: z.object({
        allTransactions: z.array(z.object({
          companyName: z.string(),
          date: z.string(),
          amount: z.number(),
          transactionType: z.enum(["入金", "出金"]),
          payerOrPayee: z.string(),
        })),
        companyAnalysis: z.array(z.object({
          companyName: z.string(),
          inboundTransactions: z.array(z.object({
            date: z.string(),
            amount: z.number(),
            payerName: z.string(),
          })),
          outboundTransactions: z.array(z.object({
            date: z.string(),
            amount: z.number(),
            payeeName: z.string(),
          })),
          pairedTransactions: z.array(z.object({
            inbound: z.object({ date: z.string(), amount: z.number() }),
            outbound: z.object({ date: z.string(), amount: z.number() }),
            status: z.enum(["完済", "一部返済"]),
          })),
          unpairedInbound: z.array(z.object({
            date: z.string(),
            amount: z.number(),
            note: z.string(),
          })),
          actualStatus: z.enum(["完済済み", "契約中の可能性", "要確認"]),
        })),
        alerts: z.array(z.object({
          type: z.enum(["複数社同時利用", "契約中複数社"]),
          severity: z.enum(["警告", "注意"]),
          message: z.string(),
          details: z.string(),
        })),
        summary: z.object({
          totalCompanies: z.number(),
          activeContracts: z.number(),
          completedContracts: z.number(),
          hasSimultaneousContracts: z.boolean(),
        }),
      }),
    }),
    summary: z.object({
      processingTime: z.number(),
      totalCost: z.number(),
    }),
  }),
  
  execute: async ({ inputData }) => {
    const { recordId, phase1Results } = inputData;
    
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[Phase 2] 通帳分析開始 - recordId: ${recordId}`);
    console.log(`${"=".repeat(80)}\n`);
    
    try {
      const startTime = Date.now();
      
      // ========================================
      // ステップ1: OCR処理（メイン通帳のみ）
      // ========================================
      console.log(`[Phase 2 - Step 1/3] OCR処理開始`);
      const ocrStartTime = Date.now();

      const ocrResult = await googleVisionBankStatementOcrToolImproved.execute!({
        context: {
          recordId,
          mainBankFieldName: "メイン通帳＿添付ファイル",
          subBankFieldName: "", // サブ通帳は使用しない
          maxPagesPerFile: 50,
        },
        runtimeContext: new RuntimeContext(),
      });

      const ocrDuration = Date.now() - ocrStartTime;
      console.log(`[Phase 2 - Step 1/3] OCR処理完了 - 処理時間: ${ocrDuration}ms`);
      console.log(`  - メイン通帳: ${ocrResult.mainBankDocuments.length}件 (${ocrResult.mainBankDocuments.reduce((sum, doc) => sum + doc.pageCount, 0)}ページ)`);

      if (!ocrResult.success) {
        throw new Error(`OCR処理失敗: ${ocrResult.error}`);
      }

      // 他社ファクタリング業者リスト（振込名ベース）
      // 実際に通帳に表示される振込依頼人名で検出
      const factoringCompanies = [
        "デュアルライフパートナーズ", "デュアルライフパートナーズ（カ）",
        "オルタ", "オルタ（カ）", "OLTA",
        "エージビジネスサポート", "エージビジネスサポート（カ）",
        "エスワイエスコンサルタント", "カ）エスワイエスコンサルタント",
        "VISTIA", "カ）VISTIA",
        "アクセルファクター", "カ）アクセルファクター",
        "インターテック", "カ）インターテック",
        "ウィック", "カ）ウィック",
        "バイオン", "カ）バイオン",
        "ナカスキキング", "ナカスキキング（カ）",
        "ビームサー", "ビームサー（カ）",
        "ペイトナー", "ペイトナー（カ）",
        "ラボル", "カ）ラボル", "labol",
        "チエンジ", "カ）チエンジ",
        "セイワビジネル", "セイワビジネル（カ）",
        "ジャパンパートナーズ",
        "プロスパーコンサルティング", "カ）プロスパーコンサルティング",
        "ビーサスカ）", "ビーサス",
        "ディーエムシー", "カ）ディーエムシー", "DMC",
        "メッシュ", "カ）メッシュ",
        "スリーエス", "カ）スリーエス",
        "セレンディピティ", "シャ）セレンディピティ",
        "フェニックス", "カ）フェニックス",
        "サンライズ", "カ）サンライズ",
        "ロコプラス", "カ）ロコプラス",
        "アールエフディー", "アールエフディー（カ）",
        "エイトラン", "カ）エイトラン",
        "ドエスクダブリュ",
        "エスシーメディカル", "カ）エスシーメディカル",
        "ジーシーエム", "カ）ジーシーエム", "GCM",
        "エスケーサービス", "カ）エスケーサービス",
        "ワモ", "カ）ワモ", "WAMO",
        "クイックファクター",
        "オンファクト", "カ）オンファクト",
        "プロクレス", "カ）プロクレス",
        "ビーケーパートナー", "カ）ビーケーパートナー",
        "フェイス", "カ）フェイス",
        "スリーアイ", "カ）スリーアイ",
        "ティワン", "カ）ティワン",
        "リクシス", "カ）リクシス", "LIXIS",
        "アルトゥル", "カ）アルトゥル",
        "テーブルプラス", "カ）テーブルプラス",
        "ビジネクション", "BUSINECTION",
        "スマートバンク", "カ）スマートバンク",
        "エコテックポリマー", "エコテックポリマー（カ）",
        "エスイーシステム", "エスイーシステム（カ）",
        // 以下、従来のリストから重要なものを追加（振込名が不明なもの）
        "QuQuMo", "ククモ",
        "FREENANCE", "フリーナンス",
        "GMOクリエイターズネットワーク",
        "ビートレーディング", "ビートレ",
        "MSFJ", "エムエスエフジェイ",
        "No.1", "ナンバーワン",
      ];

      // ギャンブル関連キーワードリスト（全体スコープで定義）
      const gamblingKeywords = [
        // パチンコ・スロット店
        "マルハン", "ダイナム", "ガイア", "GAIA", "エスパス",
        // 競馬
        "ウィンチケット", "WINTICKET", "SPAT4", "スパット", "楽天競馬", "オッズパーク",
        "JRA",
        // 競輪・競艇・オートレース
        "競艇", "テレボート", "オートレース", "BOAT RACE",
        // カジノ・オンラインカジノ
        "ベラジョン", "カジ旅", "エルドアカジノ", "ビットカジノ",
        // 宝くじ
         "ロト", "LOTO", "ナンバーズ", "NUMBERS", "ジャンボ",

      ];

      // ========================================
      // ステップ2: メイン通帳AI分析（1回のAPI呼び出しで完結）
      // ========================================
      let mainBankAnalysis: any = null;
      let mainBankAICost = 0;
      let collaterals: any[] = []; // 担保企業リスト（統合分析で使用）

      if (ocrResult.mainBankDocuments.length > 0) {
        console.log(`\n[Phase 2 - Step 2/4] メイン通帳AI分析開始`);
        const mainBankStartTime = Date.now();
        
        // Kintone担保情報の取得
        const config = getEnvConfig();
        const recordUrl = `https://${config.KINTONE_DOMAIN}/k/v1/records.json?app=${config.APP_ID}&query=$id="${recordId}"`;
        
        const recordResponse = await axios.get(recordUrl, {
          headers: { "X-Cybozu-API-Token": config.KINTONE_API_TOKEN },
        });
        
        const record = recordResponse.data.records[0];
        const collateralInfo = record.担保情報?.value || [];
        
        // 現在の月を取得（日本時間）
        const now = new Date();
        const currentMonth = now.getMonth() + 1; // 1-12
        const currentYear = now.getFullYear();
        
        // 過去3ヶ月の月名を生成
        const getMonthName = (offset: number) => {
          const date = new Date(currentYear, currentMonth - 1 - offset, 1);
          return `${date.getFullYear()}年${date.getMonth() + 1}月`;
        };
        
        collaterals = collateralInfo.map((item: any) => ({
          会社名: item.value?.会社名_第三債務者_担保?.value || "",
          先々月: Number(item.value?.過去の入金_先々月?.value || 0),
          先月: Number(item.value?.過去の入金_先月?.value || 0),
          今月: Number(item.value?.過去の入金_今月?.value || 0),
        }));
        
        console.log(`  - 担保情報: ${collaterals.length}社取得`);
        
        // OCRテキストを結合
        const mainBankText = ocrResult.mainBankDocuments
          .map(doc => `【${doc.fileName}】\n${doc.text}`)
          .join("\n\n---\n\n");

        // AI分析プロンプト（簡潔版）
        const analysisPrompt = `通帳OCRテキストを分析し、担保情報との照合とリスク検出を行ってください。

# 通帳データ（メイン通帳・法人口座）
${mainBankText}

# 期待される入金（Kintone担保情報）
${collaterals.map((c: any, idx: number) =>
  `${idx + 1}. ${c.会社名}: ${getMonthName(2)}=¥${c.先々月.toLocaleString()}, ${getMonthName(1)}=¥${c.先月.toLocaleString()}, ${getMonthName(0)}=¥${c.今月.toLocaleString()}`
).join('\n')}

# ========================================
# 【重要】他社ファクタリング業者リスト（振込名ベース）
# このリストは実際に通帳に表示される振込依頼人名
# 振込名フィールドにこれらの名前が含まれる場合のみ検出
# 摘要欄のみに含まれる場合は検出しない
# ========================================
${factoringCompanies.map((c, i) => `${i + 1}. ${c}`).join('\n')}

# ========================================
# 【重要】ギャンブル関連キーワード
# このリストに記載されたキーワードのみ検出対象
# ========================================
${gamblingKeywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}

# タスク
1. 全取引を抽出（日付、金額、振込元/先、摘要。入金=プラス、出金=マイナス）

2. 担保企業からの入金照合
   **企業名マッチングの原則:**
   - 金額を最優先（期待値±1,000円以内なら企業名は部分一致でOK）
   - OCRで企業名が途切れる可能性を考慮（例: 「株式会社ABC工務店」↔「ABC」）
   - 表記ゆれを考慮（法人格、カナ/漢字、略称を無視）

   **照合の原則:**
   - 各取引は1つの期待値にのみ対応
   - 分割入金を検出: 月内分割、月またぎ分割（前月末±7日、当月初±7日）、前払い/後払い（前後1ヶ月）
   - **重要**: 期待値が¥0の場合、実績も¥0なら「matched: true, matchType: "単独一致"」として扱う（取引がないことが期待通り）
   - **必須**: 各担保企業について、必ず過去3ヶ月分全てのmonthlyAnalysisを返すこと（¥0の月も含めて全て出力）

   **matchType分類:**
   単独一致、月内分割、月またぎ分割、複数月分割、前払い、後払い、不一致

   **必須フィールド:**
   - actualSource: **【重要】必ず1行の文字列で改行なし。** matched=trueなら「¥金額 ← 振込元名」、分割なら「+」で連結、matched=falseなら「検出なし」、**期待値¥0で一致なら「取引なし（期待通り）」**
   - matchedTransactions: matched=trueなら照合できた取引を全て含める（**期待値¥0の場合は空配列OK**）

   **出力例:**
   {"month": "2025-08", "expectedAmount": 1000000, "totalMatched": 1000000, "matched": true, "matchType": "単独一致", "actualSource": "1,000,000円 ← カ)〇〇工務店", "matchedTransactions": [{"date": "07-04", "amount": 1000000, "payerName": "カ)〇〇工務店"}], "unmatchedTransactions": []}

   **0円の場合の出力例:**
   {"month": "2025-10", "expectedAmount": 0, "totalMatched": 0, "matched": true, "matchType": "単独一致", "actualSource": "取引なし（期待通り）", "matchedTransactions": [], "unmatchedTransactions": []}

   **初回取引判定:**
   - 各担保企業について、過去3ヶ月で**¥0以外の入金実績**があるかを判定
   - hasTransactionHistory: 過去3ヶ月に1回でも¥0以外の入金があれば true、全て¥0なら false
   - transactionHistorySummary: **【重要】必ず1行の文字列で、改行（\n）・タブ（\t）・特殊文字を含めないこと。30文字以内。**
     - true の場合: 「3ヶ月連続入金あり」「2ヶ月入金あり」など
     - false の場合: 「過去3ヶ月入金実績なし」
   - **重要**: 期待値¥0で実績も¥0の月は「入金なし」としてカウントする
   - **JSON出力時の注意**: transactionHistorySummaryは必ず文字列の形式で、改行を含まないこと

   **判定例:**
   - 8月¥100万、9月¥150万、10月¥0 → hasTransactionHistory: true, transactionHistorySummary: "2ヶ月入金あり"
   - 8月¥0、9月¥0、10月¥0 → hasTransactionHistory: false, transactionHistorySummary: "過去3ヶ月入金実績なし"

3. ギャンブルリスク検出
   **検出条件:**
   - 振込先名がギャンブルキーワードと**完全一致**する出金取引のみ検出
   - 部分一致は検出しない（例: 「ウイット」は「ウィンチケット」と完全一致しないため検出しない）
   - 除外: クレカ/決済代行経由（SMBC、GMO、JCB等）

   【Few-Shot Examples】
   正例1: 完全一致 → 検出
   取引: 2025-08-15、-50,000円、「ウィンチケット」
   キーワード「ウィンチケット」と完全一致
   → {"date": "08-15", "amount": -50000, "destination": "ウィンチケット", "keyword": "ウィンチケット"}

   正例2: 部分一致 → 検出しない
   取引: 2025-08-20、-30,000円、「カ）ウイット」
   キーワード「ウィンチケット」と完全一致しない
   → 検出しない

   正例3: クレカ経由 → 検出しない
   取引: 2025-08-25、-30,000円、「SMBC カード ウィンチケット」
   → 検出しない（SMBC経由）

   正例4: 完全一致（カタカナ表記）→ 検出
   取引: 2025-09-05、-20,000円、「マルハン」
   キーワード「マルハン」と完全一致
   → {"date": "09-05", "amount": -20000, "destination": "マルハン", "keyword": "マルハン"}

4. 他社ファクタリング取引分析（詳細版）

【検出フェーズ - 振込名優先】
- **振込依頼人名（振込名フィールド）**に業者名が含まれる場合のみ検出
  - 入金取引: 振込元（振込依頼人名）に業者名が含まれる
  - 出金取引: 振込先（振込依頼人名）に業者名が含まれる
- **摘要欄のみ**に業者名が含まれる場合は検出しない
- 除外: クレカ/決済代行経由（セゾン、アメックス、SMBC、GMOペイメント等）
- **重要**: 「マネーフォワード」単体は除外、「マネーフォワードケッサイ」「カ）ラボル」「ラボル」は検出

【ペアリングフェーズ】
各業者について以下を分析:
1. 入金取引を時系列で取得
2. 各入金に対して、その後の出金で金額が近い取引を検索
3. ペアリング条件:
   - 入金日 < 出金日（時系列）
   - 出金金額が入金金額の90-115%の範囲内（手数料込み）
   - 同一業者

【判定ルール】
- ✅ 入金・出金ペア成立 → status="完済", note=""
- ⚠️ 入金のみで出金なし（60日以上経過） → status="契約中の可能性", note="申込者に契約状況を確認してください"
- ⚠️ 入金のみで出金なし（60日未満） → status="要確認", note="返済期日前の可能性あり。申込者に確認してください"
- ✅ 出金のみで入金なし → status="完済済み", note="入金が通帳期間外"

【アラート条件】
- 同月（±15日以内）に2社以上から入金 → alert type="複数社同時利用"
- 未完済（契約中の可能性）の業者が2社以上 → alert type="契約中複数社"

---

# 【重要】JSON出力時の注意事項

**すべての文字列フィールドで改行（\\n）・タブ（\\t）・特殊文字を含めないこと。**
特に以下のフィールドは1行の文字列で記載：
- actualSource
- transactionHistorySummary
- payerName
- destination

JSON形式で出力してください。`;
        
        const schema = z.object({
          collateralMatches: z.array(z.object({
            company: z.string(),
            allTransactions: z.array(z.object({
              date: z.string().describe("取引日（MM-DD形式 または YYYY-MM-DD形式）"),
              amount: z.number().describe("取引金額"),
              payerName: z.string().describe("通帳記載の振込元名"),
            })).describe("この会社からの全入金取引（OCRから抽出された全て）"),
            expectedValues: z.array(z.object({
              month: z.string().describe("期待月（YYYY-MM形式）"),
              amount: z.number().describe("期待金額"),
            })).describe("Kintoneから取得した期待値（過去3ヶ月分）"),
            monthlyAnalysis: z.array(z.object({
              month: z.string(),
              expectedAmount: z.number(),
              totalMatched: z.number(),
              matched: z.boolean(),
              matchType: z.enum([
                "単独一致",
                "月内分割",
                "月またぎ分割",
                "複数月分割",
                "前払い",
                "後払い",
                "不一致"
              ]).describe("照合タイプ"),
              actualSource: z.string().min(1).describe("【必須】OCRから取得した実際の入金ソース。matched=trueなら「¥金額 ← 振込元名」形式、分割なら「+」で連結。matched=falseなら「検出なし」"),
              matchedTransactions: z.array(z.object({
                date: z.string().describe("取引日（MM-DD形式）"),
                amount: z.number().describe("取引金額"),
                payerName: z.string().describe("通帳記載の振込元名"),
              })).describe("期待値と照合できた入金取引（分割入金は全て含める）"),
              unmatchedTransactions: z.array(z.object({
                date: z.string().describe("取引日（MM-DD形式）"),
                amount: z.number().describe("取引金額"),
                payerName: z.string().describe("通帳記載の振込元名"),
                purpose: z.string().optional().describe("推測される用途"),
              })).describe("同じ会社からの入金だが期待値と照合できなかった取引"),
              firstInteractionRisk: z.boolean().optional().describe("過去3ヶ月すべてが¥0（初回取引の可能性）")
            })),
          })),
          riskDetection: z.object({
            gambling: z.array(z.object({
              date: z.string(),
              amount: z.number(),
              destination: z.string(),
              keyword: z.enum(gamblingKeywords as [string, ...string[]]).describe("上記ギャンブルキーワードリストから選択（リストにない場合は出力しない）"),
            })),
          }),
          factoringAnalysis: z.object({
            allTransactions: z.array(z.object({
              companyName: z.string().describe("検出された業者名"),
              date: z.string().describe("取引日（YYYY-MM-DD形式）"),
              amount: z.number().describe("取引金額（入金はプラス、出金はマイナス）"),
              transactionType: z.enum(["入金", "出金"]),
              payerOrPayee: z.string().describe("通帳記載の相手先名"),
            })).describe("検出された全ての他社ファクタリング取引"),
            companyAnalysis: z.array(z.object({
              companyName: z.string(),
              inboundTransactions: z.array(z.object({
                date: z.string(),
                amount: z.number(),
                payerName: z.string(),
              })).describe("この業者からの入金取引（業者→申込者）"),
              outboundTransactions: z.array(z.object({
                date: z.string(),
                amount: z.number(),
                payeeName: z.string(),
              })).describe("この業者への出金取引（申込者→業者）"),
              pairedTransactions: z.array(z.object({
                inbound: z.object({
                  date: z.string(),
                  amount: z.number(),
                }),
                outbound: z.object({
                  date: z.string(),
                  amount: z.number(),
                }),
                status: z.enum(["完済", "一部返済"]),
              })).describe("ペアリングできた入出金（完済済み）"),
              unpairedInbound: z.array(z.object({
                date: z.string(),
                amount: z.number(),
                note: z.string().describe("確認事項メモ"),
              })).describe("ペアリングできない入金（契約中の可能性）"),
              actualStatus: z.enum(["完済済み", "契約中の可能性", "要確認"]),
            })).describe("業者ごとの取引分析"),
            alerts: z.array(z.object({
              type: z.enum(["複数社同時利用", "契約中複数社"]),
              severity: z.enum(["警告", "注意"]),
              message: z.string(),
              details: z.string(),
            })),
            summary: z.object({
              totalCompanies: z.number().describe("検出業者数"),
              activeContracts: z.number().describe("契約中の可能性がある業者数"),
              completedContracts: z.number().describe("完済済み業者数"),
              hasSimultaneousContracts: z.boolean().describe("複数社同時利用フラグ"),
            }),
          }),
        });

        const result = await generateObject({
          model: google("gemini-2.5-pro"),
          prompt: analysisPrompt,
          schema,
        });

        mainBankAnalysis = result.object;

        // AI APIコストの推定（GPT-4.1）
        const inputTokens = result.usage?.inputTokens || Math.ceil(analysisPrompt.length / 4);
        const outputTokens = result.usage?.outputTokens || Math.ceil(JSON.stringify(result.object).length / 4);
        // GPT-4.1コスト: 入力 $0.000003/token, 出力 $0.000012/token
        mainBankAICost = (inputTokens * 0.000003) + (outputTokens * 0.000012);
        
        const mainBankDuration = Date.now() - mainBankStartTime;
        console.log(`[Phase 2 - Step 2/4] メイン通帳AI分析完了 - 処理時間: ${mainBankDuration}ms`);
        console.log(`  - 照合企業数: ${mainBankAnalysis.collateralMatches.length}社`);
        
        // 結果表示
        console.log(`\n${"━".repeat(80)}`);
        console.log(`メイン通帳分析結果`);
        console.log(`${"━".repeat(80)}\n`);
        
        for (const match of mainBankAnalysis.collateralMatches) {
          console.log(`【企業: ${match.company}】`);

          // 全取引の表示（ログをすっきりさせるため削除）
          // if (match.allTransactions && match.allTransactions.length > 0) {
          //   console.log(`\n  📋 OCRから抽出された全入金取引（${match.allTransactions.length}件）:`);
          //   match.allTransactions.forEach((tx: any, idx: number) => {
          //     console.log(`     ${idx + 1}. ${tx.date}: ¥${tx.amount.toLocaleString()} ← 「${tx.payerName}」`);
          //   });
          // }

          // 期待値の表示
          if (match.expectedValues && match.expectedValues.length > 0) {
            console.log(`\n  📊 Kintone期待値（${match.expectedValues.length}ヶ月分）:`);
            match.expectedValues.forEach((ev: any, idx: number) => {
              console.log(`     ${idx + 1}. ${ev.month}: ¥${ev.amount.toLocaleString()}`);
            });
          }

          console.log(`\n  🔍 照合結果:`);
            match.monthlyAnalysis.forEach((month: any) => {
            // 初回取引リスクの付与（過去3ヶ月すべて0円の場合）
            try {
              const allZero = month.expectedAmount === 0 && month.totalMatched === 0;
              if (allZero) {
                month.firstInteractionRisk = true;
              }
            } catch {}
            const icon = month.matched ? "✓" : "✗";
            const status = month.matched ? "一致" : "不一致";

            // 分割入金の場合は詳細を表示
            let matchDetail = month.matchType;
            if (month.matchedTransactions && month.matchedTransactions.length > 1) {
              matchDetail = `${month.matchType}（${month.matchedTransactions.length}回）`;
            }

            console.log(`     ${icon} ${month.month}: ${status} (${matchDetail})`);
            console.log(`        期待値: ¥${month.expectedAmount.toLocaleString()} / 検出合計: ¥${month.totalMatched.toLocaleString()}`);

            // 実際に検出された取引の詳細
            if (month.matchedTransactions && month.matchedTransactions.length > 0) {
              console.log(`        照合できた取引:`);
              month.matchedTransactions.forEach((tx: any, txIdx: number) => {
                console.log(`          - ${tx.date}: ¥${tx.amount.toLocaleString()} ← 「${tx.payerName}」`);
              });

              // 分割入金の場合、合計も表示
              if (month.matchedTransactions.length > 1) {
                const sum = month.matchedTransactions.reduce((acc: number, tx: any) => acc + tx.amount, 0);
                console.log(`          → 合計: ¥${sum.toLocaleString()}`);
              }
            }

            // 期待値と照合できなかった取引（表示を削除してログをすっきりさせる）
            // if (month.unmatchedTransactions && month.unmatchedTransactions.length > 0) {
            //   console.log(`        ⚠️ 期待値外の取引（別案件の可能性）:`);
            //   month.unmatchedTransactions.forEach((tx: any, txIdx: number) => {
            //     const purposeText = tx.purpose ? ` - ${tx.purpose}` : '';
            //     console.log(`          - ${tx.date}: ¥${tx.amount.toLocaleString()} ← 「${tx.payerName}」${purposeText}`);
            //   });
            // }
          });
          console.log();
        }
        
        console.log(`【リスク検出】\n`);

        console.log(`＜ギャンブル＞`);
        console.log(`  検出ルール: 30種以上（ウィンチケット、マルハン、ダイナム、ベラジョン、競馬、パチンコ等）`);
        if (mainBankAnalysis.riskDetection.gambling.length > 0) {
          console.log(`  ⚠️ 検出: ${mainBankAnalysis.riskDetection.gambling.length}件`);
          mainBankAnalysis.riskDetection.gambling.forEach((g: any, idx: number) => {
            console.log(`    ${idx + 1}. ${g.date}: -¥${Math.abs(g.amount).toLocaleString()} → 「${g.destination}」`);
            console.log(`       一致キーワード: 「${g.keyword}」`);
          });
        } else {
          console.log(`  検出なし`);
        }

        // 他社ファクタリング分析の表示
        console.log(`\n＜他社ファクタリング取引分析＞`);
        const factoringAnalysis = mainBankAnalysis.factoringAnalysis;

        console.log(`\n【サマリー】`);
        console.log(`  検出業者: ${factoringAnalysis.summary.totalCompanies}社`);
        console.log(`  完済済み: ${factoringAnalysis.summary.completedContracts}社`);
        console.log(`  契約中の可能性: ${factoringAnalysis.summary.activeContracts}社`);

        if (factoringAnalysis.companyAnalysis.length > 0) {
          console.log(`\n【業者別分析】\n`);

          factoringAnalysis.companyAnalysis.forEach((company: any) => {
            console.log(`━━━ ${company.companyName} ━━━`);

            // 入金取引
            if (company.inboundTransactions.length > 0) {
              console.log(`  📥 入金: ${company.inboundTransactions.length}件`);
              company.inboundTransactions.forEach((tx: any) => {
                console.log(`     ${tx.date}: ¥${tx.amount.toLocaleString()} ← 「${tx.payerName}」`);
              });
            } else {
              console.log(`  📥 入金: なし`);
            }

            // 出金取引
            if (company.outboundTransactions.length > 0) {
              console.log(`  📤 出金: ${company.outboundTransactions.length}件`);
              company.outboundTransactions.forEach((tx: any) => {
                console.log(`     ${tx.date}: ¥${tx.amount.toLocaleString()} → 「${tx.payeeName}」`);
              });
            } else {
              console.log(`  📤 出金: なし`);
            }

            // ペアリング結果
            if (company.pairedTransactions.length > 0) {
              console.log(`  ✅ 完済取引: ${company.pairedTransactions.length}ペア`);
              company.pairedTransactions.forEach((pair: any) => {
                console.log(`     入金 ${pair.inbound.date} ¥${pair.inbound.amount.toLocaleString()} → 出金 ${pair.outbound.date} ¥${pair.outbound.amount.toLocaleString()} (${pair.status})`);
              });
            }

            // 未ペア入金
            if (company.unpairedInbound.length > 0) {
              console.log(`  ⚠️ 未返済入金: ${company.unpairedInbound.length}件`);
              company.unpairedInbound.forEach((tx: any) => {
                console.log(`     ${tx.date}: ¥${tx.amount.toLocaleString()}`);
                console.log(`     📝 ${tx.note}`);
              });
            }

            // 状態
            const statusIcon = company.actualStatus === "完済済み" ? "✅" : "⚠️";
            console.log(`  ${statusIcon} 状態: ${company.actualStatus}`);
            console.log();
          });
        }

        // アラート表示
        if (factoringAnalysis.alerts.length > 0) {
          console.log(`【🚨 アラート】\n`);
          factoringAnalysis.alerts.forEach((alert: any, idx: number) => {
            const icon = alert.severity === "警告" ? "🚨" : "⚠️";
            console.log(`  ${icon} ${alert.type}`);
            console.log(`     ${alert.message}`);
            console.log(`     詳細: ${alert.details}`);
          });
          console.log();
        }

        console.log(`${"━".repeat(80)}\n`);
      } else {
        console.log(`\n[Phase 2 - Step 2/3] メイン通帳分析スキップ（ファイルなし）`);
      }


      // ========================================
      // ステップ3: 結果サマリー生成
      // ========================================
      console.log(`\n[Phase 2 - Step 3/3] 結果サマリー生成`);
      
      // ========================================
      // 結果のサマリー生成
      // ========================================
      const totalDuration = Date.now() - startTime;
      const totalCost = ocrResult.costAnalysis.googleVisionCost + mainBankAICost;

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Phase 2 処理完了`);
      console.log(`  処理時間: ${(totalDuration / 1000).toFixed(2)}秒`);
      console.log(`  総コスト: $${totalCost.toFixed(4)}`);
      if (mainBankAnalysis) {
        const totalMatches = mainBankAnalysis.collateralMatches.length;
        const matchedCount = mainBankAnalysis.collateralMatches.filter((m: any) =>
          m.monthlyAnalysis.some((ma: any) => ma.matched)
        ).length;
        const gamblingTotal = mainBankAnalysis.riskDetection.gambling.length;
        const factoringTotal = mainBankAnalysis.factoringAnalysis.summary.totalCompanies;
        const activeFactoring = mainBankAnalysis.factoringAnalysis.summary.activeContracts;
        console.log(`  担保企業照合: ${matchedCount}/${totalMatches}社`);
        console.log(`  ギャンブル検出: ${gamblingTotal}件`);
        console.log(`  他社ファクタリング: ${factoringTotal}社検出（契約中の可能性: ${activeFactoring}社）`);
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // 簡潔でわかりやすい出力構造
      return {
        recordId,
        phase1Results, // Phase 1の結果を引き継ぎ
        phase2Results: {
          mainBankAnalysis: mainBankAnalysis ? {
            collateralMatches: mainBankAnalysis.collateralMatches.map((match: any) => {
              const monthlyResults = (match.monthlyAnalysis || []).map((ma: any) => ({
                month: ma.month,
                expected: ma.expectedAmount,
                actual: ma.totalMatched,
                actualSource: ma.actualSource || "不明",
                matched: ma.matched,
                matchType: ma.matchType,
                confidence: ma.confidence || 0,
                matchedTransactions: ma.matchedTransactions || [],
                unmatchedTransactions: ma.unmatchedTransactions || [],
                firstInteractionRisk: (ma.expectedAmount === 0 && ma.totalMatched === 0) || undefined,
              }));

              const firstInteraction = monthlyResults.length > 0 && monthlyResults.every((m: any) => m.expected === 0 && m.actual === 0);

              return {
                company: match.company,
                allTransactions: match.allTransactions || [],
                expectedValues: match.expectedValues || [],
                monthlyResults,
                firstInteraction,
              };
            }),
            riskDetection: mainBankAnalysis.riskDetection,
          } : undefined,
          factoringAnalysis: mainBankAnalysis ? mainBankAnalysis.factoringAnalysis : {
            allTransactions: [],
            companyAnalysis: [],
            alerts: [],
            summary: {
              totalCompanies: 0,
              activeContracts: 0,
              completedContracts: 0,
              hasSimultaneousContracts: false,
            },
          },
        },
        summary: {
          processingTime: totalDuration / 1000,
          totalCost,
        },
      };
      
    } catch (error: any) {
      console.error(`\n[Phase 2] エラー発生:`, error.message);
      console.error(error);
      
      throw new Error(`Phase 2 処理失敗: ${error.message}`);
    }
  },
});
