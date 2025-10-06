import { createTool } from "@mastra/core";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { performGoogleSearch } from "../lib/google-search";

/**
 * 複数企業の実在性を一括検証するツール
 * 全企業の検索結果を1回のAI呼び出しで判定
 */
export const companyVerifyBatchTool = createTool({
  id: "company-verify-batch",
  description: "複数企業の実在性を一括で検証",
  inputSchema: z.object({
    companies: z.array(z.object({
      name: z.string(),
      type: z.enum(["申込企業", "買取企業", "担保企業"]),
      location: z.string().optional(),
    })),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      companyName: z.string(),
      companyType: z.string(),
      verified: z.boolean(),
      confidence: z.number(),
      websiteUrl: z.string().optional(),
      businessDescription: z.string().optional(),
      capital: z.string().optional(),
      established: z.string().optional(),
    })),
  }),
  execute: async ({ context }) => {
    const { companies } = context;

    if (companies.length === 0) {
      return { results: [] };
    }

    // 全企業の検索を実行
    const allSearchResults: Array<{
      companyIndex: number;
      companyName: string;
      companyType: string;
      location?: string;
      query: string;
      searchResults: Array<{ title: string; url: string; snippet: string }>;
    }> = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      const queries = buildSearchQueries(company.name, company.location);

      for (const query of queries) {
        try {
          const results = await performGoogleSearch(query);
          allSearchResults.push({
            companyIndex: i,
            companyName: company.name,
            companyType: company.type,
            location: company.location,
            query,
            searchResults: results.map(r => ({
              title: r.title,
              url: r.link,
              snippet: r.snippet,
            })),
          });
        } catch (error) {
          console.error(`Search error for "${query}":`, error);
        }
      }
    }

    // 全検索結果を1回のAI呼び出しで判定
    const aiResult = await analyzeAllCompanies(companies, allSearchResults);

    // 結果を整形
    const results = companies.map((company, idx) => {
      const analysis = aiResult.companies.find((c: any) => c.companyIndex === idx);

      if (!analysis) {
        return {
          companyName: company.name,
          companyType: company.type,
          verified: false,
          confidence: 0,
        };
      }

      return {
        companyName: company.name,
        companyType: company.type,
        verified: analysis.verified,
        confidence: analysis.confidence,
        websiteUrl: analysis.websiteUrl,
        businessDescription: analysis.businessDescription,
        capital: analysis.capital,
        established: analysis.established,
      };
    });

    return { results };
  },
});

/**
 * 検索クエリを構築
 */
function buildSearchQueries(companyName: string, location?: string): string[] {
  const queries = [];

  if (location) {
    // 申込企業の場合: 所在地を含める
    queries.push(`${companyName} ${location}`);
    queries.push(`${companyName} ${location} 建設業`);
    queries.push(`${companyName} ${location} 建設`);
  } else {
    // 買取・担保企業の場合: 企業名のみ
    queries.push(companyName);
    queries.push(`${companyName} 建設業`);
  }

  return queries;
}

/**
 * 全企業の検索結果を1回のAI呼び出しで分析
 */
async function analyzeAllCompanies(
  companies: Array<{ name: string; type: string; location?: string }>,
  searchResults: Array<{
    companyIndex: number;
    companyName: string;
    companyType: string;
    location?: string;
    query: string;
    searchResults: Array<{ title: string; url: string; snippet: string }>;
  }>
): Promise<{
  companies: Array<{
    companyIndex: number;
    verified: boolean;
    confidence: number;
    websiteUrl?: string;
    businessDescription?: string;
    capital?: string;
    established?: string;
  }>;
}> {
  try {
    // 検索結果をプロンプト用に整形
    const companiesInfo = companies.map((c, idx) => {
      const companySearches = searchResults.filter(r => r.companyIndex === idx);
      const allResults = companySearches.flatMap(s => s.searchResults);

      return `
【企業${idx}】
企業名: ${c.name}
種別: ${c.type}
${c.location ? `所在地: ${c.location}` : ''}

検索結果 (${allResults.length}件):
${allResults.map((r, i) => `
  ${i + 1}. タイトル: ${r.title}
     URL: ${r.url}
     スニペット: ${r.snippet}
`).join('')}
`;
    }).join('\n---\n');

    const result = await generateObject({
      model: openai("gpt-4o"),
      prompt: `以下の企業の実在性を検索結果から判定してください。

${companiesInfo}

【判定基準】
1. 企業名の一致度 (0-100点)
   - 完全一致: 100点
   - 部分一致: 0-50点
   - 不一致: 0点

2. 所在地の一致 (指定されている場合)
   - 一致: +20点
   - 不一致: -30点

3. 公式サイトの検出
   - 会社概要ページ、公式サイトのトップページ: websiteUrlに設定
   - ポータルサイト、ニュース記事、求人サイト: 公式サイトではない

4. 信頼度 (confidence)
   - 70点以上: verified = true
   - 70点未満: verified = false

5. 企業情報の抽出
   - 事業内容 (businessDescription)
   - 資本金 (capital)
   - 設立年 (established)

各企業について判定結果を返してください。`,
      schema: z.object({
        companies: z.array(z.object({
          companyIndex: z.number().describe("企業のインデックス番号"),
          verified: z.boolean().describe("実在が確認できたか (confidence >= 70)"),
          confidence: z.number().min(0).max(100).describe("信頼度 (0-100)"),
          websiteUrl: z.string().optional().describe("公式サイトURL"),
          businessDescription: z.string().optional().describe("事業内容"),
          capital: z.string().optional().describe("資本金"),
          established: z.string().optional().describe("設立年"),
          reason: z.string().describe("判定理由 (100文字以内)"),
        })),
      }),
    });

    return result.object;
  } catch (error) {
    console.error("AI判定エラー:", error);
    // エラー時は全て未確認として返す
    return {
      companies: companies.map((_, idx) => ({
        companyIndex: idx,
        verified: false,
        confidence: 0,
      })),
    };
  }
}
