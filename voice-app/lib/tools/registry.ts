/**
 * Centralized Tool Registry
 *
 * This module defines all available tools in a single location.
 * Both Classic mode (Chat API) and Realtime mode derive their configurations from here.
 *
 * To add a new tool:
 * 1. Add the tool definition to TOOL_DEFINITIONS below
 * 2. Add the parameter types to ToolParameters
 * 3. Implement the tool in the appropriate execution location:
 *    - Server-side: /app/api/tools/{tool_name}.ts
 *    - Add to executeTool switch in /app/api/tools/index.ts
 *    - Client-side Realtime: Add handler in executeToolClient below
 */

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * JSON Schema property definition for tool parameters
 */
export interface ToolParameterProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Core tool definition - format-agnostic representation
 */
export interface ToolDefinition {
  /** Tool name in snake_case (e.g., "get_weather") */
  name: string;
  /** Human-readable description for LLM to understand when to use this tool */
  description: string;
  /** JSON Schema parameter definitions */
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterProperty>;
    required: string[];
  };
}

/**
 * OpenAI Chat Completions API tool format
 */
export interface OpenAIChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * OpenAI Realtime API tool format
 */
export interface OpenAIRealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Standard tool execution result
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// =============================================================================
// Tool Parameter Types (for type-safe execution)
// =============================================================================

export interface WeatherParams {
  location: string;
  units?: "celsius" | "fahrenheit";
}

export interface TimeParams {
  timezone?: string;
  location?: string;
}

export interface ListViewsParams {
  // No parameters required
}

export interface GetViewDataParams {
  view_id: string;
}

export interface FetchUrlParams {
  url: string;
  depth?: number;
  max_pages?: number;
  same_domain?: boolean;
}

export interface WebSearchParams {
  query: string;
  num_results?: number;
}

export interface GetUserLocationParams {
  // No parameters required - uses IP geolocation
}

/**
 * Union type of all tool parameters, indexed by tool name
 */
export interface ToolParameters {
  get_weather: WeatherParams;
  get_current_time: TimeParams;
  list_views: ListViewsParams;
  get_view_data: GetViewDataParams;
  fetch_url: FetchUrlParams;
  web_search: WebSearchParams;
  get_user_location: GetUserLocationParams;
}

export type ToolName = keyof ToolParameters;

// =============================================================================
// Tool Definitions - Single Source of Truth
// =============================================================================

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  get_weather: {
    name: "get_weather",
    description:
      "Get the current weather for a specific location. Use this when the user asks about weather conditions, temperature, or forecasts.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description:
            "The city name or location (e.g., 'San Francisco', 'London, UK', 'Tokyo')",
        },
        units: {
          type: "string",
          description:
            "Temperature units. Default to fahrenheit for US locations, celsius otherwise.",
          enum: ["celsius", "fahrenheit"],
        },
      },
      required: ["location"],
    },
  },

  get_current_time: {
    name: "get_current_time",
    description:
      "Get the current date and time. MUST be called for ANY query about time, date, day of week, or 'what day is it'. You do NOT know the current date or time without calling this tool. If a location was mentioned earlier in the conversation, use that location's timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description:
            "IANA timezone name (e.g., 'America/New_York', 'Europe/London', 'Australia/Brisbane'). Use this if you know the user's location from conversation context.",
        },
        location: {
          type: "string",
          description:
            "Location name (e.g., 'Brisbane', 'New York', 'London'). Use this if a timezone is not known but a location was mentioned in the conversation.",
        },
      },
      required: [],
    },
  },

  list_views: {
    name: "list_views",
    description:
      "List all available views including Shopping List, Family Calendar, Tasks, Schedule, and other dashboards. MUST call this when user asks about any list, shopping, calendar, tasks, schedule, or events. Returns view names, IDs, and descriptions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  get_view_data: {
    name: "get_view_data",
    description:
      "Get the actual items/data from a specific view. Use after list_views to retrieve Shopping List items, Calendar events, Tasks, etc. Requires the view UUID obtained from list_views.",
    parameters: {
      type: "object",
      properties: {
        view_id: {
          type: "string",
          description: "The UUID of the view (obtained from list_views)",
        },
      },
      required: ["view_id"],
    },
  },

  fetch_url: {
    name: "fetch_url",
    description:
      "Fetch content from a URL, optionally crawling linked pages. Use this when the user asks you to read, summarize, or get information from a webpage or API endpoint. Set depth > 0 to crawl linked pages.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL to fetch (e.g., 'https://example.com/page')",
        },
        depth: {
          type: "number",
          description:
            "How many levels deep to crawl. 0 = just this page (default), 1 = this page + linked pages, 2 = two levels deep, etc. Max 3.",
        },
        max_pages: {
          type: "number",
          description:
            "Maximum number of pages to fetch when crawling. Default 10, max 20.",
        },
        same_domain: {
          type: "boolean",
          description: "Only follow links on the same domain. Default true.",
        },
      },
      required: ["url"],
    },
  },

  web_search: {
    name: "web_search",
    description:
      "Search the web using Google. Use this when the user asks you to search for something, look something up, or find information online. Essential for current events, business hours, prices, reviews, and real-time information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (1-10, default 5)",
        },
      },
      required: ["query"],
    },
  },

  get_user_location: {
    name: "get_user_location",
    description:
      "Get the user's approximate location based on their IP address. Use this when you need to know where the user is located, such as for weather queries without a specified location, local recommendations, or timezone detection. Returns city, region, country, timezone, and coordinates.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// =============================================================================
// Format Converters
// =============================================================================

/**
 * Convert a tool definition to OpenAI Chat Completions API format
 */
export function toChatApiFormat(tool: ToolDefinition): OpenAIChatTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters.properties,
        required: tool.parameters.required.length > 0 ? tool.parameters.required : undefined,
      },
    },
  };
}

/**
 * Convert a tool definition to OpenAI Realtime API format
 */
export function toRealtimeApiFormat(tool: ToolDefinition): OpenAIRealtimeTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  };
}

/**
 * Get all tools in Chat API format
 */
export function getAllToolsForChatApi(): OpenAIChatTool[] {
  return Object.values(TOOL_DEFINITIONS).map(toChatApiFormat);
}

/**
 * Get all tools in Realtime API format
 */
export function getAllToolsForRealtimeApi(): OpenAIRealtimeTool[] {
  return Object.values(TOOL_DEFINITIONS).map(toRealtimeApiFormat);
}

/**
 * Get a list of all tool names
 */
export function getToolNames(): ToolName[] {
  return Object.keys(TOOL_DEFINITIONS) as ToolName[];
}

/**
 * Check if a string is a valid tool name
 */
export function isValidToolName(name: string): name is ToolName {
  return name in TOOL_DEFINITIONS;
}
