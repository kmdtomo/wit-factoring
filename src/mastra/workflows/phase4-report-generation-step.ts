import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { kintonePhase4DataTool } from "../tools/kintone-phase4-data-tool";
import fs from "fs";
import path from "path";

/**
 * Phase 4: 審査レポート生成ステップ（新バージョン）
 *
 * 処理フロー:
 * 1. Kintoneデータ取得（全テーブル）
 * 2. プロンプト・テンプレート読み込み
 * 3. GPT-4.1による包括的レポート生成
 * 4. Markdownレポート出力
 */
export const phase4ReportGenerationStep = createStep({
  id: "phase4-report-generation",
  description: "Phase 1-3の結果とKintoneデータを統合し、AIによる審査レポートを生成",

  inputSchema: z.object({
    "phase1-purchase-collateral": z.any().optional().describe("Phase 1の結果（買取・担保情報）"),
    "phase2-bank-statement": z.any().optional().describe("Phase 2の結果（通帳分析）"),
    "phase3-verification": z.any().optional().describe("Phase 3の結果（本人確認・企業実在性）"),
  }),

  outputSchema: z.object({
    recordId: z.string(),

    // Kintone用フィールド1: リスク評価＋総評（HTML）
    riskSummaryHtml: z.string().describe("リスク評価と総評 - HTML形式（Kintoneリッチエディタ用）"),

    // Kintone用フィールド2: 分析詳細（HTML）
    detailedAnalysisHtml: z.string().describe("詳細分析レポート - HTML形式（Kintoneリッチエディタ用）"),

    processingTime: z.string().describe("処理時間"),
    phase4Results: z.any(),
  }),

  execute: async ({ inputData, runId }) => {
    const startTime = Date.now();

    // 並列実行の結果を取得（各ステップIDでネームスペース化されている）
    const phase1Data = inputData["phase1-purchase-collateral"];
    const phase2Data = inputData["phase2-bank-statement"];
    const phase3Data = inputData["phase3-verification"];

    // recordIdは並列実行結果から取得（Phase 1から）
    const recordId = phase1Data?.recordId || phase2Data?.recordId || phase3Data?.recordId;

    // 実際のphaseResultsを抽出
    const phase1Results = phase1Data?.phase1Results || phase1Data;
    const phase2Results = phase2Data?.phase2Results || phase2Data;
    const phase3Results = phase3Data?.phase3Results || phase3Data;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`[Phase 4] 審査レポート生成開始 - recordId: ${recordId}`);
    console.log(`${"=".repeat(80)}\n`);

    // デバッグ: Phase 1-3データの受信確認
    console.log(`[Phase 4 - Debug] Phase 1 データ有無: ${phase1Results ? 'あり' : 'なし'}`);
    console.log(`[Phase 4 - Debug] Phase 2 データ有無: ${phase2Results ? 'あり' : 'なし'}`);
    console.log(`[Phase 4 - Debug] Phase 3 データ有無: ${phase3Results ? 'あり' : 'なし'}`);
    if (phase1Results) {
      console.log(`[Phase 4 - Debug] Phase 1 キー:`, Object.keys(phase1Results));
    }
    if (phase2Results) {
      console.log(`[Phase 4 - Debug] Phase 2 キー:`, Object.keys(phase2Results));
    }
    if (phase3Results) {
      console.log(`[Phase 4 - Debug] Phase 3 キー:`, Object.keys(phase3Results));
    }

    try {
      // ========================================
      // Step 1: Kintoneデータ取得
      // ========================================
      console.log(`[Phase 4 - Step 1/4] Kintoneデータ取得`);

      const kintoneResult = await kintonePhase4DataTool.execute({
        context: { recordId },
        runId: runId || "phase4-run",
        runtimeContext: new RuntimeContext(),
      });

      if (!kintoneResult.success) {
        throw new Error(`Kintoneデータ取得失敗: ${kintoneResult.error}`);
      }

      const kintoneData = kintoneResult.data;
      console.log(`  ✅ Kintoneデータ取得完了`);

      // ========================================
      // Step 2: プロンプト・テンプレート読み込み
      // ========================================
      console.log(`\n[Phase 4 - Step 2/4] プロンプト・テンプレート読み込み`);

      // プロジェクトルートを取得（.mastra/outputから2階層上）
      const projectRoot = path.resolve(process.cwd(), '..', '..');
      const promptPath = path.join(projectRoot, 'docs', 'phase4-prompt-balanced.md');
      const templatePath = path.join(projectRoot, 'docs', 'ideal-phase4-report-template.html');

      console.log(`  📂 プロジェクトルート: ${projectRoot}`);
      console.log(`  📄 プロンプトパス: ${promptPath}`);
      console.log(`  📄 テンプレートパス: ${templatePath}`);

      if (!fs.existsSync(promptPath)) {
        throw new Error(`プロンプトファイルが見つかりません: ${promptPath}`);
      }
      if (!fs.existsSync(templatePath)) {
        throw new Error(`テンプレートファイルが見つかりません: ${templatePath}`);
      }

      const promptContent = fs.readFileSync(promptPath, 'utf-8');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      console.log(`  ✅ プロンプト読み込み完了: ${promptContent.length}文字`);
      console.log(`  ✅ テンプレート読み込み完了: ${templateContent.length}文字`);

      // ========================================
      // Step 3: 入力データ構築
      // ========================================
      console.log(`\n[Phase 4 - Step 3/4] 入力データ構築`);

      const inputDataForAI = buildInputData(
        recordId,
        phase1Results,
        phase2Results,
        phase3Results,
        kintoneData
      );

      console.log(`  ✅ 入力データ構築完了`);

      // ========================================
      // Step 4: GPT-4.1によるレポート生成
      // ========================================
      console.log(`\n[Phase 4 - Step 4/4] GPT-4.1によるレポート生成`);

      const fullPrompt = buildFullPrompt(
        promptContent,
        templateContent,
        inputDataForAI
      );

      console.log(`  📊 プロンプト総文字数: ${fullPrompt.length}文字`);
      console.log(`  🤖 GPT-4.1にリクエスト中...`);

      const aiStartTime = Date.now();

      const result = await generateText({
        model: openai("gpt-4.1-2025-04-14"),
        prompt: fullPrompt,
        temperature: 0.3,
      });

      const aiDuration = Date.now() - aiStartTime;
      console.log(`  ✅ AI処理完了: ${(aiDuration / 1000).toFixed(2)}秒`);

      const reportHtml = result.text;

      // ========================================
      // HTMLレポートを2つのセクションに分割
      // ========================================
      console.log(`\n[Phase 4 - Post Processing] HTMLレポート分割処理`);

      const { riskSummaryHtml, detailedAnalysisHtml } = splitHtmlReportForKintone(reportHtml);

      console.log(`  ✅ リスク評価＋総評（HTML）: ${riskSummaryHtml.length}文字`);
      console.log(`  ✅ 分析詳細（HTML）: ${detailedAnalysisHtml.length}文字`);

      // HTMLレポートをファイルに保存（プロジェクトルートのdocsに保存）
      const reportPath = path.join(projectRoot, 'docs', `phase4-report-${recordId}.html`);
      fs.writeFileSync(reportPath, reportHtml, 'utf-8');
      console.log(`  💾 HTMLレポート保存: ${reportPath}`);

      const totalDuration = Date.now() - startTime;

      // ========================================
      // レポート内容をコンソールに出力
      // ========================================
      console.log(`\n${"=".repeat(80)}`);
      console.log(`📄 生成されたHTMLレポート - Record ID: ${recordId}`);
      console.log(`${"=".repeat(80)}\n`);
      console.log(reportHtml.substring(0, 500) + '...（省略）');
      console.log(`\n${"=".repeat(80)}`);

      console.log(`\n${"=".repeat(80)}`);
      console.log(`[Phase 4] 審査レポート生成完了 - 処理時間: ${(totalDuration / 1000).toFixed(2)}秒`);
      console.log(`${"=".repeat(80)}\n`);

      return {
        recordId,
        phase1Results, // Phase 1の結果を引き継ぎ
        phase2Results, // Phase 2の結果を引き継ぎ
        phase3Results, // Phase 3の結果を引き継ぎ

        // Kintone用フィールド（HTML形式）
        riskSummaryHtml,
        detailedAnalysisHtml,

        processingTime: `${(totalDuration / 1000).toFixed(2)}秒`,
        phase4Results: {
          kintoneData,
          reportPath,
          aiProcessingTime: `${(aiDuration / 1000).toFixed(2)}秒`,
          reportLength: reportHtml.length,
          riskSummaryHtmlLength: riskSummaryHtml.length,
          detailedAnalysisHtmlLength: detailedAnalysisHtml.length,
        },
      };

    } catch (error: any) {
      console.error(`\n[Phase 4] エラー発生:`, error.message);
      throw new Error(`Phase 4 処理失敗: ${error.message}`);
    }
  },
});

