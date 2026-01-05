/**
 * Tool Registry - Public API
 *
 * This module re-exports everything needed for tool integration.
 */

// Core types
export type {
  ToolDefinition,
  ToolParameterProperty,
  OpenAIChatTool,
  OpenAIRealtimeTool,
  ToolResult,
  ToolName,
  ToolParameters,
  WeatherParams,
  TimeParams,
  ListViewsParams,
  GetViewDataParams,
  FetchUrlParams,
  WebSearchParams,
  GetUserLocationParams,
} from "./registry";

// Tool definitions and converters
export {
  TOOL_DEFINITIONS,
  toChatApiFormat,
  toRealtimeApiFormat,
  getAllToolsForChatApi,
  getAllToolsForRealtimeApi,
  getToolNames,
  isValidToolName,
} from "./registry";

// Client-side execution (for Realtime mode in browser)
export { executeToolClient } from "./client-executor";

// NOTE: Speculative orchestrator exports removed from this barrel file.
// Import directly from "@/lib/speculative-orchestrator" in server-side code.
// This file is imported by client-side code and cannot include server-only modules.
