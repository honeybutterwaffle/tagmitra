import { NextRequest, NextResponse } from "next/server";

/**
 * URL upload endpoint - since we're running locally,
 * we just pass the URL through. The URL is used directly
 * as the media source in the editor.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { urls } = body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json(
        { error: "urls array is required and must not be empty" },
        { status: 400 }
      );
    }

    // For URL uploads, pass the URLs through directly
    // They're already accessible URLs (e.g. from stock libraries)
    const uploads = urls.map((url: string) => {
      const fileName = url.split("/").pop() || "file";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";
      const typeMap: Record<string, string> = {
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp"
      };
      const contentType = typeMap[ext] || "application/octet-stream";

      return {
        fileName,
        filePath: url,
        contentType,
        originalUrl: url,
        url,
        folder: null
      };
    });

    return NextResponse.json({
      success: true,
      uploads
    });
  } catch (error) {
    console.error("Error in upload URL route:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
