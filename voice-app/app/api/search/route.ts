import { NextRequest, NextResponse } from "next/server";

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

      if (url.startsWith("//duckduckgo.com")) continue;

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

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q");
  const numResultsParam = request.nextUrl.searchParams.get("num");

  if (!query) {
    return NextResponse.json(
      { success: false, error: "Missing query parameter" },
      { status: 400 }
    );
  }

  const numResults = Math.min(Math.max(parseInt(numResultsParam || "5", 10) || 5, 1), 10);

  try {
    let searchResult = await searchWithSerper(query, numResults);

    if (!searchResult) {
      searchResult = await searchWithDuckDuckGo(query, numResults);
    }

    if (!searchResult || searchResult.results.length === 0) {
      return NextResponse.json(
        { success: false, error: "No search results found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: searchResult,
    });
  } catch (error) {
    console.error("Search proxy error:", error);
    return NextResponse.json(
      { success: false, error: "Search failed" },
      { status: 500 }
    );
  }
}