// ========================================
// ヘルパー関数
// ========================================

/**
 * 入力データ構築
 * Phase 1-3の実際の出力スキーマに基づいて構築
 */
function buildInputData(
  recordId: string,
  phase1Results: any,
  phase2Results: any,
  phase3Results: any,
  kintoneData: any
): any {
  return {
    recordId,

    // Phase 1: 買取・担保情報（実際のスキーマに合わせる）
    phase1: {
      // 買取書類（purchaseDocuments）
      purchaseDocuments: phase1Results?.purchaseDocuments || [],

      // 担保書類（collateralDocuments）
      collateralDocuments: phase1Results?.collateralDocuments || [],

      // 買取検証結果（purchaseVerification）
      purchaseVerification: phase1Results?.purchaseVerification || {
        kintoneMatch: "不一致",
      },

      // 担保情報抽出（collateralExtraction）
      collateralExtraction: phase1Results?.collateralExtraction || {
        findings: [],
      },
    },

    // Phase 2: 通帳分析（実際のスキーマに合わせる）
    phase2: {
      // メイン通帳分析（mainBankAnalysis）
      mainBankAnalysis: phase2Results?.mainBankAnalysis || {
        collateralMatches: [],
        riskDetection: {
          gambling: [],
          otherFactoring: [],
          largeCashWithdrawals: [],
        },
      },

      // ファクタリング業者リスト
      factoringCompanies: phase2Results?.factoringCompanies || [],
    },

    // Phase 3: 本人確認・企業実在性（実際のスキーマに合わせる）
    phase3: {
      // 本人確認（本人確認）
      本人確認: phase3Results?.本人確認 || {
        書類タイプ: "なし",
        照合結果: "未実施",
        検出人数: 0,
        一致人数: 0,
      },

      // 申込者エゴサーチ（申込者エゴサーチ）
      申込者エゴサーチ: phase3Results?.申込者エゴサーチ || {
        ネガティブ情報: false,
        詐欺情報サイト: 0,
        Web検索: 0,
        詳細: "Phase 3未実行",
      },

      // 企業実在性（企業実在性）
      企業実在性: phase3Results?.企業実在性 || {
        申込企業: { 企業名: "", 公式サイト: null, 信頼度: 0 },
        買取企業: { 総数: 0, 確認済み: 0, 未確認: 0, 企業リスト: [] },
        担保企業: { 総数: 0, 確認済み: 0, 未確認: 0, 企業リスト: [] },
      },

      // 代表者リスク（代表者リスク）
      代表者リスク: phase3Results?.代表者リスク || {
        検索対象: 0,
        リスク検出: 0,
      },
    },

    // Kintoneデータ
    kintone: kintoneData,
  };
}

