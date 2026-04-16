import { SECONDARY_FONT } from "../../constants/constants";

const LABEL_FONT = `500 10px ${SECONDARY_FONT}`;
const LABEL_PAD_X = 6;

export function extractFilenameFromSrc(src: string): string {
  if (!src) return "";
  try {
    const pathname = new URL(src, "http://x").pathname;
    const segments = pathname.split("/");
    return decodeURIComponent(segments[segments.length - 1] || "");
  } catch {
    return src.split("/").pop() || src;
  }
}

function getThemeTextColor(): string {
  const isDark = document.documentElement.classList.contains("dark");
  return isDark ? "#ffffff" : "#000000";
}

export function drawItemNameLabel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  name: string
): void {
  if (!name || width < 30) return;

  ctx.save();
  ctx.translate(-width / 2, -height / 2);

  ctx.font = LABEL_FONT;

  const maxTextWidth = width - LABEL_PAD_X * 2;
  if (maxTextWidth <= 0) {
    ctx.restore();
    return;
  }

  let displayText = name;
  let textWidth = ctx.measureText(displayText).width;

  if (textWidth > maxTextWidth) {
    while (
      ctx.measureText(`${displayText}...`).width > maxTextWidth &&
      displayText.length > 0
    ) {
      displayText = displayText.slice(0, -1);
    }
    displayText = displayText.length > 0 ? `${displayText}...` : "";
  }

  if (!displayText) {
    ctx.restore();
    return;
  }

  ctx.fillStyle = getThemeTextColor();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(displayText, LABEL_PAD_X, height / 2);

  ctx.restore();
}
