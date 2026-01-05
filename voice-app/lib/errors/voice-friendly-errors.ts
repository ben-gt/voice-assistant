/**
 * Voice-Friendly Error Messages
 *
 * This module transforms technical error messages into natural, conversational
 * messages suitable for a voice assistant context. Error messages should:
 * - Sound natural when spoken aloud
 * - Be apologetic but helpful
 * - Offer alternatives or suggestions where possible
 * - Avoid technical jargon
 */

// =============================================================================
// Types
// =============================================================================

export interface VoiceFriendlyError {
  /** The friendly message to display/speak to the user */
  userMessage: string;
  /** Optional suggestion for what the user can try */
  suggestion?: string;
  /** The original technical error for logging */
  technicalError: string;
  /** Error category for UI styling/handling */
  category: ErrorCategory;
}

export type ErrorCategory =
  | "not_found"
  | "network"
  | "timeout"
  | "invalid_input"
  | "service_unavailable"
  | "permission"
  | "unknown";

// =============================================================================
// Error Pattern Matching
// =============================================================================

interface ErrorPattern {
  /** Regex or string to match against the error message */
  pattern: RegExp | string;
  /** The tool or context this error applies to (optional) */
  tool?: string;
  /** Function to generate the friendly error */
  transform: (match: RegExpMatchArray | null, originalError: string) => VoiceFriendlyError;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // ===================
  // View/List Errors
  // ===================
  {
    // When view_id couldn't be resolved from an ambiguous query
    pattern: /Failed to fetch view data[:\s]*404/i,
    tool: "get_view_data",
    transform: () => ({
      userMessage: "I'm not sure which list you'd like to see.",
      suggestion: "Would you like me to show you what's available?",
      technicalError: "View not found - ambiguous query",
      category: "invalid_input",
    }),
  },
  {
    pattern: /Failed to fetch view data[:\s]*(\d+)/i,
    tool: "get_view_data",
    transform: (match) => ({
      userMessage: "I'm having trouble accessing that list right now.",
      suggestion: "Please try again in a moment.",
      technicalError: `View data fetch failed with status ${match?.[1] || "unknown"}`,
      category: "service_unavailable",
    }),
  },
  {
    pattern: /Failed to fetch views[:\s]*(\d+)?/i,
    tool: "list_views",
    transform: () => ({
      userMessage: "I couldn't retrieve the available lists right now.",
      suggestion: "Please try again in a moment.",
      technicalError: "Failed to fetch views list",
      category: "service_unavailable",
    }),
  },

  // ===================
  // Weather Errors
  // ===================
  {
    pattern: /Could not find location[:\s]*(.+)/i,
    tool: "get_weather",
    transform: (match) => ({
      userMessage: `I couldn't find a location called "${match?.[1]?.trim() || "that"}".`,
      suggestion: "Could you try a different city name or be more specific?",
      technicalError: `Location not found: ${match?.[1] || "unknown"}`,
      category: "not_found",
    }),
  },
  {
    pattern: /Failed to fetch weather/i,
    tool: "get_weather",
    transform: () => ({
      userMessage: "I couldn't get the weather information right now.",
      suggestion: "Please try again in a moment.",
      technicalError: "Weather API request failed",
      category: "service_unavailable",
    }),
  },
  {
    pattern: /Geocoding API error[:\s]*(\d+)/i,
    tool: "get_weather",
    transform: () => ({
      userMessage: "I'm having trouble looking up that location.",
      suggestion: "Please try again or try a different location.",
      technicalError: "Geocoding service error",
      category: "service_unavailable",
    }),
  },
  {
    pattern: /Weather API error[:\s]*(\d+)/i,
    tool: "get_weather",
    transform: () => ({
      userMessage: "The weather service isn't responding right now.",
      suggestion: "Please try again in a moment.",
      technicalError: "Weather API service error",
      category: "service_unavailable",
    }),
  },

  // ===================
  // Time Errors
  // ===================
  {
    pattern: /Invalid timezone[:\s]*(.+)/i,
    tool: "get_current_time",
    transform: (match) => ({
      userMessage: `I don't recognize "${match?.[1]?.trim() || "that"}" as a timezone.`,
      suggestion: "Try saying something like \"New York time\" or \"London time\".",
      technicalError: `Invalid timezone: ${match?.[1] || "unknown"}`,
      category: "invalid_input",
    }),
  },
  {
    pattern: /Failed to get current time/i,
    tool: "get_current_time",
    transform: () => ({
      userMessage: "I couldn't check the time right now.",
      suggestion: "Please try again.",
      technicalError: "Time lookup failed",
      category: "service_unavailable",
    }),
  },

