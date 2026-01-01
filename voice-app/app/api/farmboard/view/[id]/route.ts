import { NextRequest, NextResponse } from "next/server";

const FARMBOARD_BASE_URL = "https://farmboard.gnrl.tech";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await fetch(`${FARMBOARD_BASE_URL}/api/view/${id}`);
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch view data: ${response.status}` },
        { status: response.status }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Farmboard view proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch view data" },
      { status: 500 }
    );
  }
}
