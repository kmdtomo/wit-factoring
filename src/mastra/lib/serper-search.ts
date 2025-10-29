import axios from 'axios';

interface SerperSearchResult {
  title: string;
  link: string;
  snippet: string;
}

export async function performSerperSearch(query: string): Promise<SerperSearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.warn('Serper API key not found, returning empty results');
    return [];
  }

  try {
    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: query,
        num: 6, // 最大6件（4クエリ×6件）
        hl: 'ja', // 日本語
        gl: 'jp', // 日本
      },
      {
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    // Serperのレスポンス形式: { organic: [...] }
    const organicResults = response.data.organic || [];

    if (organicResults.length === 0) {
      console.log(`No results found for query: "${query}"`);
      return [];
    }

    return organicResults.map((item: any) => ({
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
    }));
  } catch (error: any) {
    console.error('Serper API error:', error.response?.data || error.message);
    return [];
  }
}
