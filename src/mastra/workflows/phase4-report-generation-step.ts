import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { kintonePhase4DataTool } from "../tools/kintone-phase4-data-tool";
import { phase4PromptContent, phase4TemplateContent } from "./phase4-prompts";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

/**
 * Phase 4: 審査レポート生成ステップ（新バージョン）
 *
 * 処理フロー:
 * 1. Kintoneデータ取得（全テーブル）
 * 2. プロンプト・テンプレート読み込み
 * 3. Gemini 2.5 Proによる包括的レポート生成
 * 4. HTMLレポート出力
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

    // Phase 1-3の結果（引き継ぎ）
    phase1Results: z.any().optional(),
    phase2Results: z.any().optional(),
    phase3Results: z.any().optional(),

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

      // phase4-prompts.tsからインポート（ファイルシステムアクセス不要）
      const promptContent = phase4PromptContent;
      const templateContent = phase4TemplateContent;

      const totalLength = promptContent.length + templateContent.length;
      console.log(`  ✅ 埋め込みプロンプト+テンプレート読み込み完了: ${totalLength}文字 (プロンプト: ${promptContent.length}, テンプレート: ${templateContent.length})`);
      console.log(`  🔍 [DEBUG] ソース: phase4-prompts.ts (埋め込み版)`);
      console.log(`  🔍 [DEBUG] プロンプト開始: "${promptContent.substring(0, 50)}..."`);

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
      console.log(`  🤖 Gemini 2.5 Proにリクエスト中...`);

      const aiStartTime = Date.now();

      const result = await generateText({
        model: google("gemini-2.5-pro"),
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

      // HTMLレポートは結果として返すのみ（ファイル保存はしない）
      const reportPath = `phase4-report-${recordId}.html (メモリ内)`;
      console.log(`  📄 HTMLレポート生成完了: ${reportPath}`);

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
        },
      },

      // 他社ファクタリング分析
      factoringAnalysis: phase2Results?.factoringAnalysis || {
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
        ネガティブURL一覧: undefined,
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
 * 完全なプロンプト構築（Markdown形式で最適化）
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

---

### Phase 1 結果（買取・担保情報）

${formatPhase1Data(inputData.phase1)}

---

### Phase 2 結果（通帳分析）

${formatPhase2Data(inputData.phase2)}

---

### Phase 3 結果（本人確認・企業実在性）

${formatPhase3Data(inputData.phase3)}

---

### Kintoneデータ

${formatKintoneData(inputData.kintone)}

---

上記のデータを分析し、テンプレートに従って完全なHTML形式の審査レポートを生成してください。
`;
}

// ========================================
// データフォーマット関数（Markdown形式）
// ========================================

/**
 * Phase 1データをMarkdown形式にフォーマット
 */
