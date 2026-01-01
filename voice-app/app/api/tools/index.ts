import { getWeather } from "./weather";
import { getCurrentTime } from "./time";
import { listViews, getViewData } from "./views";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// OpenAI/Cerebras-compatible tool definitions
export interface Tool {
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

export const tools: Tool[] = [
  {
    type: "function",
    function: {
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
            enum: ["celsius", "fahrenheit"],
            description:
              "Temperature units. Default to fahrenheit for US locations, celsius otherwise.",
          },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Get the current time, optionally for a specific timezone. Use this when the user asks what time it is.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "IANA timezone name (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo'). If not specified, returns UTC.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_views",
      description:
        "List all available views including Shopping List, Family Calendar, Tasks, Schedule, and other dashboards. MUST call this when user asks about any list, shopping, calendar, tasks, schedule, or events.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_view_data",
      description:
        "Get the actual items/data from a specific view. Use after list_views to retrieve Shopping List items, Calendar events, Tasks, etc.",
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
  },
];

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "get_weather":
      return await getWeather(
        toolInput as { location: string; units?: "celsius" | "fahrenheit" }
      );
    case "get_current_time":
      return await getCurrentTime(toolInput as { timezone?: string });
    case "list_views":
      return await listViews();
    case "get_view_data":
      return await getViewData(toolInput as { view_id: string });
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}
