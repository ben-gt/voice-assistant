import { toVoiceFriendlyError } from "@/lib/errors";

interface FetchUrlInput {
  url: string;
  depth?: number; // How many levels deep to crawl (0 = just this page, 1 = this page + linked pages, etc.)
  max_pages?: number; // Maximum total pages to fetch (default: 10)
  same_domain?: boolean; // Only follow links on the same domain (default: true)
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

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
  // Match href attributes in anchor tags
  const hrefRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const href = match[1];
      // Skip fragment-only links, javascript:, mailto:, tel:, etc.
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("data:")
      ) {
        continue;
      }

      // Resolve relative URLs
      const absoluteUrl = new URL(href, baseUrl).href;
      // Only include http/https
      if (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://")) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // Deduplicate
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
      // Extract links before stripping HTML
      links = extractLinks(text, url);

      // Strip HTML for content
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

    // Truncate content per page
    const maxLength = 2000; // Shorter per-page limit for multi-page crawls
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

export async function fetchUrl(input: FetchUrlInput): Promise<ToolResult> {
  try {
    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      const friendlyError = toVoiceFriendlyError(`Invalid URL: ${input.url}`, "fetch_url");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      const friendlyError = toVoiceFriendlyError(
        `Unsupported protocol: ${parsedUrl.protocol}`,
        "fetch_url"
      );
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    const maxDepth = Math.min(input.depth ?? 0, 3); // Cap at 3 levels deep
    const maxPages = Math.min(input.max_pages ?? 10, 20); // Cap at 20 pages
    const sameDomain = input.same_domain ?? true;
    const baseDomain = parsedUrl.hostname;

    const visited = new Set<string>();
    const pages: PageResult[] = [];
    const queue: { url: string; depth: number }[] = [{ url: input.url, depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
      const current = queue.shift()!;

      // Normalize URL (remove fragments)
      const normalizedUrl = current.url.split("#")[0];
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      const page = await fetchSinglePage(normalizedUrl, current.depth);
      if (!page) continue;

      pages.push(page);

      // If we haven't reached max depth, add child links to queue
      if (current.depth < maxDepth && page.links) {
        for (const link of page.links) {
          const linkUrl = new URL(link);
          // Filter by same domain if requested
          if (sameDomain && linkUrl.hostname !== baseDomain) continue;
          // Skip already visited
          if (visited.has(link.split("#")[0])) continue;
          // Skip if we have enough in queue
          if (queue.length >= maxPages * 2) break;

          queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    }

    if (pages.length === 0) {
      const friendlyError = toVoiceFriendlyError("Failed to fetch any pages", "fetch_url");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    // For single page (depth 0), return simple format
    if (maxDepth === 0 && pages.length === 1) {
      const page = pages[0];
      return {
        success: true,
        data: {
          url: page.url,
          contentType: page.contentType,
          content: page.content,
          truncated: page.truncated,
          originalLength: page.originalLength,
        },
      };
    }

    // For multi-page crawl, return structured result
    const result: CrawlResult = {
      startUrl: input.url,
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

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    console.error("Fetch URL tool error:", error);

    let technicalError = "Failed to fetch URL";
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        technicalError = "Failed to fetch URL: timeout";
      } else {
        technicalError = `Failed to fetch URL: ${error.message}`;
      }
    }

    const friendlyError = toVoiceFriendlyError(technicalError, "fetch_url");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}