  // ===================
  // URL/Fetch Errors
  // ===================
  {
    pattern: /Invalid URL[:\s]*(.+)/i,
    tool: "fetch_url",
    transform: () => ({
      userMessage: "That doesn't look like a valid web address.",
      suggestion: "Could you check the URL and try again?",
      technicalError: "Invalid URL format",
      category: "invalid_input",
    }),
  },
  {
    pattern: /Unsupported protocol[:\s]*(.+)/i,
    tool: "fetch_url",
    transform: () => ({
      userMessage: "I can only access regular web pages.",
      suggestion: "Please provide a web address starting with http or https.",
      technicalError: "Unsupported URL protocol",
      category: "invalid_input",
    }),
  },
  {
    pattern: /Failed to fetch URL[:\s]*timeout/i,
    tool: "fetch_url",
    transform: () => ({
      userMessage: "That website is taking too long to respond.",
      suggestion: "The site might be slow. Would you like me to try again?",
      technicalError: "URL fetch timeout",
      category: "timeout",
    }),
  },
  {
    pattern: /Failed to fetch URL/i,
    tool: "fetch_url",
    transform: () => ({
      userMessage: "I couldn't access that web page.",
      suggestion: "The site might be down or blocking requests. Would you like to try a different approach?",
      technicalError: "URL fetch failed",
      category: "network",
    }),
  },
  {
    pattern: /Failed to fetch any pages/i,
    tool: "fetch_url",
    transform: () => ({
      userMessage: "I wasn't able to read any content from that website.",
      suggestion: "Would you like me to search for information about it instead?",
      technicalError: "No pages could be fetched",
      category: "network",
    }),
  },
  {
    pattern: /Request timed out/i,
    transform: () => ({
      userMessage: "That's taking longer than expected.",
      suggestion: "Would you like me to try again?",
      technicalError: "Request timeout",
      category: "timeout",
    }),
  },

  // ===================
  // Search Errors
  // ===================
  {
    pattern: /Search query is required/i,
    tool: "web_search",
    transform: () => ({
      userMessage: "I need to know what you'd like me to search for.",
      suggestion: "What would you like me to look up?",
      technicalError: "Empty search query",
      category: "invalid_input",
    }),
  },
  {
    pattern: /No search results found/i,
    tool: "web_search",
    transform: () => ({
      userMessage: "I couldn't find any results for that search.",
      suggestion: "Would you like to try different search terms?",
      technicalError: "No search results",
      category: "not_found",
    }),
  },
  {
    pattern: /Search failed[:\s]*(\d+)?/i,
    tool: "web_search",
    transform: () => ({
      userMessage: "I'm having trouble searching right now.",
      suggestion: "Please try again in a moment.",
      technicalError: "Search service error",
      category: "service_unavailable",
    }),
  },

  // ===================
  // Connection Errors
  // ===================
  {
    pattern: /Failed to get realtime token/i,
    transform: () => ({
      userMessage: "I'm having trouble connecting to the voice service.",
      suggestion: "Please try again. If this keeps happening, try refreshing the page.",
      technicalError: "Realtime token fetch failed",
      category: "service_unavailable",
    }),
  },
  {
    pattern: /Connection failed/i,
    transform: () => ({
      userMessage: "I lost the connection.",
      suggestion: "Would you like me to try reconnecting?",
      technicalError: "Connection failure",
      category: "network",
    }),
  },
  {
    pattern: /SDP exchange failed/i,
    transform: () => ({
      userMessage: "I couldn't establish a voice connection.",
      suggestion: "Please try again. You may need to allow microphone access.",
      technicalError: "WebRTC SDP exchange failed",
      category: "network",
    }),
  },
  {
    pattern: /Cannot retry.*connection lost/i,
    transform: () => ({
      userMessage: "The connection was lost.",
      suggestion: "Please tap to reconnect and try again.",
      technicalError: "Connection lost during retry",
      category: "network",
    }),
  },

  // ===================
  // API/General Errors
  // ===================
  {
    pattern: /No response received/i,
    transform: () => ({
      userMessage: "I didn't get a response.",
      suggestion: "Please try again.",
      technicalError: "No response from API",
      category: "timeout",
    }),
  },
  {
    pattern: /Failed to get response/i,
    transform: () => ({
      userMessage: "Something went wrong on my end.",
      suggestion: "Please try again.",
      technicalError: "API response failure",
      category: "service_unavailable",
    }),
  },
  {
    pattern: /Unknown tool[:\s]*(.+)/i,
    transform: (match) => ({
      userMessage: "I don't know how to do that yet.",
      suggestion: "Is there something else I can help you with?",
      technicalError: `Unknown tool: ${match?.[1] || "unknown"}`,
      category: "invalid_input",
    }),
  },
  {
    pattern: /Failed to execute tool/i,
    transform: () => ({
      userMessage: "I ran into a problem trying to do that.",
      suggestion: "Would you like me to try again?",
      technicalError: "Tool execution failed",
      category: "service_unavailable",
    }),
  },