function formatPhase1Data(phase1: any): string {
  let output = '';

  // 買取書類
  output += '#### 買取書類\n\n';
  if (phase1.purchaseDocuments && phase1.purchaseDocuments.length > 0) {
    phase1.purchaseDocuments.forEach((doc: any) => {
      output += `**📄 ${doc.fileName}**\n`;
      output += `- 文書タイプ: ${doc.documentType}\n`;

      const facts = doc.extractedFacts || {};
      if (facts.請求元) output += `- 請求元: ${facts.請求元}\n`;
      if (facts.請求先) output += `- 請求先: ${facts.請求先}\n`;
      if (facts.請求額) output += `- 請求額: ${facts.請求額}\n`;
      if (facts.請求日) output += `- 請求日: ${facts.請求日}\n`;
      if (facts.支払期日) output += `- 支払期日: ${facts.支払期日}\n`;
      if (facts.業務内容) output += `- 業務内容: ${facts.業務内容}\n`;
      if (facts.工期) output += `- 工期: ${facts.工期}\n`;
      if (facts.振込先) output += `- 振込先: ${facts.振込先}\n`;

      output += '\n';
    });
  } else {
    output += '⚠️ 買取書類なし\n\n';
  }

  // 担保書類
  output += '#### 担保書類\n\n';
  if (phase1.collateralDocuments && phase1.collateralDocuments.length > 0) {
    phase1.collateralDocuments.forEach((doc: any) => {
      output += `**📄 ${doc.fileName}**\n`;
      output += `- 文書タイプ: ${doc.documentType}\n`;

      const facts = doc.extractedFacts || {};
      if (facts.会社名) output += `- 会社名: ${facts.会社名}\n`;
      if (facts.資本金) output += `- 資本金: ${facts.資本金}\n`;
      if (facts.設立年月日) output += `- 設立年月日: ${facts.設立年月日}\n`;
      if (facts.代表取締役) output += `- 代表取締役: ${facts.代表取締役}\n`;
      if (facts.本店所在地) output += `- 本店所在地: ${facts.本店所在地}\n`;

      output += '\n';
    });
  } else {
    output += '⚠️ 担保書類なし\n\n';
  }

  // 買取検証結果
  output += '#### 買取検証結果\n\n';
  output += `- Kintone照合: **${phase1.purchaseVerification?.kintoneMatch || '不一致'}**\n\n`;

  // 担保情報抽出
  output += '#### 担保情報抽出\n\n';
  if (phase1.collateralExtraction?.findings && phase1.collateralExtraction.findings.length > 0) {
    phase1.collateralExtraction.findings.forEach((finding: string, idx: number) => {
      output += `${idx + 1}. ${finding}\n`;
    });
  } else {
    output += '⚠️ 担保情報抽出なし（担保謄本ファイルが未提出の可能性）\n';
  }

  return output;
}

/**
 * Phase 2データをMarkdown形式にフォーマット
 */
function formatPhase2Data(phase2: any): string {
  let output = '';

  // メイン通帳分析
  output += '#### メイン通帳分析\n\n';

  const mainBank = phase2.mainBankAnalysis;
  if (mainBank && mainBank.collateralMatches && mainBank.collateralMatches.length > 0) {
    output += '**担保企業からの入金照合結果:**\n\n';

    mainBank.collateralMatches.forEach((match: any) => {
      output += `##### ${match.company}\n\n`;

      // 月次照合結果
      if (match.monthlyResults && match.monthlyResults.length > 0) {
        output += '| 月 | 期待値 | 実績 | 照合結果 | タイプ |\n';
        output += '|----|--------|------|----------|--------|\n';

        match.monthlyResults.forEach((result: any) => {
          const icon = result.matched ? '✅' : '❌';
          output += `| ${result.month} | ¥${result.expected.toLocaleString()} | ¥${result.actual.toLocaleString()} | ${icon} ${result.matched ? '一致' : '不一致'} | ${result.matchType} |\n`;
        });
        output += '\n';
      }
    });
  } else {
    output += '⚠️ メイン通帳データなし\n\n';
  }

  // ギャンブル検出
  output += '**ギャンブル検出:**\n\n';
  const gambling = mainBank?.riskDetection?.gambling || [];
  if (gambling.length > 0) {
    output += `⚠️ ${gambling.length}件検出\n\n`;
    output += '| 日付 | 金額 | 振込先 | キーワード |\n';
    output += '|------|------|--------|------------|\n';
    gambling.forEach((g: any) => {
      output += `| ${g.date} | -¥${Math.abs(g.amount).toLocaleString()} | ${g.destination} | ${g.keyword} |\n`;
    });
    output += '\n';
  } else {
    output += '✅ 検出なし\n\n';
  }

  // 他社ファクタリング取引分析
  output += '**他社ファクタリング取引分析:**\n\n';
  const factoringAnalysis = phase2.factoringAnalysis;

  if (factoringAnalysis && factoringAnalysis.summary.totalCompanies > 0) {
    output += `検出業者数: ${factoringAnalysis.summary.totalCompanies}社\n`;
    output += `完済済み: ${factoringAnalysis.summary.completedContracts}社\n`;
    output += `契約中の可能性: ${factoringAnalysis.summary.activeContracts}社\n\n`;

    // 業者別分析
    if (factoringAnalysis.companyAnalysis && factoringAnalysis.companyAnalysis.length > 0) {
      output += '| 業者名 | 入金 | 出金 | 状態 | 確認事項 |\n';
      output += '|--------|------|------|------|----------|\n';

      factoringAnalysis.companyAnalysis.forEach((company: any) => {
        const inboundCount = company.inboundTransactions.length;
        const outboundCount = company.outboundTransactions.length;
        const inboundTotal = company.inboundTransactions.reduce((sum: number, tx: any) => sum + tx.amount, 0);
        const outboundTotal = company.outboundTransactions.reduce((sum: number, tx: any) => sum + tx.amount, 0);

        const statusIcon = company.actualStatus === '完済済み' ? '✅' : '⚠️';

        let note = '';
        if (company.unpairedInbound && company.unpairedInbound.length > 0) {
          note = company.unpairedInbound[0].note;
        }

        output += `| ${company.companyName} | ${inboundCount}件 (¥${inboundTotal.toLocaleString()}) | ${outboundCount}件 (¥${outboundTotal.toLocaleString()}) | ${statusIcon} ${company.actualStatus} | ${note} |\n`;
      });
      output += '\n';
    }

    // アラート
    if (factoringAnalysis.alerts && factoringAnalysis.alerts.length > 0) {
      output += '**🚨 アラート:**\n\n';
      factoringAnalysis.alerts.forEach((alert: any) => {
        const icon = alert.severity === '警告' ? '🚨' : '⚠️';
        output += `${icon} **${alert.type}**: ${alert.message}\n`;
        output += `- 詳細: ${alert.details}\n\n`;
      });
    }
  } else {
    output += '✅ 検出なし\n\n';
  }

  return output;
}

