/**
 * プロンプト文字数削減効果の検証
 *
 * JSON.stringify vs Markdown形式の比較
 */

// サンプルデータ（実際のPhase 1-3の出力に近い構造）
const sampleData = {
  recordId: "12345",

  phase1: {
    purchaseDocuments: [
      {
        fileName: "請求書_20250101.pdf",
        documentType: "請求書",
        pageCount: 3,
        text: "これは非常に長いテキストデータです。".repeat(100), // 実際のOCRテキストは数千文字
        extractedFacts: {
          請求元: "株式会社サンプル建設",
          請求先: "山田工業",
          請求額: "¥5,000,000",
          請求日: "2025/01/01",
          支払期日: "2025/01/31",
        }
      }
    ],
    collateralDocuments: [
      {
        fileName: "登記情報_A社.pdf",
        documentType: "登記情報",
        pageCount: 5,
        text: "登記情報の全文テキスト...".repeat(150), // 実際は数千文字
        extractedFacts: {
          会社名: "株式会社A商事",
          資本金: "1,000万円",
          設立年月日: "平成12年4月1日",
          代表取締役: "田中太郎",
          本店所在地: "東京都渋谷区...",
        }
      }
    ],
    purchaseVerification: {
      kintoneMatch: "一致",
    },
    collateralExtraction: {
      findings: ["担保企業3社確認", "全社3ヶ月連続入金実績あり"],
    }
  },

  phase2: {
    mainBankAnalysis: {
      collateralMatches: [
        {
          company: "株式会社A商事",
          monthlyResults: [
            { month: "2024/10", expected: 1000000, actual: 1000000, matched: true, matchType: "単独一致" },
            { month: "2024/11", expected: 1200000, actual: 1200000, matched: true, matchType: "単独一致" },
            { month: "2024/12", expected: 1100000, actual: 1100000, matched: true, matchType: "単独一致" },
          ],
          allTransactions: [ // 実際は数百件の取引データ
            { date: "2024/10/15", amount: 1000000, description: "株式会社A商事" },
            { date: "2024/11/15", amount: 1200000, description: "株式会社A商事" },
          ]
        }
      ],
      riskDetection: {
        gambling: [],
        otherFactoring: [],
        largeCashWithdrawals: [ // これは不要なデータ
          { date: "2024/10/05", amount: -500000 },
          { date: "2024/11/10", amount: -800000 },
        ]
      }
    },
    factoringCompanies: [
      { date: "2024/10/20", companyName: "ファクタリング株式会社", amount: 2000000, transactionType: "入金" }
    ]
  },

  phase3: {
    本人確認: {
      書類タイプ: "運転免許証",
      照合結果: "一致",
      検出人数: 1,
      一致人数: 1,
      一致人物: {
        氏名: "山田太郎",
        生年月日: "1985/01/01",
        住所: "東京都渋谷区...",
      }
    },
    申込者エゴサーチ: {
      ネガティブ情報: false,
      詐欺情報サイト: 0,
      Web検索: 0,
      詳細: "ネガティブ情報は見つかりませんでした。",
    },
    企業実在性: {
      申込企業: { 企業名: "山田工業", 公式サイト: "https://example.com", 信頼度: 85 },
      買取企業: { 総数: 1, 確認済み: 1, 未確認: 0, 企業リスト: [] },
      担保企業: { 総数: 3, 確認済み: 2, 未確認: 1, 企業リスト: [] },
    },
    代表者リスク: {
      検索対象: 3,
      リスク検出: 0,
    }
  },

  kintone: {
    基本情報: {
      氏名: "山田太郎",
      生年月日: "1985/01/01",
      年齢: 40,
      住所: "東京都渋谷区...",
      種別: "個人事業主",
      屋号: "山田工業",
      設立年: "2015年",
      業種: "建設業",
      売上: "¥50,000,000",
    },
    財務リスク情報: {
      資金使途: "運転資金",
      ファクタリング利用: "利用あり",
      税金滞納額: 0,
      保険料滞納額: 0,
    },
    買取情報: [
      { 企業名: "株式会社サンプル建設", 買取額: 2500000, 請求額: 5000000, 掛目: 50, 再契約の意思: "あり" }
    ],
    担保情報: [
      { 会社名: "株式会社A商事", 次回入金予定額: 3000000, 先々月: 1000000, 先月: 1200000, 今月: 1100000 },
      { 会社名: "株式会社B工務店", 次回入金予定額: 2500000, 先々月: 900000, 先月: 950000, 今月: 1000000 },
      { 会社名: "株式会社C建設", 次回入金予定額: 2000000, 先々月: 800000, 先月: 850000, 今月: 900000 },
    ],
    謄本情報: [
      { 会社名: "株式会社A商事", 資本金: "1,000万円", 設立年: "平成12年", 最終登記取得日: "2024/12/01" }
    ]
  }
};

