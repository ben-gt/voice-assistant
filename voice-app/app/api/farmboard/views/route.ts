import { NextResponse } from "next/server";

const FARMBOARD_BASE_URL = "https://farmboard.gnrl.tech";

export async function GET() {
  try {
    const response = await fetch(`${FARMBOARD_BASE_URL}/api/settings/views`);
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch views: ${response.status}` },
        { status: response.status }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Farmboard views proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch views" },
      { status: 500 }
    );
  }
}
