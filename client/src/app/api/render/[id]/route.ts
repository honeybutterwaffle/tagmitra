import { NextResponse } from "next/server";

const RENDER_SERVER_URL =
  process.env.RENDER_SERVER_URL || "http://localhost:8000";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { message: "id parameter is required" },
        { status: 400 }
      );
    }

    const response = await fetch(`${RENDER_SERVER_URL}/api/render/${id}`, {
      headers: {
        "Content-Type": "application/json"
      },
      cache: "no-store"
    });

    const statusData = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { message: statusData?.message || "Failed to get render status" },
        { status: response.status }
      );
    }

    return NextResponse.json(statusData, { status: 200 });
  } catch (error: any) {
    console.error("Render status proxy error:", error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    );
  }
}