  // ===================
  // Microphone/Permission Errors
  // ===================
  {
    pattern: /Permission denied|NotAllowedError/i,
    transform: () => ({
      userMessage: "I need permission to use your microphone.",
      suggestion: "Please allow microphone access in your browser settings.",
      technicalError: "Microphone permission denied",
      category: "permission",
    }),
  },
  {
    pattern: /No speech detected/i,
    transform: () => ({
      userMessage: "I didn't catch that.",
      suggestion: "Please try speaking again, a bit louder or closer to the microphone.",
      technicalError: "No speech detected in audio",
      category: "invalid_input",
    }),
  },
];

// =============================================================================
// Main Transformation Function
// =============================================================================

/**
 * Transform a technical error message into a voice-friendly format
 *
 * @param error - The technical error message or Error object
 * @param toolName - Optional tool name for context-specific messages
 * @returns A voice-friendly error object
 */
export function toVoiceFriendlyError(
  error: string | Error,
  toolName?: string
): VoiceFriendlyError {
  const errorMessage = error instanceof Error ? error.message : error;

  // Log the original error for debugging
  console.error("[Error] Technical error:", errorMessage, toolName ? `(tool: ${toolName})` : "");

  // Try to find a matching pattern
  for (const pattern of ERROR_PATTERNS) {
    // Skip patterns that are tool-specific if the tool doesn't match
    if (pattern.tool && toolName && pattern.tool !== toolName) {
      continue;
    }

    const regex = typeof pattern.pattern === "string"
      ? new RegExp(pattern.pattern, "i")
      : pattern.pattern;

    const match = errorMessage.match(regex);
    if (match) {
      return pattern.transform(match, errorMessage);
    }
  }

  // Default fallback for unmatched errors
  return {
    userMessage: "Sorry, something went wrong.",
    suggestion: "Please try again.",
    technicalError: errorMessage,
    category: "unknown",
  };
}

/**
 * Format a voice-friendly error for display
 * Combines the message and suggestion into a natural sentence
 */
export function formatErrorForDisplay(error: VoiceFriendlyError): string {
  if (error.suggestion) {
    return `${error.userMessage} ${error.suggestion}`;
  }
  return error.userMessage;
}

/**
 * Format a voice-friendly error for speech
 * Same as display format but ensures it sounds natural when spoken
 */
export function formatErrorForSpeech(error: VoiceFriendlyError): string {
  // For speech, we want a natural pause between message and suggestion
  if (error.suggestion) {
    return `${error.userMessage}. ${error.suggestion}`;
  }
  return error.userMessage;
}

// =============================================================================
// Tool-Specific Error Helpers
// =============================================================================

/**
 * Create a voice-friendly error result for tools
 * This maintains the ToolResult interface while adding friendly messaging
 */
export interface VoiceFriendlyToolResult {
  success: false;
  error: string;
  friendlyError: VoiceFriendlyError;
}

/**
 * Create a standardized tool error result with voice-friendly messaging
 */
export function createToolError(
  technicalError: string,
  toolName: string
): VoiceFriendlyToolResult {
  const friendlyError = toVoiceFriendlyError(technicalError, toolName);

  return {
    success: false,
    error: friendlyError.userMessage,
    friendlyError,
  };
}

// =============================================================================
// HTTP Status Code Helpers
// =============================================================================

/**
 * Get a voice-friendly message for common HTTP status codes
 */
export function getHttpStatusMessage(status: number, context?: string): VoiceFriendlyError {
  switch (status) {
    case 400:
      return {
        userMessage: "I didn't understand that request.",
        suggestion: "Could you try rephrasing?",
        technicalError: `HTTP 400 Bad Request${context ? `: ${context}` : ""}`,
        category: "invalid_input",
      };
    case 401:
    case 403:
      return {
        userMessage: "I don't have permission to access that.",
        technicalError: `HTTP ${status} Unauthorized/Forbidden${context ? `: ${context}` : ""}`,
        category: "permission",
      };
    case 404:
      return {
        userMessage: "I couldn't find what you're looking for.",
        suggestion: "Would you like to try something else?",
        technicalError: `HTTP 404 Not Found${context ? `: ${context}` : ""}`,
        category: "not_found",
      };
    case 408:
    case 504:
      return {
        userMessage: "That request timed out.",
        suggestion: "Would you like me to try again?",
        technicalError: `HTTP ${status} Timeout${context ? `: ${context}` : ""}`,
        category: "timeout",
      };
    case 429:
      return {
        userMessage: "I'm receiving too many requests right now.",
        suggestion: "Please wait a moment and try again.",
        technicalError: `HTTP 429 Rate Limited${context ? `: ${context}` : ""}`,
        category: "service_unavailable",
      };
    case 500:
    case 502:
    case 503:
      return {
        userMessage: "The service I need isn't working right now.",
        suggestion: "Please try again in a moment.",
        technicalError: `HTTP ${status} Server Error${context ? `: ${context}` : ""}`,
        category: "service_unavailable",
      };
    default:
      return {
        userMessage: "Something went wrong with that request.",
        suggestion: "Please try again.",
        technicalError: `HTTP ${status}${context ? `: ${context}` : ""}`,
        category: "unknown",
      };
  }
}