// ========================================
// 方法1: JSON.stringify（旧方式）
// ========================================
const jsonStringified = JSON.stringify(sampleData, null, 2);
const jsonCharCount = jsonStringified.length;

console.log("========================================");
console.log("プロンプト文字数削減効果の検証");
console.log("========================================\n");

console.log("【旧方式】JSON.stringify");
console.log(`  文字数: ${jsonCharCount.toLocaleString()}文字`);
console.log(`  サンプル:\n${jsonStringified.substring(0, 200)}...\n`);

// ========================================
// 方法2: Markdown形式（新方式）
// ========================================

// 簡易版のフォーマット関数
function formatPhase1DataSimple(phase1: any): string {
  let output = '#### 買取書類\n\n';
  phase1.purchaseDocuments?.forEach((doc: any) => {
    output += `**📄 ${doc.fileName}**\n`;
    output += `- 文書タイプ: ${doc.documentType}\n`;
    const facts = doc.extractedFacts || {};
    if (facts.請求元) output += `- 請求元: ${facts.請求元}\n`;
    if (facts.請求先) output += `- 請求先: ${facts.請求先}\n`;
    if (facts.請求額) output += `- 請求額: ${facts.請求額}\n`;
    output += '\n';
  });

  output += '#### 担保書類\n\n';
  phase1.collateralDocuments?.forEach((doc: any) => {
    output += `**📄 ${doc.fileName}**\n`;
    output += `- 文書タイプ: ${doc.documentType}\n`;
    const facts = doc.extractedFacts || {};
    if (facts.会社名) output += `- 会社名: ${facts.会社名}\n`;
    if (facts.資本金) output += `- 資本金: ${facts.資本金}\n`;
    if (facts.設立年月日) output += `- 設立年月日: ${facts.設立年月日}\n`;
    output += '\n';
  });

  output += `#### 買取検証結果\n\n- Kintone照合: **${phase1.purchaseVerification?.kintoneMatch}**\n\n`;
  output += `#### 担保情報抽出\n\n${phase1.collateralExtraction?.findings?.join('\n')}\n`;

  return output;
}

function formatPhase2DataSimple(phase2: any): string {
  let output = '#### メイン通帳分析\n\n';

  const mainBank = phase2.mainBankAnalysis;
  mainBank?.collateralMatches?.forEach((match: any) => {
    output += `##### ${match.company}\n\n`;
    output += '| 月 | 期待値 | 実績 | 照合結果 |\n';
    output += '|----|--------|------|----------|\n';
    match.monthlyResults?.forEach((result: any) => {
      const icon = result.matched ? '✅' : '❌';
      output += `| ${result.month} | ¥${result.expected.toLocaleString()} | ¥${result.actual.toLocaleString()} | ${icon} |\n`;
    });
    output += '\n';
  });

  output += '**ギャンブル検出:** ✅ 検出なし\n\n';

  const factoring = phase2.factoringCompanies || [];
  if (factoring.length > 0) {
    output += `**他社ファクタリング:** ⚠️ ${factoring.length}件検出\n`;
    output += '| 日付 | 業者名 | 金額 |\n';
    output += '|------|--------|------|\n';
    factoring.forEach((f: any) => {
      output += `| ${f.date} | ${f.companyName} | ¥${f.amount.toLocaleString()} |\n`;
    });
  } else {
    output += '**他社ファクタリング:** ✅ 検出なし\n';
  }

  return output;
}

