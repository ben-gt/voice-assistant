import { toVoiceFriendlyError } from "@/lib/errors";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface TimeInput {
  timezone?: string;
  location?: string;
}

/**
 * Map common location names to IANA timezones
 * This allows the model to specify a location instead of requiring exact timezone knowledge
 */
const LOCATION_TO_TIMEZONE: Record<string, string> = {
  // Australian locations
  "brisbane": "Australia/Brisbane",
  "sydney": "Australia/Sydney",
  "melbourne": "Australia/Melbourne",
  "perth": "Australia/Perth",
  "adelaide": "Australia/Adelaide",
  "darwin": "Australia/Darwin",
  "hobart": "Australia/Hobart",
  "queensland": "Australia/Brisbane",
  "qld": "Australia/Brisbane",
  "nsw": "Australia/Sydney",
  "new south wales": "Australia/Sydney",
  "victoria": "Australia/Melbourne",
  "vic": "Australia/Melbourne",
  "western australia": "Australia/Perth",
  "wa": "Australia/Perth",
  "south australia": "Australia/Adelaide",
  "sa": "Australia/Adelaide",
  "northern territory": "Australia/Darwin",
  "nt": "Australia/Darwin",
  "tasmania": "Australia/Hobart",
  "tas": "Australia/Hobart",
  "australia": "Australia/Sydney",
  "lowood": "Australia/Brisbane",
  "ipswich": "Australia/Brisbane",
  "toowoomba": "Australia/Brisbane",
  "gold coast": "Australia/Brisbane",
  "cairns": "Australia/Brisbane",
  "townsville": "Australia/Brisbane",

  // US locations
  "new york": "America/New_York",
  "nyc": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "la": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "chicago": "America/Chicago",
  "houston": "America/Chicago",
  "dallas": "America/Chicago",
  "phoenix": "America/Phoenix",
  "denver": "America/Denver",
  "seattle": "America/Los_Angeles",
  "miami": "America/New_York",
  "boston": "America/New_York",
  "california": "America/Los_Angeles",
  "texas": "America/Chicago",
  "florida": "America/New_York",

  // UK/Europe
  "london": "Europe/London",
  "uk": "Europe/London",
  "england": "Europe/London",
  "paris": "Europe/Paris",
  "france": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "germany": "Europe/Berlin",
  "amsterdam": "Europe/Amsterdam",
  "rome": "Europe/Rome",
  "madrid": "Europe/Madrid",

  // Asia
  "tokyo": "Asia/Tokyo",
  "japan": "Asia/Tokyo",
  "beijing": "Asia/Shanghai",
  "shanghai": "Asia/Shanghai",
  "china": "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  "singapore": "Asia/Singapore",
  "seoul": "Asia/Seoul",
  "korea": "Asia/Seoul",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "india": "Asia/Kolkata",
  "bangkok": "Asia/Bangkok",

  // New Zealand
  "auckland": "Pacific/Auckland",
  "wellington": "Pacific/Auckland",
  "new zealand": "Pacific/Auckland",
};

/**
 * Resolve a location name to an IANA timezone
 */
function resolveTimezone(location?: string): string | null {
  if (!location) return null;

  const normalized = location.toLowerCase().trim();

  // Direct lookup
  if (LOCATION_TO_TIMEZONE[normalized]) {
    return LOCATION_TO_TIMEZONE[normalized];
  }

  // Try to find a partial match
  for (const [key, tz] of Object.entries(LOCATION_TO_TIMEZONE)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return tz;
    }
  }

  return null;
}

export async function getCurrentTime(input: TimeInput): Promise<ToolResult> {
  try {
    // Priority: explicit timezone > location lookup > UTC fallback
    let timezone = input.timezone;

    if (!timezone && input.location) {
      const resolved = resolveTimezone(input.location);
      if (resolved) {
        timezone = resolved;
        console.log(`[Time Tool] Resolved location "${input.location}" to timezone: ${timezone}`);
      } else {
        console.log(`[Time Tool] Could not resolve location "${input.location}", using UTC`);
      }
    }

    timezone = timezone || "UTC";

    // Validate timezone
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      const friendlyError = toVoiceFriendlyError(
        `Invalid timezone: ${timezone}`,
        "get_current_time"
      );
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    const formattedTime = formatter.format(now);

    return {
      success: true,
      data: {
        timezone,
        formatted: formattedTime,
        iso: now.toISOString(),
      },
    };
  } catch (error) {
    console.error("Time tool error:", error);
    const friendlyError = toVoiceFriendlyError("Failed to get current time", "get_current_time");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}
