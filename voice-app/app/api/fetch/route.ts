import { NextRequest, NextResponse } from "next/server";

interface PageResult {
  url: string;
  contentType: string;
  content: string;
  truncated: boolean;
  originalLength: number;
  links?: string[];
  depth: number;
}

interface CrawlResult {
  startUrl: string;
  pages: PageResult[];
  totalPages: number;
  maxDepthReached: number;
}

// Extract links from HTML content
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const href = match[1];
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("data:")
      ) {
        continue;
      }

      const absoluteUrl = new URL(href, baseUrl).href;
      if (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://")) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return [...new Set(links)];
}

// Fetch a single page
async function fetchSinglePage(
  url: string,
  depth: number
): Promise<PageResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VoiceAssistant/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    let content = text;
    let links: string[] = [];

    if (contentType.includes("text/html")) {
      links = extractLinks(text, url);

      content = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    }

    const maxLength = 2000;
    const truncated = content.length > maxLength;
    if (truncated) {
      content = content.substring(0, maxLength) + "...";
    }

    return {
      url,
      contentType: contentType.includes("text/html") ? "html" : "text",
      content,
      truncated,
      originalLength: text.length,
      links,
      depth,
    };
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  const depthParam = request.nextUrl.searchParams.get("depth");
  const maxPagesParam = request.nextUrl.searchParams.get("max_pages");
  const sameDomainParam = request.nextUrl.searchParams.get("same_domain");

  if (!url) {
    return NextResponse.json(
      { success: false, error: "Missing url parameter" },
      { status: 400 }
    );
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json(
      { success: false, error: `Invalid URL: ${url}` },
      { status: 400 }
    );
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return NextResponse.json(
      { success: false, error: `Unsupported protocol: ${parsedUrl.protocol}` },
      { status: 400 }
    );
  }

  try {
    const maxDepth = Math.min(parseInt(depthParam || "0", 10) || 0, 3);
    const maxPages = Math.min(parseInt(maxPagesParam || "10", 10) || 10, 20);
    const sameDomain = sameDomainParam !== "false";
    const baseDomain = parsedUrl.hostname;

    const visited = new Set<string>();
    const pages: PageResult[] = [];
    const queue: { url: string; depth: number }[] = [{ url, depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
      const current = queue.shift()!;

      const normalizedUrl = current.url.split("#")[0];
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      const page = await fetchSinglePage(normalizedUrl, current.depth);
      if (!page) continue;

      pages.push(page);

      if (current.depth < maxDepth && page.links) {
        for (const link of page.links) {
          const linkUrl = new URL(link);
          if (sameDomain && linkUrl.hostname !== baseDomain) continue;
          if (visited.has(link.split("#")[0])) continue;
          if (queue.length >= maxPages * 2) break;

          queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    }

    if (pages.length === 0) {
      return NextResponse.json(
        { success: false, error: "Failed to fetch any pages" },
        { status: 500 }
      );
    }

    // For single page (depth 0), return simple format
    if (maxDepth === 0 && pages.length === 1) {
      const page = pages[0];
      return NextResponse.json({
        success: true,
        data: {
          url: page.url,
          contentType: page.contentType,
          content: page.content,
          truncated: page.truncated,
          originalLength: page.originalLength,
        },
      });
    }

    // For multi-page crawl, return structured result
    const result: CrawlResult = {
      startUrl: url,
      pages: pages.map((p) => ({
        url: p.url,
        contentType: p.contentType,
        content: p.content,
        truncated: p.truncated,
        originalLength: p.originalLength,
        depth: p.depth,
      })),
      totalPages: pages.length,
      maxDepthReached: Math.max(...pages.map((p) => p.depth)),
    };

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Fetch URL proxy error:", error);

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return NextResponse.json(
          { success: false, error: "Request timed out" },
          { status: 504 }
        );
      }
      return NextResponse.json(
        { success: false, error: `Failed to fetch URL: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { success: false, error: "Failed to fetch URL" },
      { status: 500 }
    );
  }
}