/**
 * 完全なプロンプト構築
 */
function buildFullPrompt(
  promptContent: string,
  templateContent: string,
  inputData: any
): string {
  return `
${promptContent}

---

## 出力例（この構造に従ってください）

${templateContent}

---

## 入力データ

以下のデータを使用して、上記のテンプレートに従ったレポートを生成してください。

### Record ID
${inputData.recordId}

### Phase 1 結果（買取・担保情報）

#### 買取書類（purchaseDocuments）

${JSON.stringify(inputData.phase1.purchaseDocuments, null, 2)}

#### 担保書類（collateralDocuments）

${JSON.stringify(inputData.phase1.collateralDocuments, null, 2)}

#### 買取検証結果（purchaseVerification）

${JSON.stringify(inputData.phase1.purchaseVerification, null, 2)}

#### 担保情報抽出（collateralExtraction）

${JSON.stringify(inputData.phase1.collateralExtraction, null, 2)}

---

### Phase 2 結果（通帳分析）

#### メイン通帳分析

${JSON.stringify(inputData.phase2.mainBankAnalysis, null, 2)}

#### ファクタリング業者リスト

${JSON.stringify(inputData.phase2.factoringCompanies, null, 2)}

---

### Phase 3 結果（本人確認・企業実在性）

#### 本人確認

${JSON.stringify(inputData.phase3.本人確認, null, 2)}

#### 申込者エゴサーチ

${JSON.stringify(inputData.phase3.申込者エゴサーチ, null, 2)}

#### 企業実在性

${JSON.stringify(inputData.phase3.企業実在性, null, 2)}

#### 代表者リスク

${JSON.stringify(inputData.phase3.代表者リスク, null, 2)}

---

### Kintoneデータ

#### 基本情報

${JSON.stringify(inputData.kintone.基本情報, null, 2)}

#### 財務・リスク情報

${JSON.stringify(inputData.kintone.財務リスク情報, null, 2)}

#### 買取情報テーブル

${JSON.stringify(inputData.kintone.買取情報, null, 2)}

#### 担保情報テーブル

${JSON.stringify(inputData.kintone.担保情報, null, 2)}

#### 謄本情報テーブル

${JSON.stringify(inputData.kintone.謄本情報, null, 2)}

#### 期待値テーブル（通帳照合用）

${JSON.stringify(inputData.kintone.期待値, null, 2)}

#### 回収情報テーブル

${JSON.stringify(inputData.kintone.回収情報, null, 2)}

---

上記のデータを分析し、テンプレートに従って完全なHTML形式の審査レポートを生成してください。
`;
}

/**
 * HTMLレポートをKintone用の2つのフィールドに分割
 */
function splitHtmlReportForKintone(reportHtml: string): {
  riskSummaryHtml: string;
  detailedAnalysisHtml: string;
} {
  // "<h2>総合評価</h2>" から "<h2>1. 買取企業分析</h2>" の前までを抽出
  const summaryMatch = reportHtml.match(/<h2>総合評価<\/h2>[\s\S]*?(?=<h2>1\. 買取企業分析<\/h2>)/);
  const riskSummaryHtml = summaryMatch
    ? summaryMatch[0].trim()
    : reportHtml.split('<hr>')[0] || reportHtml.substring(0, 1000);

  // "<h2>1. 買取企業分析</h2>" 以降を抽出
  const detailsMatch = reportHtml.match(/<h2>1\. 買取企業分析<\/h2>[\s\S]*/);
  const detailedAnalysisHtml = detailsMatch
    ? detailsMatch[0].trim()
    : reportHtml;

  return {
    riskSummaryHtml,
    detailedAnalysisHtml
  };
}
