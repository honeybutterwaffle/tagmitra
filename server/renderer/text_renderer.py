"""
Render text and caption overlays as transparent PNG images using Pillow.
Handles custom fonts, word-level highlighting, text styling.
"""
import os
import re
import math
from typing import Optional
from PIL import Image, ImageDraw, ImageFont

# Font cache
_font_cache: dict[str, ImageFont.FreeTypeFont] = {}


def parse_css_px(val) -> float:
    """Parse CSS pixel value like '640px' or numeric."""
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    s = s.replace("px", "")
    try:
        return float(s)
    except ValueError:
        return 0


def parse_css_length(val, reference: float, default: float) -> float:
    """
    Parse width/height: px, number, or percentage of reference axis (e.g. canvas width).
    """
    if val is None:
        return default
    if isinstance(val, (int, float)):
        v = float(val)
        return v if v > 0 else default
    s = str(val).strip().lower()
    if s in ("auto", "max-content", "min-content", "fit-content", "none", ""):
        return default
    if s.endswith("%"):
        try:
            return max(1.0, float(s[:-1].strip()) / 100.0 * reference)
        except ValueError:
            return default
    v = parse_css_px(s)
    return v if v > 0 else default


def resolve_line_height_px(line_height, font_size: int) -> float:
    if line_height is None or line_height == "normal":
        return float(font_size) * 1.2
    s = str(line_height).strip()
    if s.endswith("px"):
        v = parse_css_px(s)
        return v if v > 0 else float(font_size) * 1.2
    try:
        mul = float(s)
        return float(font_size) * mul
    except ValueError:
        return float(font_size) * 1.2


def _wrap_paragraph_to_width(text: str, font: ImageFont.FreeTypeFont, max_width: float) -> list[str]:
    if max_width <= 0:
        return [text] if text else [""]
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        trial = (" ".join(current + [word])).strip()
        if font.getlength(trial) <= max_width:
            current.append(word)
        else:
            if current:
                lines.append(" ".join(current))
                current = [word]
            else:
                lines.append(word)
                current = []
    if current:
        lines.append(" ".join(current))
    return lines


def _layout_text_lines(
    text: str,
    font: ImageFont.FreeTypeFont,
    box_width: float,
) -> list[str]:
    """Split on newlines, then wrap each paragraph to box_width."""
    paragraphs = text.split("\n")
    out: list[str] = []
    for para in paragraphs:
        out.extend(_wrap_paragraph_to_width(para, font, box_width))
    return out if out else [""]


def parse_css_color(color_str: str) -> tuple:
    """Parse CSS color to RGBA tuple."""
    if not color_str or color_str == "transparent":
        return (0, 0, 0, 0)
    s = color_str.strip()
    if s.startswith("rgba"):
        m = re.match(r"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)", s)
        if m:
            return (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(float(m.group(4)) * 255))
    if s.startswith("rgb"):
        m = re.match(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", s)
        if m:
            return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 255)
    if s.startswith("#"):
        h = s.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    # Named colors
    named = {"white": (255, 255, 255, 255), "black": (0, 0, 0, 255),
             "red": (255, 0, 0, 255), "green": (0, 128, 0, 255), "blue": (0, 0, 255, 255)}
    return named.get(s.lower(), (255, 255, 255, 255))


def load_font(font_path: Optional[str], size: int) -> ImageFont.FreeTypeFont:
    """Load a font, using cache. Falls back to default."""
    cache_key = f"{font_path}_{size}"
    if cache_key in _font_cache:
        return _font_cache[cache_key]
    try:
        if font_path and os.path.exists(font_path):
            font = ImageFont.truetype(font_path, size)
        else:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size)
    except (OSError, IOError):
        font = ImageFont.load_default()
    _font_cache[cache_key] = font
    return font


def apply_text_transform(text: str, transform: str) -> str:
    if transform == "uppercase":
        return text.upper()
    elif transform == "lowercase":
        return text.lower()
    elif transform == "capitalize":
        return text.title()
    return text


