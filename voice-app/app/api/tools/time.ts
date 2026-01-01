export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface TimeInput {
  timezone?: string;
}

export async function getCurrentTime(input: TimeInput): Promise<ToolResult> {
  try {
    const timezone = input.timezone || "UTC";

    // Validate timezone
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return {
        success: false,
        error: `Invalid timezone: ${timezone}. Please use IANA timezone format (e.g., 'America/New_York')`,
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
    return { success: false, error: "Failed to get current time" };
  }
}