function formatPhase3DataSimple(phase3: any): string {
  let output = '#### 本人確認\n\n';
  const identity = phase3.本人確認 || {};
  output += `- 書類タイプ: ${identity.書類タイプ}\n`;
  output += `- 照合結果: ${identity.照合結果}\n`;
  output += `- 一致人数: ${identity.一致人数}/${identity.検出人数}人\n\n`;

  output += '#### 申込者エゴサーチ\n\n';
  const ego = phase3.申込者エゴサーチ || {};
  output += `- ネガティブ情報: ${ego.ネガティブ情報 ? '⚠️ あり' : '✅ なし'}\n`;
  output += `- 詳細: ${ego.詳細}\n\n`;

  output += '#### 企業実在性\n\n';
  const companies = phase3.企業実在性 || {};
  output += `- 申込企業: ${companies.申込企業?.企業名}（信頼度${companies.申込企業?.信頼度}%）\n`;
  output += `- 担保企業: ${companies.担保企業?.総数}社（確認済み${companies.担保企業?.確認済み}社）\n`;

  return output;
}

function formatKintoneDataSimple(kintone: any): string {
  let output = '#### 基本情報\n\n';
  const basic = kintone.基本情報 || {};
  output += `- 氏名: ${basic.氏名}\n`;
  output += `- 年齢: ${basic.年齢}歳\n`;
  output += `- 種別: ${basic.種別}\n`;
  output += `- 屋号: ${basic.屋号}\n`;
  output += `- 売上: ${basic.売上}\n\n`;

  output += '#### 買取情報テーブル\n\n';
  output += '| 企業名 | 買取額 | 請求額 | 掛目 |\n';
  output += '|--------|--------|--------|------|\n';
  kintone.買取情報?.forEach((p: any) => {
    output += `| ${p.企業名} | ¥${p.買取額.toLocaleString()} | ¥${p.請求額.toLocaleString()} | ${p.掛目}% |\n`;
  });
  output += '\n';

  output += '#### 担保情報テーブル\n\n';
  output += '| 会社名 | 次回入金予定額 | 先々月 | 先月 | 今月 |\n';
  output += '|--------|---------------|--------|------|------|\n';
  kintone.担保情報?.forEach((c: any) => {
    output += `| ${c.会社名} | ¥${c.次回入金予定額.toLocaleString()} | ¥${c.先々月.toLocaleString()} | ¥${c.先月.toLocaleString()} | ¥${c.今月.toLocaleString()} |\n`;
  });

  return output;
}

const markdownFormatted =
`### Record ID
${sampleData.recordId}

### Phase 1 結果（買取・担保情報）

${formatPhase1DataSimple(sampleData.phase1)}

### Phase 2 結果（通帳分析）

${formatPhase2DataSimple(sampleData.phase2)}

### Phase 3 結果（本人確認・企業実在性）

${formatPhase3DataSimple(sampleData.phase3)}

### Kintoneデータ

${formatKintoneDataSimple(sampleData.kintone)}`;

const markdownCharCount = markdownFormatted.length;

console.log("【新方式】Markdown形式");
console.log(`  文字数: ${markdownCharCount.toLocaleString()}文字`);
console.log(`  サンプル:\n${markdownFormatted.substring(0, 300)}...\n`);

// ========================================
// 削減効果の計算
// ========================================
const reduction = jsonCharCount - markdownCharCount;
const reductionPercent = ((reduction / jsonCharCount) * 100).toFixed(1);

console.log("========================================");
console.log("【削減効果】");
console.log(`  削減文字数: ${reduction.toLocaleString()}文字`);
console.log(`  削減率: ${reductionPercent}%`);
console.log("========================================\n");

console.log("【主な改善点】");
console.log("  1. ✅ text全文（数千文字のOCRテキスト）を除外");
console.log("  2. ✅ largeCashWithdrawals（不要な取引データ）を除外");
console.log("  3. ✅ allTransactions（数百件の全取引履歴）を除外");
console.log("  4. ✅ JSON構造のオーバーヘッド（{}、[]、\"\"）を削減");
console.log("  5. ✅ Markdown表形式で視覚的に整理（AIが理解しやすい）");
console.log("\n【結論】");
console.log(`  プロンプトサイズを約${reductionPercent}%削減し、かつAIが理解しやすい形式に改善しました。`);
console.log("========================================\n");
