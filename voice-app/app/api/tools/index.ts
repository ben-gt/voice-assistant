/**
 * Server-side Tool Execution for Classic Mode
 *
 * This module provides the tool executor for the Classic (Chat Completions API) mode.
 * Tool definitions are imported from the centralized registry.
 */

import { getWeather } from "./weather";
import { getCurrentTime } from "./time";
import { listViews, getViewData } from "./views";
import { fetchUrl } from "./fetch";
import { webSearch } from "./search";
import { getUserLocation } from "./location";

// Re-export types and tools from centralized registry
export type {
  ToolResult,
  OpenAIChatTool as Tool,
  ToolName,
  WeatherParams,
  TimeParams,
  GetViewDataParams,
  FetchUrlParams,
  WebSearchParams,
  GetUserLocationParams,
} from "@/lib/tools";

export {
  getAllToolsForChatApi,
  isValidToolName,
  TOOL_DEFINITIONS,
} from "@/lib/tools";

import { getAllToolsForChatApi, isValidToolName } from "@/lib/tools";
import type { ToolResult, ToolName, ToolParameters } from "@/lib/tools";

/**
 * Get all tools formatted for OpenAI Chat Completions API
 * @deprecated Use getAllToolsForChatApi() from @/lib/tools directly
 */
export const tools = getAllToolsForChatApi();

/**
 * Execute a tool by name with the given parameters (server-side)
 */
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<ToolResult> {
  if (!isValidToolName(toolName)) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  const name = toolName as ToolName;

  switch (name) {
    case "get_weather":
      return await getWeather(toolInput as unknown as ToolParameters["get_weather"]);

    case "get_current_time":
      return await getCurrentTime(toolInput as unknown as ToolParameters["get_current_time"]);

    case "list_views":
      return await listViews();

    case "get_view_data":
      return await getViewData(toolInput as unknown as ToolParameters["get_view_data"]);

    case "fetch_url":
      return await fetchUrl(toolInput as unknown as ToolParameters["fetch_url"]);

    case "web_search":
      return await webSearch(toolInput as unknown as ToolParameters["web_search"]);

    case "get_user_location":
      return await getUserLocation();

    default: {
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustiveCheck: never = name;
      return { success: false, error: `Unhandled tool: ${_exhaustiveCheck}` };
    }
  }
}