def render_text_layer(
    details: dict,
    canvas_size: tuple[int, int],
    font_path: Optional[str] = None,
) -> tuple[Image.Image, int, int]:
    """
    Render text inside the same box the editor uses (width × height), with wrapping
    and textAlign. Returns (image, box_width, box_height) for FFmpeg overlay math.
    """
    cw, ch = canvas_size
    font_size = max(1, int(parse_css_px(details.get("fontSize", 16))))
    font = load_font(font_path, font_size)

    box_w = int(parse_css_length(details.get("width"), float(cw), float(cw)))
    box_w = max(1, box_w)

    text = details.get("text", "") or ""
    text = apply_text_transform(text, details.get("textTransform", "none"))
    text_align = (details.get("textAlign") or "left").lower()
    line_h = resolve_line_height_px(details.get("lineHeight"), font_size)

    inner_w = max(1.0, float(box_w))
    lines = _layout_text_lines(text, font, inner_w)
    content_h = max(int(line_h * len(lines)), font_size)

    raw_h = details.get("height")
    box_h = int(parse_css_length(raw_h, float(ch), float(content_h)))
    box_h = max(box_h, content_h, 1)

    img = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    text_color = parse_css_color(details.get("color", "#000000"))
    bg_color = parse_css_color(details.get("backgroundColor", "transparent"))
    stroke_w = int(parse_css_px(details.get("borderWidth", 0)))
    stroke_color = parse_css_color(details.get("borderColor", "#000000"))

    box_shadow = details.get("boxShadow", {})
    shadow_blur = 0
    sx = sy = 0
    shadow_color = (0, 0, 0, 255)
    if isinstance(box_shadow, dict):
        shadow_blur = int(box_shadow.get("blur", 0) or 0)
        sx = float(box_shadow.get("x", 0) or 0)
        sy = float(box_shadow.get("y", 0) or 0)
        shadow_color = parse_css_color(box_shadow.get("color", "#000000"))

    y_cursor = 0.0
    for line in lines:
        line_w = float(font.getlength(line))
        if text_align == "center":
            lx = (box_w - line_w) / 2.0
        elif text_align in ("right", "end"):
            lx = max(0.0, float(box_w) - line_w)
        else:
            lx = 0.0

        ly = y_cursor
        if shadow_blur > 0:
            draw.text(
                (lx + sx, ly + sy),
                line,
                fill=shadow_color,
                font=font,
                stroke_width=0,
            )

        if bg_color[3] > 0:
            bbox = draw.textbbox((lx, ly), line, font=font)
            pad = 4
            draw.rectangle(
                [
                    bbox[0] - pad,
                    bbox[1] - pad,
                    bbox[2] + pad,
                    bbox[3] + pad,
                ],
                fill=bg_color,
            )

        draw.text(
            (lx, ly),
            line,
            fill=text_color,
            font=font,
            stroke_width=stroke_w,
            stroke_fill=stroke_color if stroke_w > 0 else None,
        )
        y_cursor += line_h

    return img, box_w, box_h


def render_text_overlay(
    details: dict,
    canvas_size: tuple[int, int],
    font_path: Optional[str] = None,
) -> Image.Image:
    """Backward-compatible: layer image only (position/scale applied in FFmpeg)."""
    img, _, _ = render_text_layer(details, canvas_size, font_path)
    return img


def _measure_word_positions(
    words: list[dict], font: ImageFont.FreeTypeFont, x_start: float,
    text_align: str, max_width: float
) -> list[dict]:
    """Calculate x position for each word given font metrics."""
    space_w = font.getlength(" ")
    positions = []
    total_w = 0
    for i, w in enumerate(words):
        ww = font.getlength(w["word"])
        positions.append({"word": w, "width": ww, "x_offset": total_w})
        total_w += ww + (space_w if i < len(words) - 1 else 0)

    # Apply text alignment offset
    align_offset = 0
    if text_align == "center":
        align_offset = (max_width - total_w) / 2
    elif text_align == "right":
        align_offset = max_width - total_w

    for p in positions:
        p["x"] = x_start + align_offset + p["x_offset"]

    return positions


