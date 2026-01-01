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
      return {
        success: false,
        error: `Failed to fetch views: ${response.status}`,
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
    return { success: false, error: "Failed to fetch views" };
  }
}

interface GetViewDataInput {
  view_id: string;
}

export async function getViewData(input: GetViewDataInput): Promise<ToolResult> {
  try {
    const response = await fetch(`${FARMBOARD_BASE_URL}/api/view/${input.view_id}`);
    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch view data: ${response.status}`,
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
    return { success: false, error: "Failed to fetch view data" };
  }
}
