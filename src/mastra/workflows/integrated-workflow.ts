// @ts-nocheck
import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { phase1PurchaseCollateralStep } from "./phase1-purchase-collateral-step";
import { phase2BankStatementStep } from "./phase2-bank-statement-step";
import { phase3VerificationStep } from "./phase3-verification-step";
import { phase4ReportGenerationStep } from "./phase4-report-generation-step";

/**
 * 統合ワークフロー（並列実行版）: Phase 1-3並列 → Phase 4
 *
 * 処理フロー:
 * 1. Phase 1-3を並列実行（branch()）:
 *    - Phase 1: 買取・担保情報処理（OCR → 買取検証 → 担保検証）
 *    - Phase 2: 通帳分析（OCR → 入金照合 → リスク検出）
 *    - Phase 3: 本人確認・企業実在性確認（本人確認OCR → エゴサーチ → 企業検証）
 *    → 全てのPhaseが完了するまで待機（一番遅いPhaseに合わせる）
 *
 * 2. Phase 4: 審査レポート生成（新バージョン - プロンプトベース評価）
 *    - Kintoneデータ取得
 *    - プロンプト・テンプレート読み込み（phase4-prompt-balanced.md）
 *    - GPT-4.1による包括的レポート生成
 *    - HTMLレポート出力（ideal-phase4-report-template.html構造）
 *    - 2つのフィールドに分割（riskSummaryHtml + detailedAnalysisHtml）
 *
 * 入力: recordId（KintoneレコードID）のみ
 * 出力: HTML形式の審査レポート（ウィットの審査基準に基づく柔軟な評価）
 *
 * パフォーマンス改善:
 * - 順次実行の場合: Phase1(30秒) + Phase2(20秒) + Phase3(15秒) = 65秒
 * - 並列実行の場合: max(30秒, 20秒, 15秒) = 30秒 ← 約50%高速化！
 */
export const integratedWorkflow = createWorkflow({
  id: "integrated-workflow",
  description: "ファクタリング審査の全フェーズ（Phase 1-3並列 + Phase 4）を実行し、最終レポートを生成します。",
  inputSchema: z.object({
    recordId: z.string(),
  }),
})
  .parallel([
    phase1PurchaseCollateralStep,
    phase2BankStatementStep,
    phase3VerificationStep,
  ])
  .then(phase4ReportGenerationStep)
  .commit();