/**
 * Phase 3データをMarkdown形式にフォーマット
 */
function formatPhase3Data(phase3: any): string {
  let output = '';

  // 本人確認
  output += '#### 本人確認\n\n';
  const identity = phase3.本人確認 || {};
  output += `- 書類タイプ: ${identity.書類タイプ || 'なし'}\n`;
  output += `- 照合結果: ${identity.照合結果 || '未実施'}\n`;
  output += `- 検出人数: ${identity.検出人数 || 0}人\n`;
  output += `- 一致人数: ${identity.一致人数 || 0}人\n`;

  // OCR抽出値とKintone期待値の詳細比較
  if (identity.抽出された人物情報 && identity.抽出された人物情報.length > 0) {
    const person = identity.抽出された人物情報[0]; // 最初の人物を表示
    output += '\n**OCRで抽出された人物情報:**\n';
    output += `- 氏名: ${person.氏名 || '不明'}\n`;
    output += `- 生年月日: ${person.生年月日 || '不明'}\n`;
    output += `- 住所: ${person.住所 || '不明'}\n`;
    
    output += '\n**Kintone期待値との照合:**\n';
    
    // 氏名照合
    if (identity.Kintone期待値?.代表者名) {
      if (person.氏名一致) {
        output += `- ✅ 氏名一致（${person.氏名}）\n`;
      } else {
        output += `- ❌ 氏名不一致（OCR抽出: ${person.氏名} / Kintone期待値: ${identity.Kintone期待値.代表者名}）→ OCRの読み取りミスの可能性あり。要目視確認\n`;
      }
    }
    
    // 生年月日照合
    if (identity.Kintone期待値?.生年月日) {
      if (person.生年月日一致) {
        output += `- ✅ 生年月日一致（${person.生年月日}）\n`;
      } else {
        output += `- ❌ 生年月日不一致（OCR抽出: ${person.生年月日} / Kintone期待値: ${identity.Kintone期待値.生年月日}）\n`;
      }
    }
    
    // 住所照合（一致判定がない場合は表示のみ）
    if (person.住所) {
      output += `- ✅ 住所: ${person.住所}\n`;
    }
  } else if (identity.一致人物) {
    // 旧形式の対応（一致人物のみ表示）
    output += '\n**一致した人物:**\n';
    output += `- 氏名: ${identity.一致人物.氏名}\n`;
    output += `- 生年月日: ${identity.一致人物.生年月日}\n`;
    output += `- 住所: ${identity.一致人物.住所}\n`;
  }
  output += '\n';

  // 申込者エゴサーチ
  output += '#### 申込者エゴサーチ\n\n';
  const ego = phase3.申込者エゴサーチ || {};
  output += `- ネガティブ情報: ${ego.ネガティブ情報 ? '⚠️ あり' : '✅ なし'}\n`;
  output += `- 詐欺情報サイト: ${ego.詐欺情報サイト || 0}件\n`;
  output += `- Web検索: ${ego.Web検索 || 0}件\n`;
  output += `- 詳細: ${ego.詳細 || 'なし'}\n`;

  // 【重要】ネガティブURL一覧を全て表示（URLのみ）
  if (ego.ネガティブURL一覧 && ego.ネガティブURL一覧.length > 0) {
    output += `- **ネガティブURL一覧（全${ego.ネガティブURL一覧.length}件）**:\n`;
    ego.ネガティブURL一覧.forEach((urlInfo: any, index: number) => {
      output += `  ${index + 1}. ${urlInfo.URL}\n`;
    });
  }
  output += '\n';

  // 企業実在性
  output += '#### 企業実在性\n\n';
  const companies = phase3.企業実在性 || {};

  // 申込企業
  if (companies.申込企業) {
    output += '**申込企業:**\n';
    output += `- 企業名: ${companies.申込企業.企業名 || '不明'}\n`;
    output += `- 公式サイト: ${companies.申込企業.公式サイト || 'なし'}\n`;
    output += `- 確認方法: ${companies.申込企業.確認方法 || '未確認'}\n`;
    output += `- 確認元URL: ${companies.申込企業.確認元URL || 'なし'}\n`;
    output += `- 信頼度: ${companies.申込企業.信頼度}%\n\n`;
  }

  // 買取企業
  if (companies.買取企業) {
    output += '**買取企業:**\n';
    output += `- 総数: ${companies.買取企業.総数}社\n`;
    output += `- 確認済み: ${companies.買取企業.確認済み}社\n`;
    output += `- 未確認: ${companies.買取企業.未確認}社\n`;

    if (companies.買取企業.企業リスト && companies.買取企業.企業リスト.length > 0) {
      output += '\n| 企業名 | 公式サイト | 確認方法 | 確認元URL | 信頼度 |\n';
      output += '|--------|-----------|----------|----------|--------|\n';
      companies.買取企業.企業リスト.forEach((c: any) => {
        output += `| ${c.企業名} | ${c.公式サイト || 'なし'} | ${c.確認方法 || '未確認'} | ${c.確認元URL || 'なし'} | ${c.信頼度}% |\n`;
      });
    }
    output += '\n';
  }

  // 担保企業
  if (companies.担保企業) {
    output += '**担保企業:**\n';
    output += `- 総数: ${companies.担保企業.総数}社\n`;
    output += `- 確認済み: ${companies.担保企業.確認済み}社\n`;
    output += `- 未確認: ${companies.担保企業.未確認}社\n`;

    if (companies.担保企業.企業リスト && companies.担保企業.企業リスト.length > 0) {
      output += '\n| 企業名 | 公式サイト | 確認方法 | 確認元URL | 信頼度 |\n';
      output += '|--------|-----------|----------|----------|--------|\n';
      companies.担保企業.企業リスト.forEach((c: any) => {
        output += `| ${c.企業名} | ${c.公式サイト || 'なし'} | ${c.確認方法 || '未確認'} | ${c.確認元URL || 'なし'} | ${c.信頼度}% |\n`;
      });
    }
    output += '\n';
  }

  // 代表者リスク
  output += '#### 代表者リスク\n\n';
  const rep = phase3.代表者リスク || {};
  output += `- 検索対象: ${rep.検索対象 || 0}名\n`;
  output += `- リスク検出: ${rep.リスク検出 || 0}名\n`;

  return output;
}

