import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { performGoogleSearch } from "../lib/google-search";

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
    })),
    negativeSearchResults: z.array(z.object({
      query: z.string(),
      found: z.boolean(),
      results: z.array(z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
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
        const found = await checkFraudSite(site, name);
        
        fraudSiteResults.push({
          siteName: site.name,
          url: site.url,
          found: found,
          details: found ? `${name}に関する情報が見つかりました` : undefined,
        });
      } catch (error) {
        console.error(`Error checking fraud site ${site.name}:`, error);
        fraudSiteResults.push({
          siteName: site.name,
          url: site.url,
          found: false,
          details: "サイトアクセスエラー",
        });
      }
    }
    
    // ネガティブ情報検索（詐欺・逮捕のみ）
    const negativeSearchResults = [];
    const negativeQueries = [
      `${name} 詐欺`,
      `${name} 逮捕`,
      `${name} 容疑`,
      `${name} 被害`,
    ];
    
    for (const query of negativeQueries) {
      try {
        const results = await performGoogleSearch(query);
        const hasResults = results && results.length > 0;
        
        // 全ての検索結果を返す（フィルタリングしない）
        // AI判定はワークフロー側で行う
        const allResults = hasResults ? results.map((result: any) => ({
          title: result.title,
          url: result.link,
          snippet: result.snippet,
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
async function checkFraudSite(site: any, name: string): Promise<boolean> {
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
      return false;
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
      return false;
    }
    
    // 名前が実際にページに含まれているかチェック
    // （タイトルや本文に名前が含まれている場合）
    const nameVariations = [
      name,
      name.replace(/\s/g, ''), // スペースなし
      name.replace(/[　\s]/g, ''), // 全角・半角スペースなし
    ];
    
    let found = false;
    for (const variation of nameVariations) {
      // 検索クエリ自体は除外（URLやフォームの値として含まれるため）
      // 本文やタイトルに含まれているかをチェック
      const contentRegex = new RegExp(`(?<!name="|value="|q=|s=|query=|search=|keyword=)${escapeRegExp(variation)}`, 'gi');
      const matches = html.match(contentRegex);
      
      if (matches && matches.length > 0) {
        // デバッグ用: マッチした部分の前後を確認
        const contextMatches = html.match(new RegExp(`.{0,50}${escapeRegExp(variation)}.{0,50}`, 'gi'));
        if (contextMatches) {
          console.log(`Found ${variation} in context:`, contextMatches[0]);
        }
        found = true;
        break;
      }
    }
    
    return found;
  } catch (error) {
    console.error(`Failed to check fraud site ${site.name}:`, error);
    return false;
  }
}