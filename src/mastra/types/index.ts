// Kintoneレコードの型定義
export interface KintoneRecord {
  recordId: string;
  
  // 基本情報
  basic: {
    顧客番号: string;
    会社_屋号名: string;
    代表者名: string;
    生年月日: string;
    携帯番号_ハイフンなし: string;
    会社所在地?: string;
    自宅所在地?: string;
  };
  
  // 財務・リスク情報
  financialRisk: {
    売上?: number;
    業種: string;
    資金使途: string;
    ファクタリング利用: string;
    税金滞納額_0?: number;
    納付状況_税金?: string;
    保険料滞納額?: number;
    納付状況_保険料?: string;
  };
  
  // 買取情報（配列）
  purchases: Array<{
    会社名_第三債務者_買取: string;
    買取債権額: number;
    買取額: number;
    掛目: string;
    買取債権支払日: string;
    状態_0: string;
  }>;
  
  // 担保情報（配列）
  collaterals: Array<{
    会社名_第三債務者_担保: string;
    請求額: number;
    入金予定日: string;
    過去の入金_先々月: number;
    過去の入金_先月: number;
    過去の入金_今月: number;
    平均: number;
  }>;
  
  // 謄本情報（配列）
  registries: Array<{
    会社名_第三債務者_0: string;
    資本金の額?: string;
    会社成立?: string;
    債権の種類?: string;
  }>;
  
  // 回収情報（配列）
  recovery: Array<{
    回収予定日: string;
    回収金額: number;
  }>;
  
  // 資金使途情報
  fundUsage: {
    所感_条件_担当者: string;
    所感_条件_決裁者: string;
    留意事項_営業?: string;
    留意事項_審査?: string;
  };
  
  // 添付ファイル
  attachments: {
    買取情報_成因証書_謄本類_名刺等_添付ファイル?: AttachmentFile[];
    通帳_メイン_添付ファイル?: AttachmentFile[];
    通帳_その他_添付ファイル?: AttachmentFile[];
    顧客情報_添付ファイル?: AttachmentFile[];
    他社資料_添付ファイル?: AttachmentFile[];
    担保情報_成因証書_謄本類_名刺等_添付ファイル?: AttachmentFile[];
    その他_添付ファイル?: AttachmentFile[];
  };
}

// 添付ファイルの型定義
export interface AttachmentFile {
  fileKey: string;
  name: string;
  contentType: string;
  size: number;
  content?: Buffer;
  category?: string;
}

// 最終的なコンプライアンス評価結果
export interface ComplianceAssessmentResult {
  recordId?: string;
  timestamp?: string;
  processingTime?: string;
  
  // 総合評価
  overall: {
    decision: "APPROVE" | "CONDITIONAL" | "REJECT";
    riskLevel: "safe" | "caution" | "danger";
    score: number;
  };
  
  // 3大カテゴリ評価
  categories: {
    counterparty: CategoryEvaluation;    // 取引先データ評価
    fundUsage: CategoryEvaluation;       // 資金使途評価
    transaction: CategoryEvaluation;     // 入出金履歴評価
  };
  
  // 実行されたツール
  executedTools?: string[];
  
  // 検出された問題点
  issues: Issue[];
  
  // 推奨アクション
  recommendations: string[];
  
  // 詳細レポート（日本語文章）
  detailedReports: {
    counterparty: string;
    fundUsage: string;
    transaction: string;
  };
}

// カテゴリ評価
export interface CategoryEvaluation {
  name: string;
  status: "safe" | "caution" | "danger";
  reason: string;
  details: Array<{
    item: string;
    value: string;
    evaluation: string;
    detail: string;
    evidence?: any;
  }>;
}

// 問題点
export interface Issue {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  evidence: string;
  source: string;
  recommendation: string;
}

// ストリーミングイベント
export interface StreamingEvent {
  type: "PROCESSING_START" | "TOOL_EXECUTION" | "CATEGORY_COMPLETED" | "FINAL_RESULT" | "ERROR";
  data: any;
}