/**
 * KintoneデータをMarkdown形式にフォーマット
 */
function formatKintoneData(kintone: any): string {
  let output = '';

  // 基本情報
  output += '#### 基本情報\n\n';
  const basic = kintone.基本情報 || {};
  if (basic.氏名) output += `- 氏名: ${basic.氏名}\n`;
  if (basic.生年月日) output += `- 生年月日: ${basic.生年月日}\n`;
  if (basic.年齢) output += `- 年齢: ${basic.年齢}歳\n`;
  if (basic.住所) output += `- 住所: ${basic.住所}\n`;
  if (basic.種別) output += `- 種別: ${basic.種別}\n`;
  if (basic.屋号) output += `- 屋号: ${basic.屋号}\n`;
  if (basic.会社名) output += `- 会社名: ${basic.会社名}\n`;
  if (basic.設立年) output += `- 設立年: ${basic.設立年}\n`;
  if (basic.業種) output += `- 業種: ${basic.業種}\n`;
  if (basic.売上) output += `- 売上: ${basic.売上}\n`;
  output += '\n';

  // 財務・リスク情報
  output += '#### 財務・リスク情報\n\n';
  const finance = kintone.財務リスク情報 || {};
  if (finance.資金使途) output += `- 資金使途: ${finance.資金使途}\n`;
  if (finance.ファクタリング利用) output += `- ファクタリング利用: ${finance.ファクタリング利用}\n`;
  if (finance.税金滞納額 !== undefined) output += `- 税金滞納額: ¥${finance.税金滞納額.toLocaleString()}\n`;
  if (finance.保険料滞納額 !== undefined) output += `- 保険料滞納額: ¥${finance.保険料滞納額.toLocaleString()}\n`;
  output += '\n';

  // 買取情報テーブル
  output += '#### 買取情報テーブル\n\n';
  output += '**【重要】掛目は必ずこのテーブルの「掛目」フィールドの値を使用してください。買取額÷請求額を計算しないでください。**\n\n';
  const purchase = kintone.買取情報 || [];
  if (purchase.length > 0) {
    output += '| 企業名 | 買取額 | 請求額 | 掛目（★この値を使用★） | 再契約の意思 |\n';
    output += '|--------|--------|--------|------------------------|-------------|\n';
    purchase.forEach((p: any) => {
      output += `| ${p.企業名 || ''} | ¥${(p.買取額 || 0).toLocaleString()} | ¥${(p.請求額 || 0).toLocaleString()} | **${p.掛目 || 0}%** | ${p.再契約の意思 || ''} |\n`;
    });
    output += '\n';
    output += '**掛目の値: ' + (purchase[0]?.掛目 || 0) + '%（この値をそのまま使用）**\n\n';
  } else {
    output += '⚠️ データなし\n\n';
  }

  // 担保情報テーブル
  output += '#### 担保情報テーブル\n\n';
  const collateral = kintone.担保情報 || [];
  if (collateral.length > 0) {
    output += '| 会社名 | 次回入金予定額 | 先々月 | 先月 | 今月 |\n';
    output += '|--------|---------------|--------|------|------|\n';
    collateral.forEach((c: any) => {
      output += `| ${c.会社名 || ''} | ¥${(c.次回入金予定額 || 0).toLocaleString()} | ¥${(c.先々月 || 0).toLocaleString()} | ¥${(c.先月 || 0).toLocaleString()} | ¥${(c.今月 || 0).toLocaleString()} |\n`;
    });
    output += '\n';
  } else {
    output += '⚠️ データなし\n\n';
  }

  // 謄本情報テーブル
  output += '#### 謄本情報テーブル\n\n';
  const registry = kintone.謄本情報 || [];
  if (registry.length > 0) {
    output += '| 会社名 | 資本金 | 設立年 | 最終登記取得日 |\n';
    output += '|--------|--------|--------|---------------|\n';
    registry.forEach((r: any) => {
      output += `| ${r.会社名 || ''} | ${r.資本金 || ''} | ${r.設立年 || ''} | ${r.最終登記取得日 || ''} |\n`;
    });
  } else {
    output += '⚠️ データなし\n';
  }

  return output;
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
