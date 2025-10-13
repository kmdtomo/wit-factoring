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
      subBankAnalysis: z.object({
        riskDetection: z.object({
          gambling: z.array(z.object({
            date: z.string(),
            amount: z.number(),
            destination: z.string(),
            keyword: z.string(),
          })),
        }),
      }).optional(),
      crossBankTransfers: z.array(z.object({
        date: z.string(),
        amount: z.number(),
        from: z.string(),
        to: z.string(),
      })),
      factoringCompanies: z.array(z.object({
        companyName: z.string(),
        date: z.string(),
        amount: z.number(),
        transactionType: z.string(),
      })),
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
      // ステップ1: OCR処理
      // ========================================
      console.log(`[Phase 2 - Step 1/4] OCR処理開始`);
      const ocrStartTime = Date.now();
      
      const ocrResult = await googleVisionBankStatementOcrToolImproved.execute!({
        context: {
          recordId,
          mainBankFieldName: "メイン通帳＿添付ファイル",
          subBankFieldName: "その他通帳＿添付ファイル",
          maxPagesPerFile: 50,
        },
        runtimeContext: new RuntimeContext(),
      });
      
      const ocrDuration = Date.now() - ocrStartTime;
      console.log(`[Phase 2 - Step 1/4] OCR処理完了 - 処理時間: ${ocrDuration}ms`);
      console.log(`  - メイン通帳: ${ocrResult.mainBankDocuments.length}件 (${ocrResult.mainBankDocuments.reduce((sum, doc) => sum + doc.pageCount, 0)}ページ)`);
      console.log(`  - サブ通帳: ${ocrResult.subBankDocuments.length}件 (${ocrResult.subBankDocuments.reduce((sum, doc) => sum + doc.pageCount, 0)}ページ)`);
      
      if (!ocrResult.success) {
        throw new Error(`OCR処理失敗: ${ocrResult.error}`);
      }

      // 他社ファクタリング業者リスト（110社）
      const factoringCompanies = [
        "デュアルライフパートナーズ", "Dual Life Partners",
        "GMOクリエイターズネットワーク",
        "Payサポート", "ペイサポート",
        "フリーナンス", "FREENANCE",
        "グッドプラス",
        "ベルトラ",
        "NECキャピタルソリューション",
        "OLTAクラウドファクタリング", "OLTA", "オルタ",
        "SYS", "エスワイエス",
        "アクセルファクター", "ACCEL FACTOR",
        "エージーピージャパン", "AGP JAPAN",
        "一般社団法人日本中小企業金融サポート機構",
        "エムエスエフジェイ", "MSFJ",
        "株式会社EMV",
        "株式会社FFG",
        "株式会社JTC",
        "株式会社No.1", "ナンバーワン",
        "株式会社SEICOサービス",
        "株式会社PROTECT ONE",
        "株式会社TRY",
        "株式会社UPSIDER",
        "株式会社インフォマート", "INFOMART",
        "株式会社エスワイエス", "SYS",
        "株式会社EVISTA",
        "株式会社ケアプル", "CAREPL",
        "株式会社セッション・アップ",
        "株式会社アウタープル", "OUTERPULL",
        "株式会社アクティブサポート",
        "株式会社アクリ", "ACRI",
        "株式会社アップス・エンド", "UPS END",
        "株式会社アレシア",
        "株式会社アンカーガーディアン",
        "株式会社ウィット", "WIT",
        "株式会社ウイング",
        "株式会社エスコム", "ESCOM",
        "株式会社エムエスライズ",
        "株式会社オッティ", "OTTI",
        "株式会社カイト", "KITE",
        "株式会社グッドプラス",
        "株式会社シレイタ", "SIREITA",
        "株式会社トライスゲートウェイ",
        "株式会社トラストゲートウェイ", "TRUST GATEWAY",
        "株式会社ネクストワン",
        "株式会社ハイフィール",
        "株式会社バイカン", "BAIKAN",
        "株式会社ビートレーディング", "BUY TRADING", "ビートレ",
        "株式会社ペイトナー", "PAYTONAR", "ペイトナー",
        "株式会社マネーフォワードケッサイ",
        "株式会社メンターキャピタル",
        "株式会社ライジングインノベーション", "RISING INNOVATION",
        "株式会社ライトマネジメント",
        "株式会社Wエンタープライズ",
        "グローバルキャピタル",
        "三共サービス", "SANKYO SERVICE",
        "日本ネクストキャピタル",
        "ビーエムシー", "BMC",
        "ピーエムジー", "PMG",
        "マイルド", "MILD",
        "ラボル", "labol",
        "株式会社ラボル",
        "株式会社西日本ファクター",
        "ANEW株式会社",
        "FundingCloud",
        "GMOペイメントゲートウェイ", "GMO",
        "Ganx株式会社",
        "株式会社ティーアンドエス", "T&S",
        "株式会社ディーエムシー", "DMC",
        "株式会社ファクタリングジャパン",
        "株式会社ファンドワン", "FUND ONE",
        "株式会社フィーディクス", "FEEDIX",
        "株式会社三菱HCキャピタル",
        "株式会社五常", "GOJYO",
        "株式会社中小企業再生支援",
        "株式会社事業資金エージェント",
        "株式会社日本ビジネスリンクス",
        "株式会社資金調達本舗",
        "QuQuMo", "ククモ",
        "アースファクター",
        "エヌファクター", "N-FACTOR",
        "コバンザメ",
        "トップマネジメント",
        "ハンズトレード",
        "ベストファクター", "BEST FACTOR",
        "ユアファクター",
        "株式会社Hondaa",
        "株式会社PROTECTER ONE",
        "株式会社オーティーアイ", "OTI",
        "株式会社ライズ", "RISE",
        "株式会社ANIHEN LINK",
        "株式会社エスアール", "SR",
        "株式会社トラップコミュニケーション",
        "各務資財リサイクル",
        "株式会社LM9",
        "株式会社LUMIA",
        "株式会社Soluno",
        "株式会社ワークルズ", "WORKLES",
        "BUSINESSPARTNER株式会社",
        "株式会社電子の森の映画館の当時の株式会社ビットネック",
        "エコテックポリマー株式会社",
        "サークルシップホールディングス株式会社",
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
# 【重要】他社ファクタリング業者リスト（110社）
# このリストに記載された業者のみ検出対象
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

   **matchType分類:**
   単独一致、月内分割、月またぎ分割、複数月分割、前払い、後払い、不一致

   **必須フィールド:**
   - actualSource: matched=trueなら「¥金額 ← 振込元名」、分割なら「+」で連結、matched=falseなら「検出なし」
   - matchedTransactions: matched=trueなら照合できた取引を全て含める（空配列禁止）

   **出力例:**
   {"month": "2025-08", "expectedAmount": 1000000, "totalMatched": 1000000, "matched": true, "matchType": "単独一致", "actualSource": "1,000,000円 ← カ)〇〇工務店", "matchedTransactions": [{"date": "07-04", "amount": 1000000, "payerName": "カ)〇〇工務店"}], "unmatchedTransactions": []}

3. ギャンブルリスク検出
   **検出条件:**
   - キーワードが主要部分として含まれる出金取引のみ検出
   - 除外: クレカ/決済代行経由（SMBC、GMO、JCB等）、税金/公金サービス（RKS等）、口座振替、企業名に偶然含まれるケース

   【Few-Shot Examples】
   正例1: 直接送金 → 検出
   取引: 2025-08-15、-50,000円、「ウィンチケット」
   → {"date": "08-15", "amount": -50000, "destination": "ウィンチケット", "keyword": "ウィンチケット"}

   正例2: クレカ経由 → 検出しない
   取引: 2025-08-20、-30,000円、「SMBC カード ウィンチケット」
   → 検出しない（SMBC経由）

   正例3: 企業名偶然含まれる → 検出しない
   取引: 2025-08-10、-100,000円、「マルハニチロ株式会社」
   → 検出しない（食品会社）

   正例4: 決済代行経由 → 検出しない
   取引: 2025-09-05、-20,000円、「GMOペイメント マルハン」
   → 検出しない（GMO経由）

4. 他社ファクタリング業者検出
   - 振込元/振込先名に上記業者リストのいずれかが含まれている取引のみ検出
   - 除外: 「セゾン」「アメックス」「SMBC」はクレジットカード会社・銀行のため検出しない


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
          factoringCompaniesDetected: z.array(z.object({
            companyName: z.string().describe("検出された業者名"),
            date: z.string(),
            amount: z.number(),
            payerOrPayee: z.string().describe("通帳記載の相手先名"),
            transactionType: z.enum(["入金", "出金"]),
          })),
        });
        
        const result = await generateObject({
          model: google("gemini-2.5-flash"),
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

        console.log(`\n${"━".repeat(80)}\n`);
      } else {
        console.log(`\n[Phase 2 - Step 2/4] メイン通帳分析スキップ（ファイルなし）`);
      }
      
      // ========================================
      // ステップ3: サブ通帳AI分析
      // ========================================
      let subBankAnalysis: any = null;
      let subBankAICost = 0;
      
      if (ocrResult.subBankDocuments.length > 0) {
        console.log(`\n[Phase 2 - Step 3/4] サブ通帳AI分析開始`);
        const subBankStartTime = Date.now();
        
        const subBankText = ocrResult.subBankDocuments
          .map(doc => `【${doc.fileName}】\n${doc.text}`)
          .join("\n\n---\n\n");
        
        const subAnalysisPrompt = `サブ通帳（個人口座）を分析し、ギャンブルリスク検出と他社ファクタリング業者検出を行ってください。

# 通帳データ
${subBankText}

# ========================================
# 【重要】他社ファクタリング業者リスト（110社）
# このリストに記載された業者のみ検出対象
# ========================================
${factoringCompanies.map((c, i) => `${i + 1}. ${c}`).join('\n')}

# ========================================
# 【重要】ギャンブル関連キーワード
# このリストに記載されたキーワードのみ検出対象
# ========================================
${gamblingKeywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}

# タスク
1. 全取引を抽出（日付、金額、振込元/先、摘要。入金=プラス、出金=マイナス）

2. ギャンブルリスク検出
   **検出条件:**
   - キーワードが主要部分として含まれる出金取引のみ検出
   - 除外: クレカ/決済代行経由（SMBC、GMO、JCB等）、税金/公金サービス（RKS等）、口座振替、企業名に偶然含まれるケース

   【Few-Shot Examples】
   正例1: 直接送金 → 検出
   取引: 2025-08-15、-50,000円、「ウィンチケット」
   → {"date": "08-15", "amount": -50000, "destination": "ウィンチケット", "keyword": "ウィンチケット"}

   正例2: クレカ経由 → 検出しない
   取引: 2025-08-20、-30,000円、「SMBC カード ウィンチケット」
   → 検出しない（SMBC経由）

   正例3: 企業名偶然含まれる → 検出しない
   取引: 2025-08-10、-100,000円、「マルハニチロ株式会社」
   → 検出しない（食品会社）

   正例4: 決済代行経由 → 検出しない
   取引: 2025-09-05、-20,000円、「GMOペイメント マルハン」
   → 検出しない（GMO経由）

3. 他社ファクタリング業者検出
   - 振込元/振込先名に上記業者リストのいずれかが含まれている取引のみ検出
   - 除外: 「セゾン」「アメックス」「SMBC」はクレジットカード会社・銀行のため検出しない

JSON形式で出力してください。`;

        const subSchema = z.object({
          riskDetection: z.object({
            gambling: z.array(z.object({
              date: z.string(),
              amount: z.number(),
              destination: z.string(),
              keyword: z.enum(gamblingKeywords as [string, ...string[]]).describe("上記ギャンブルキーワードリストから選択（リストにない場合は出力しない）"),
            })),
          }),
          factoringCompaniesDetected: z.array(z.object({
            companyName: z.string().describe("検出された業者名"),
            date: z.string(),
            amount: z.number(),
            payerOrPayee: z.string().describe("通帳記載の相手先名"),
            transactionType: z.enum(["入金", "出金"]),
          })),
        });
        
        const subResult = await generateObject({
          model: google("gemini-2.5-flash"),
          prompt: subAnalysisPrompt,
          schema: subSchema,
        });

        subBankAnalysis = subResult.object;

        const inputTokens = subResult.usage?.inputTokens || Math.ceil(subAnalysisPrompt.length / 4);
        const outputTokens = subResult.usage?.outputTokens || Math.ceil(JSON.stringify(subResult.object).length / 4);
        // GPT-4.1コスト: 入力 $0.000003/token, 出力 $0.000012/token
        subBankAICost = (inputTokens * 0.000003) + (outputTokens * 0.000012);
        
        const subBankDuration = Date.now() - subBankStartTime;
        console.log(`[Phase 2 - Step 3/4] サブ通帳AI分析完了 - 処理時間: ${subBankDuration}ms`);
        
        // 結果表示
        console.log(`\n${"━".repeat(80)}`);
        console.log(`サブ通帳分析結果`);
        console.log(`${"━".repeat(80)}\n`);
        
        console.log(`【リスク検出】\n`);

        console.log(`＜ギャンブル＞`);
        console.log(`  検出ルール: 30種以上（ウィンチケット、マルハン、ダイナム、ベラジョン、競馬、パチンコ等）`);
        if (subBankAnalysis.riskDetection.gambling.length > 0) {
          console.log(`  ⚠️ 検出: ${subBankAnalysis.riskDetection.gambling.length}件`);
          subBankAnalysis.riskDetection.gambling.forEach((g: any, idx: number) => {
            console.log(`    ${idx + 1}. ${g.date}: -¥${Math.abs(g.amount).toLocaleString()} → 「${g.destination}」`);
            console.log(`       一致キーワード: 「${g.keyword}」`);
          });
        } else {
          console.log(`  検出なし`);
        }

        console.log(`\n${"━".repeat(80)}\n`);
      } else {
        console.log(`\n[Phase 2 - Step 3/4] サブ通帳分析スキップ（ファイルなし）`);
      }
      
      // ========================================
      // ステップ4: 統合分析（通帳間資金移動・他社ファクタリング）
      // ========================================
      console.log(`\n[Phase 2 - Step 4/4] 統合分析開始`);

      // 他社ファクタリング業者検出を統合
      const factoringCompaniesDetected: any[] = [];

      // 担保企業名のリストを取得（誤検出を防ぐため）
      const collateralCompanyNames = collaterals.map((c: any) => c.会社名);

      // クレジットカード会社・銀行などの除外リスト
      const excludedCompanies = ["セゾン", "アメックス", "SMBC", "JC", "IB", "AP", "RKS"];

      if (mainBankAnalysis && mainBankAnalysis.factoringCompaniesDetected) {
        // 担保企業とクレジットカード会社・銀行を除外
        const filtered = mainBankAnalysis.factoringCompaniesDetected.filter((f: any) => {
          const isCollateral = collateralCompanyNames.some((name: string) =>
            f.companyName.includes(name) || name.includes(f.companyName)
          );
          const isExcluded = excludedCompanies.some((excluded: string) =>
            f.companyName.includes(excluded) || f.payerOrPayee.includes(excluded)
          );
          return !isCollateral && !isExcluded;
        });
        factoringCompaniesDetected.push(...filtered);
      }

      if (subBankAnalysis && subBankAnalysis.factoringCompaniesDetected) {
        // 担保企業とクレジットカード会社・銀行を除外
        const filtered = subBankAnalysis.factoringCompaniesDetected.filter((f: any) => {
          const isCollateral = collateralCompanyNames.some((name: string) =>
            f.companyName.includes(name) || name.includes(f.companyName)
          );
          const isExcluded = excludedCompanies.some((excluded: string) =>
            f.companyName.includes(excluded) || f.payerOrPayee.includes(excluded)
          );
          return !isCollateral && !isExcluded;
        });
        factoringCompaniesDetected.push(...filtered);
      }

      // 通帳間資金移動検出（メイン通帳とサブ通帳の両方がある場合のみ）
      const crossBankTransfers: any[] = [];

      if (mainBankAnalysis && subBankAnalysis) {
        // TODO: 将来的に実装
        // メイン通帳の出金とサブ通帳の入金を照合
        // 前後1日以内、±1,000円以内の取引をペアリング
        console.log(`  ⚠️ 通帳間資金移動検出: 未実装（Phase 4で対応予定）`);
      } else {
        // メイン通帳のみまたはサブ通帳のみの場合は通帳間移動は不可能
        console.log(`  通帳間資金移動検出: スキップ（サブ通帳なし）`);
      }

      console.log(`[Phase 2 - Step 4/4] 統合分析完了`);
      console.log(`  - 通帳間資金移動: ${crossBankTransfers.length}件`);
      console.log(`  - 他社ファクタリング: ${factoringCompaniesDetected.length}件`);
      
      if (crossBankTransfers.length > 0 || factoringCompaniesDetected.length > 0) {
        console.log(`\n${"━".repeat(80)}`);
        console.log(`統合分析結果`);
        console.log(`${"━".repeat(80)}\n`);
        
        if (crossBankTransfers.length > 0) {
          console.log(`【通帳間資金移動】`);
          console.log(`  検出ルール: 前後1日以内、±1,000円以内の入出金\n`);
          crossBankTransfers.forEach((t, idx) => {
            console.log(`  ${idx + 1}. ${t.date}: ¥${t.amount.toLocaleString()}`);
            console.log(`     ${t.from} → ${t.to}`);
          });
          console.log();
        }
        
        if (factoringCompaniesDetected.length > 0) {
          console.log(`【他社ファクタリング業者検出】`);
          console.log(`  検出ルール: 110社の業者リストと照合（GMO、OLTA、ビートレーディング、ペイトナー等）\n`);
          console.log(`  ⚠️ 検出: ${factoringCompaniesDetected.length}件`);
          factoringCompaniesDetected.forEach((f, idx) => {
            const sign = f.transactionType === "入金" ? "+" : "-";
            console.log(`    ${idx + 1}. ${f.date}: ${sign}¥${Math.abs(f.amount).toLocaleString()} (${f.transactionType})`);
            console.log(`       業者名: 「${f.companyName}」`);
            console.log(`       通帳記載: 「${f.payerOrPayee}」`);
          });
        }
        
        console.log(`\n${"━".repeat(80)}\n`);
      }
      
      // ========================================
      // 結果のサマリー生成
      // ========================================
      const totalDuration = Date.now() - startTime;
      const totalCost = ocrResult.costAnalysis.googleVisionCost + mainBankAICost + subBankAICost;

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Phase 2 処理完了`);
      console.log(`  処理時間: ${(totalDuration / 1000).toFixed(2)}秒`);
      console.log(`  総コスト: $${totalCost.toFixed(4)}`);
      if (mainBankAnalysis) {
        const totalMatches = mainBankAnalysis.collateralMatches.length;
        const matchedCount = mainBankAnalysis.collateralMatches.filter((m: any) =>
          m.monthlyAnalysis.some((ma: any) => ma.matched)
        ).length;
        const gamblingTotal = mainBankAnalysis.riskDetection.gambling.length +
          (subBankAnalysis?.riskDetection.gambling.length || 0);
        console.log(`  担保企業照合: ${matchedCount}/${totalMatches}社`);
        console.log(`  ギャンブル検出: ${gamblingTotal}件`);
      }
      console.log(`  通帳間資金移動: ${crossBankTransfers.length}件`);
      console.log(`  他社ファクタリング: ${factoringCompaniesDetected.length}件`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // 簡潔でわかりやすい出力構造
      return {
        recordId,
        phase1Results, // Phase 1の結果を引き継ぎ
        phase2Results: {
          mainBankAnalysis: mainBankAnalysis ? {
            collateralMatches: mainBankAnalysis.collateralMatches.map((match: any) => ({
              company: match.company,
              allTransactions: match.allTransactions || [],
              expectedValues: match.expectedValues || [],
              monthlyResults: match.monthlyAnalysis.map((ma: any) => ({
                month: ma.month,
                expected: ma.expectedAmount,
                actual: ma.totalMatched,
                actualSource: ma.actualSource || "不明",
                matched: ma.matched,
                matchType: ma.matchType,
                matchedTransactions: ma.matchedTransactions || [],
                unmatchedTransactions: ma.unmatchedTransactions || [],
              })),
            })),
            riskDetection: mainBankAnalysis.riskDetection,
          } : undefined,
          subBankAnalysis: subBankAnalysis ? {
            riskDetection: subBankAnalysis.riskDetection,
          } : undefined,
          crossBankTransfers,
          factoringCompanies: factoringCompaniesDetected.map((f: any) => ({
            companyName: f.companyName,
            date: f.date,
            amount: f.amount,
            transactionType: f.transactionType,
          })),
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
