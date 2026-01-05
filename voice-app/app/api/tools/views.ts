import { toVoiceFriendlyError, getHttpStatusMessage } from "@/lib/errors";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const FARMBOARD_BASE_URL = "https://farmboard.gnrl.tech";

interface ViewSummary {
  id: string;
  name: string;
  description?: string | null;
}

export async function listViews(): Promise<ToolResult> {
  try {
    const response = await fetch(`${FARMBOARD_BASE_URL}/api/settings/views`);
    if (!response.ok) {
      const friendlyError = getHttpStatusMessage(response.status, "list views");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }
    const data = await response.json();

    if (Array.isArray(data)) {
      const views: ViewSummary[] = data.map(
        (view: { id: string; name: string; description?: string }) => ({
          id: view.id,
          name: view.name,
          description: view.description || null,
        })
      );
      return {
        success: true,
        data: { views, count: views.length },
      };
    }

    return { success: true, data };
  } catch (error) {
    console.error("List views tool error:", error);
    const friendlyError = toVoiceFriendlyError("Failed to fetch views", "list_views");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}

interface GetViewDataInput {
  view_id: string;
}

export async function getViewData(input: GetViewDataInput): Promise<ToolResult> {
  try {
    const response = await fetch(`${FARMBOARD_BASE_URL}/api/view/${input.view_id}`);
    if (!response.ok) {
      // Special handling for 404 - the view wasn't found
      if (response.status === 404) {
        const friendlyError = toVoiceFriendlyError(
          `Failed to fetch view data: 404`,
          "get_view_data"
        );
        return {
          success: false,
          error: friendlyError.suggestion
            ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
            : friendlyError.userMessage,
        };
      }
      const friendlyError = getHttpStatusMessage(response.status, "view data");
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }
    const data = await response.json();

    if (data && typeof data === "object") {
      const summary: Record<string, unknown> = {};

      if (data.name) summary.name = data.name;
      if (data.description) summary.description = data.description;

      if (Array.isArray(data.data)) {
        summary.rowCount = data.data.length;
        summary.columns = data.data[0] ? Object.keys(data.data[0]) : [];
        summary.items = data.data; // Return all items
      } else if (Array.isArray(data)) {
        summary.rowCount = data.length;
        summary.columns = data[0] ? Object.keys(data[0]) : [];
        summary.items = data; // Return all items
      } else {
        summary.data = data;
      }

      return { success: true, data: summary };
    }

    return { success: true, data };
  } catch (error) {
    console.error("Get view data tool error:", error);
    const friendlyError = toVoiceFriendlyError("Failed to fetch view data", "get_view_data");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}
