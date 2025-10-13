import { createTool } from "@mastra/core";
import { z } from "zod";
import { performGoogleSearch } from "../lib/google-search";

/**
 * 複数企業の検索結果を取得するツール（AI判定なし）
 * AI判定はphase3-verification-stepで一括実行
 */
export const companyVerifyBatchTool = createTool({
  id: "company-verify-batch",
  description: "複数企業の検索結果を取得",
  inputSchema: z.object({
    companies: z.array(z.object({
      name: z.string(),
      type: z.enum(["申込企業", "買取企業", "担保企業"]),
      location: z.string().optional(),
    })),
  }),
  outputSchema: z.object({
    companies: z.array(z.object({
      companyIndex: z.number(),
      companyName: z.string(),
      companyType: z.string(),
      location: z.string().optional(),
      searchResults: z.array(z.object({
        query: z.string(),
        results: z.array(z.object({
          title: z.string(),
          url: z.string(),
          snippet: z.string(),
        })),
      })),
    })),
  }),
  execute: async ({ context }) => {
    const { companies } = context;

    if (companies.length === 0) {
      return { companies: [] };
    }

    // 全企業の検索を実行
    const companySearchResults = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      const queries = buildSearchQueries(company.name, company.location);
      const searchResults = [];

      for (const query of queries) {
        try {
          const results = await performGoogleSearch(query);
          searchResults.push({
            query,
            results: results.map(r => ({
              title: r.title,
              url: r.link,
              snippet: r.snippet,
            })),
          });
        } catch (error) {
          console.error(`Search error for "${query}":`, error);
          searchResults.push({
            query,
            results: [],
          });
        }
      }

      companySearchResults.push({
        companyIndex: i,
        companyName: company.name,
        companyType: company.type,
        location: company.location,
        searchResults,
      });
    }

    return { companies: companySearchResults };
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
