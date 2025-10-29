import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { performGoogleSearch } from "../lib/google-search";
import { performSerperSearch } from "../lib/serper-search";

// エゴサーチツールの定義
export const egoSearchTool = createTool({
  id: "ego-search",
  description: "代表者の詐欺情報・ネガティブ情報をWebで検索",
  inputSchema: z.object({
    recordId: z.string().optional().describe("KintoneレコードID（nameの代わりに使用可）"),
    name: z.string().optional().describe("検索対象の代表者名"),
    birthDate: z.string().optional().describe("生年月日（同姓同名対策）"),
  }),
  outputSchema: z.object({
    fraudSiteResults: z.array(z.object({
      siteName: z.string(),
      url: z.string(),
      found: z.boolean(),
      details: z.string().optional(),
      articles: z.array(z.object({
        title: z.string(),
        url: z.string(),
        htmlContent: z.string().describe("記事本文のHTML"),
      })).optional().describe("ヒットした場合の個別記事情報"),
    })),
    negativeSearchResults: z.array(z.object({
      query: z.string(),
      found: z.boolean(),
      results: z.array(z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        htmlContent: z.string().optional().describe("記事本文のHTML（第2段階で取得）"),
      })).optional(),
    })),
    summary: z.object({
      hasNegativeInfo: z.boolean(),
      fraudHits: z.number(),
      details: z.string(),
    }),
  }),
  execute: async ({ context }) => {
    let { name, birthDate, recordId } = context;
    
    // recordIdが提供された場合、Kintoneから代表者名と生年月日を取得
    if (!name && recordId) {
      const domain = process.env.KINTONE_DOMAIN;
      const apiToken = process.env.KINTONE_API_TOKEN;
      
      if (!domain || !apiToken) {
        throw new Error("Kintone環境変数が設定されていません");
      }
      
      try {
        const url = `https://${domain}/k/v1/records.json?app=37&query=$id="${recordId}"`;
        const response = await axios.get(url, {
          headers: { 'X-Cybozu-API-Token': apiToken },
        });
        
        if (response.data.records.length === 0) {
          throw new Error(`レコードID: ${recordId} が見つかりません`);
        }
        
        const record = response.data.records[0];
        name = record.代表者名?.value || "";
        birthDate = record.生年月日?.value || birthDate;
        
        console.log(`[Ego Search Tool] recordId: ${recordId} → 代表者名: ${name}, 生年月日: ${birthDate || "なし"}`);
      } catch (error) {
        console.error("[Ego Search Tool] Kintoneデータ取得エラー:", error);
        throw error;
      }
    }
    
    if (!name) {
      throw new Error("代表者名が指定されていません");
    }
    const fraudSiteResults = [];
    const webSearchResults = [];
    
    // 詐欺情報サイトのチェック
    const fraudSites = [
      {
        name: "eradicationofblackmoney",
        url: "https://eradicationofblackmoneyscammers.com/",
        searchUrl: (name: string) => 
          `https://eradicationofblackmoneyscammers.com/?s=${encodeURIComponent(name)}`,
      },
      // 将来的に追加可能な他のサイト
      // {
      //   name: "sagiwall-checker",
      //   url: "https://checker.sagiwall.jp",
      //   searchUrl: (name: string) => 
      //     `https://checker.sagiwall.jp/check?q=${encodeURIComponent(name)}`,
      // },
    ];
    
    // 詐欺サイト検索
    for (const site of fraudSites) {
      try {
        // WebFetchを使用してサイトを検索
        const searchUrl = site.searchUrl(name);
        console.log(`Checking fraud site: ${site.name} with URL: ${searchUrl}`);

        // 実際にサイトにアクセスしてチェック
        const result = await checkFraudSite(site, name);

        fraudSiteResults.push({
          siteName: site.name,
          url: site.url,
          found: result.found,
          details: result.found ? `${name}に関する情報が見つかりました（記事数: ${result.articles?.length || 0}件）` : undefined,
          articles: result.articles,
        });
      } catch (error) {
        console.error(`Error checking fraud site ${site.name}:`, error);
        fraudSiteResults.push({
          siteName: site.name,
          url: site.url,
          found: false,
          details: "サイトアクセスエラー",
          articles: undefined,
        });
      }
    }
    
    // ネガティブ情報検索（詐欺・逮捕のみ）
    // Serper APIを使用（手動Google検索と同じ結果）
    const negativeSearchResults = [];
    const negativeQueries = [
      `${name} 詐欺`,
      `${name} 逮捕`,
      `${name} 容疑`,
      `${name} 被害`,
    ];

    for (const query of negativeQueries) {
      try {
        const results = await performSerperSearch(query);
        const hasResults = results && results.length > 0;

        // 全ての検索結果を返す（記事本文は第2段階で取得）
        // AI判定はワークフロー側で行う
        const allResults = hasResults ? results.map((result: any) => ({
          title: result.title,
          url: result.link,
          snippet: result.snippet,
          htmlContent: undefined, // 第2段階で取得
        })) : [];

        negativeSearchResults.push({
          query,
          found: hasResults, // 検索結果があるかどうかのみ
          results: hasResults ? allResults : undefined,
        });
      } catch (error) {
        console.error(`Search error for query "${query}":`, error);
        negativeSearchResults.push({
          query,
          found: false,
          results: undefined,
        });
      }
    }
    
    // サマリー生成
    const fraudHits = fraudSiteResults.filter(r => r.found).length;
    const hasNegativeInfo = negativeSearchResults.some(r => r.found) || fraudHits > 0;
    
    let details = "";
    if (!hasNegativeInfo) {
      details = "ネガティブ情報は見つかりませんでした。";
    } else {
      if (fraudHits > 0) {
        details = `詐欺情報サイトに${fraudHits}件の情報が見つかりました。`;
      }
      const negativeHits = negativeSearchResults.filter(r => r.found);
      if (negativeHits.length > 0) {
        details += ` Web検索で${negativeHits.map(r => r.query).join('、')}に関する情報が見つかりました。`;
      }
    }
    
    return {
      fraudSiteResults,
      negativeSearchResults,
      summary: {
        hasNegativeInfo,
        fraudHits,
        details,
      },
    };
  },
});

