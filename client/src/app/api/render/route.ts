import { NextResponse } from "next/server";

const RENDER_SERVER_URL =
  process.env.RENDER_SERVER_URL || "http://localhost:8000";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const response = await fetch(`${RENDER_SERVER_URL}/api/render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return NextResponse.json(
        { message: error?.message || "Failed to start render" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error("Render proxy error:", error);
    return NextResponse.json(
      { message: "Internal server error - is the render server running?" },
      { status: 500 }
    );
  }
}