def render_caption_states(
    details: dict,
    canvas_size: tuple[int, int],
    display_from: float,
    font_path: Optional[str] = None,
) -> list[dict]:
    """
    Render a caption item into multiple PNGs, one per word-activation state.
    Returns list of {path_or_image, start_time_sec, end_time_sec}.
    """
    words = details.get("words", [])
    if not words:
        return []

    font_size = int(parse_css_px(details.get("fontSize", 16)))
    font = load_font(font_path, font_size)

    x = parse_css_px(details.get("left", 0))
    y = parse_css_px(details.get("top", 0))
    text_width = parse_css_px(details.get("width", canvas_size[0]))
    text_align = details.get("textAlign", "center")

    default_color = parse_css_color(details.get("color", "#DADADA"))
    active_color = parse_css_color(details.get("activeColor", "#50FF12"))
    active_fill = parse_css_color(details.get("activeFillColor", "transparent"))
    appeared_color = parse_css_color(details.get("appearedColor", "#FFFFFF"))

    stroke_w = int(parse_css_px(details.get("borderWidth", 0)))
    stroke_color = parse_css_color(details.get("borderColor", "#000000"))

    word_positions = _measure_word_positions(
        words, font, x, text_align, text_width
    )

    states = []
    for active_idx in range(len(words)):
        word_data = words[active_idx]
        start_ms = word_data["start"]
        end_ms = word_data["end"]

        img = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        for i, wp in enumerate(word_positions):
            word_text = wp["word"]["word"]
            wx = wp["x"]
            wy = y

            if i < active_idx:
                fill = appeared_color
            elif i == active_idx:
                fill = active_color
                # Draw active fill background
                if active_fill[3] > 0:
                    bbox = draw.textbbox((wx, wy), word_text, font=font)
                    pad = 4
                    draw.rounded_rectangle(
                        [bbox[0] - pad, bbox[1] - pad,
                         bbox[2] + pad, bbox[3] + pad],
                        radius=6, fill=active_fill,
                    )
            else:
                fill = default_color

            draw.text(
                (wx, wy), word_text, fill=fill, font=font,
                stroke_width=stroke_w,
                stroke_fill=stroke_color if stroke_w > 0 else None,
            )

        states.append({
            "image": img,
            "start_sec": start_ms / 1000.0,
            "end_sec": end_ms / 1000.0,
        })

    return states


def render_shape_overlay(
    details: dict,
    canvas_size: tuple[int, int],
    svg_path: Optional[str] = None,
) -> Optional[Image.Image]:
    """Render a shape item: SVG mask + solid fill color."""
    try:
        import cairosvg
    except ImportError:
        print("[WARN] cairosvg not installed, skipping shape rendering")
        return None

    if not svg_path or not os.path.exists(svg_path):
        return None

    w = int(parse_css_px(details.get("width", 100)))
    h = int(parse_css_px(details.get("height", 100)))
    bg_color = parse_css_color(details.get("backgroundColor", "#808080"))

    x = parse_css_px(details.get("left", 0))
    y = parse_css_px(details.get("top", 0))

    # Convert SVG to PNG for mask
    mask_png = cairosvg.svg2png(url=svg_path, output_width=w, output_height=h)
    mask_img = Image.open(__import__("io").BytesIO(mask_png)).convert("L")

    # Create solid fill
    fill = Image.new("RGBA", (w, h), bg_color)
    fill.putalpha(mask_img)

    # Place on canvas
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    canvas.paste(fill, (int(x), int(y)), fill)
    return canvas


def render_progress_bar_frame(
    details: dict,
    canvas_size: tuple[int, int],
    progress: float,  # 0-100
) -> Image.Image:
    """Render a single frame of a progress bar."""
    img = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    x = parse_css_px(details.get("left", 0))
    y = parse_css_px(details.get("top", 0))
    w = int(parse_css_px(details.get("width", 200)))
    h = int(parse_css_px(details.get("height", 20)))

    colors = details.get("backgroundColors", ["rgba(128,128,128,0.5)", "rgba(128,128,128,1)"])
    bg_color = parse_css_color(colors[0] if len(colors) > 0 else "rgba(128,128,128,0.5)")
    fill_color = parse_css_color(colors[1] if len(colors) > 1 else "rgba(128,128,128,1)")

    inverted = details.get("inverted", False)
    if inverted:
        progress = 100 - progress

    # Background
    draw.rectangle([x, y, x + w, y + h], fill=bg_color)
    # Fill
    fill_w = int(w * progress / 100)
    if fill_w > 0:
        draw.rectangle([x, y, x + fill_w, y + h], fill=fill_color)

    return img