// 正規表現エスケープ用ヘルパー関数
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 詐欺サイトスクレイピング（補助関数）
async function checkFraudSite(
  site: any,
  name: string
): Promise<{
  found: boolean;
  articles?: Array<{ title: string; url: string; htmlContent: string }>;
}> {
  try {
    const searchUrl = site.searchUrl(name);
    console.log(`Checking fraud site: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout: 10000,
      validateStatus: (status) => status < 500, // 404などのエラーも許容
    });

    if (response.status !== 200) {
      console.log(`Site returned status ${response.status}`);
      return { found: false };
    }

    const html = response.data;

    // 検索結果が見つからないパターンをチェック
    const noResultPatterns = [
      'no results found',
      'ご指定の検索条件に該当する投稿がありませんでした',
      '見つかりませんでした',
      '該当する記事はありません',
      '0件',
      '検索結果はありません',
      'Nothing Found',
      'No posts found',
      '検索結果が見つかりませんでした'
    ];

    const htmlLower = html.toLowerCase();
    const hasNoResults = noResultPatterns.some(pattern =>
      htmlLower.includes(pattern.toLowerCase())
    );

    if (hasNoResults) {
      console.log(`No results found for ${name} on ${site.name}`);
      return { found: false };
    }

    // 名前が実際にページに含まれているかチェック
    const nameVariations = [
      name,
      name.replace(/\s/g, ''), // スペースなし
      name.replace(/[　\s]/g, ''), // 全角・半角スペースなし
    ];

    let found = false;
    for (const variation of nameVariations) {
      const contentRegex = new RegExp(`(?<!name="|value="|q=|s=|query=|search=|keyword=)${escapeRegExp(variation)}`, 'gi');
      const matches = html.match(contentRegex);

      if (matches && matches.length > 0) {
        found = true;
        break;
      }
    }

    if (!found) {
      console.log(`Name "${name}" not found in search results`);
      return { found: false };
    }

    // ヒットした場合: 個別記事URLを抽出して本文を取得
    console.log(`Found potential matches for ${name}, extracting article URLs...`);
    const articleUrls = extractArticleUrls(html, site.url);

    if (articleUrls.length === 0) {
      console.log(`No article URLs found in search results`);
      return { found: false };
    }

    console.log(`Fetching ${articleUrls.length} article(s)...`);
    const articles = await Promise.all(
      articleUrls.slice(0, 5).map(async (articleUrl) => { // 最大5件まで
        try {
          const articleResponse = await axios.get(articleUrl.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            },
            timeout: 10000,
            validateStatus: (status) => status < 500,
          });

          if (articleResponse.status === 200) {
            console.log(`Successfully fetched article: ${articleUrl.title}`);
            return {
              title: articleUrl.title,
              url: articleUrl.url,
              htmlContent: articleResponse.data,
            };
          } else {
            console.log(`Failed to fetch article ${articleUrl.url}: status ${articleResponse.status}`);
            return null;
          }
        } catch (error) {
          console.error(`Error fetching article ${articleUrl.url}:`, error);
          return null;
        }
      })
    );

    const validArticles = articles.filter((a) => a !== null) as Array<{ title: string; url: string; htmlContent: string }>;

    if (validArticles.length === 0) {
      console.log(`Failed to fetch any articles`);
      return { found: false };
    }

    console.log(`Successfully fetched ${validArticles.length} article(s)`);
    return {
      found: true,
      articles: validArticles,
    };
  } catch (error) {
    console.error(`Failed to check fraud site ${site.name}:`, error);
    return { found: false };
  }
}

// Web検索結果の記事本文を取得（エクスポート）
export async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout: 10000,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 200) {
      return response.data;
    } else {
      console.log(`Failed to fetch article ${url}: status ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching article ${url}:`, error);
    return null;
  }
}

// 検索結果ページから個別記事URLを抽出
function extractArticleUrls(html: string, baseUrl: string): Array<{ title: string; url: string }> {
  const articles: Array<{ title: string; url: string }> = [];

  // WordPressの標準的な記事リンクパターンを抽出
  // 例: <a href="https://eradicationofblackmoneyscammers.com/2023/01/article-title/">タイトル</a>
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();

    // 記事URLっぽいもののみ（検索やカテゴリページは除外）
    if (
      url.includes(baseUrl) &&
      !url.includes('?s=') &&
      !url.includes('/category/') &&
      !url.includes('/tag/') &&
      !url.includes('/page/') &&
      !url.includes('#') &&
      title.length > 0 &&
      title.length < 200 // タイトルが異常に長いものを除外
    ) {
      // 重複を避ける
      if (!articles.some(a => a.url === url)) {
        articles.push({ title, url });
      }
    }
  }

  return articles;
}