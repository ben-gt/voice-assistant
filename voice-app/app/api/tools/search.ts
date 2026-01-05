import { toVoiceFriendlyError } from "@/lib/errors";

interface SearchInput {
  query: string;
  num_results?: number; // Number of results to return (default: 5, max: 10)
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  source: "serper" | "duckduckgo";
}

// Search using Serper.dev API (Google results)
async function searchWithSerper(
  query: string,
  numResults: number
): Promise<SearchResponse | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: numResults,
      }),
    });

    if (!response.ok) {
      console.error(`Serper API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const results: SearchResult[] = [];

    // Extract organic results
    if (data.organic) {
      for (const item of data.organic.slice(0, numResults)) {
        results.push({
          title: item.title || "",
          url: item.link || "",
          snippet: item.snippet || "",
        });
      }
    }

    return {
      query,
      results,
      source: "serper",
    };
  } catch (error) {
    console.error("Serper search error:", error);
    return null;
  }
}

// Fallback: Search using DuckDuckGo HTML
async function searchWithDuckDuckGo(
  query: string,
  numResults: number
): Promise<SearchResponse | null> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodedQuery}`,
      {
        headers: {
          "User-Agent": "VoiceAssistant/1.0",
        },
      }
    );

    if (!response.ok) {
      console.error(`DuckDuckGo error: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse results from HTML
    // DuckDuckGo HTML results are in <div class="result"> elements
    const resultRegex =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < numResults) {
      const url = match[1];
      const title = match[2].trim();
      let snippet = match[3]
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();

      // Skip DuckDuckGo internal links
      if (url.startsWith("//duckduckgo.com")) continue;

      // Extract actual URL from DuckDuckGo redirect
      let actualUrl = url;
      if (url.includes("uddg=")) {
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          actualUrl = decodeURIComponent(uddgMatch[1]);
        }
      }

      results.push({
        title,
        url: actualUrl,
        snippet,
      });
    }

    // Alternative parsing if the above doesn't work
    if (results.length === 0) {
      const altRegex =
        /<div[^>]+class="[^"]*result[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/div>/gi;

      while ((match = altRegex.exec(html)) !== null && results.length < numResults) {
        // Basic extraction
        const block = match[0];
        const urlMatch = block.match(/href="([^"]+)"/);
        const titleMatch = block.match(/>([^<]{10,})</);

        if (urlMatch && titleMatch) {
          let url = urlMatch[1];
          if (url.includes("uddg=")) {
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) {
              url = decodeURIComponent(uddgMatch[1]);
            }
          }

          if (!url.startsWith("//duckduckgo.com") && url.startsWith("http")) {
            results.push({
              title: titleMatch[1].trim(),
              url,
              snippet: "",
            });
          }
        }
      }
    }

    return {
      query,
      results,
      source: "duckduckgo",
    };
  } catch (error) {
    console.error("DuckDuckGo search error:", error);
    return null;
  }
}

export async function webSearch(input: SearchInput): Promise<ToolResult> {
  try {
    const query = input.query?.trim();
    if (!query) {
      const friendlyError = toVoiceFriendlyError("Search query is required", "web_search");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    const numResults = Math.min(Math.max(input.num_results || 5, 1), 10);

    // Try Serper first (Google results), fall back to DuckDuckGo
    let searchResult = await searchWithSerper(query, numResults);

    if (!searchResult) {
      searchResult = await searchWithDuckDuckGo(query, numResults);
    }

    if (!searchResult || searchResult.results.length === 0) {
      const friendlyError = toVoiceFriendlyError("No search results found", "web_search");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    return {
      success: true,
      data: searchResult,
    };
  } catch (error) {
    console.error("Web search tool error:", error);
    const technicalError = error instanceof Error ? error.message : "Search failed";
    const friendlyError = toVoiceFriendlyError(technicalError, "web_search");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}
