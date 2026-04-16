"""
Temporal black-region (alpha hole) analysis for package videos.

Uses the same approach as ds_team_tags_asianet/MVP/edits_and_assignments.py
(resize_sponsor_stitch + _insert_sponsor_into_jacket):

1. Open video with MoviePy `has_mask=True` to extract the real alpha channel.
2. Invert the mask so the transparent hole becomes white.
3. Scale [0..1] -> [0..255] uint8 and run cv2.findContours on the mask.
4. Pick the largest contour by area; optionally refine with approxPolyDP.
5. Return bbox, slate_fit, keyframes, resolution, fps.
"""
from __future__ import annotations

from typing import Any, Optional

_KEYFRAME_INTERVAL_SEC = 0.5
_PREFERRED_MASK_FRAME = 125  # legacy: inverted_mask.get_frame(125 / fps)
_MAX_KEYFRAME_DURATION = 120.0  # seconds
_RGB_EDGE_BRIGHTNESS_LIMIT = 15  # max mean brightness for a column/row to be "black"


def _contour_bbox_from_mask_frame(
    mask_frame_01: Any,
    polygon: bool = True,
) -> Optional[tuple[int, int, int, int]]:
    """
    Contour detection on inverted alpha mask.

    The legacy pipeline (resize_sponsor_stitch) could pass the raw grayscale
    frame to findContours because the sponsor was then masked by the actual
    alpha channel (sponsor_clip.with_mask(inverted_mask)), making sub-pixel
    precision irrelevant.

    In the web preview we clip with CSS overflow:hidden, so we need the bbox
    to match only the *fully* transparent region.  We threshold at 128 (50%
    alpha) before findContours so anti-aliased edge pixels are excluded and
    the bbox is pixel-accurate.

    mask_frame_01: MoviePy mask frame (float [0..1], H x W or H x W x C).
    Returns (x, y, w, h) or None.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None

    frame = (mask_frame_01 * 255).astype(np.uint8)

    if frame.ndim == 3 and frame.shape[-1] == 3:
        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)

    # cv2.findContours treats any non-zero pixel as foreground.  The alpha
    # channel has anti-aliased edges where pixels fade from 0→255 over 1-3px.
    # Without thresholding, the outermost fringe pixels (alpha ~1-5/255)
    # inflate the bbox by ~1px.  The legacy pipeline didn't care because it
    # applied the actual alpha mask (sponsor_clip.with_mask(inverted_mask))
    # for compositing.  We clip with CSS overflow:hidden, so the bbox must
    # match the visible hole boundary.  Threshold=5 excludes only the faintest
    # fringe while keeping the rest pixel-accurate.
    _, frame = cv2.threshold(frame, 5, 255, cv2.THRESH_BINARY)

    contours, _ = cv2.findContours(frame, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest_contour = max(contours, key=cv2.contourArea)

    # Reject noise: anti-aliased alpha edges can create degenerate contours
    # (e.g. 1px-tall strip spanning the full width, area ≈ 0).  Real holes
    # have contour areas well above 500px.
    if cv2.contourArea(largest_contour) < 500:
        return None

    if polygon:
        epsilon = 0.02 * cv2.arcLength(largest_contour, True)
        approx = cv2.approxPolyDP(largest_contour, epsilon, True)
        if len(approx) >= 5:
            x, y, w, h = cv2.boundingRect(approx)
        else:
            x, y, w, h = cv2.boundingRect(largest_contour)
    else:
        x, y, w, h = cv2.boundingRect(largest_contour)

    if w < 1 or h < 1:
        return None
    return (int(x), int(y), int(w), int(h))


def _refine_bbox_with_rgb(
    rgb_frame: Any,
    x: int, y: int, w: int, h: int,
    limit: int = _RGB_EDGE_BRIGHTNESS_LIMIT,
    max_shrink: int = 8,
) -> tuple[int, int, int, int]:
    """
    Shrink the alpha-detected bbox inward until each edge row/column is
    actually dark in the RGB frame.  This compensates for the anti-aliased
    transition zone where pixels are semi-transparent but NOT black in RGB,
    giving a bbox that matches the visible black region in the browser.
    """
    import numpy as np

    rgb = rgb_frame
    if rgb.dtype != np.uint8:
        rgb = (np.clip(rgb, 0, 1) * 255).astype(np.uint8) if rgb.max() <= 1.0 else rgb.astype(np.uint8)

    fh, fw = rgb.shape[:2]

    def col_bright(c: int) -> float:
        if c < 0 or c >= fw:
            return 999.0
        return float(rgb[max(y, 0):min(y + h, fh), c].mean())

    def row_bright(r: int) -> float:
        if r < 0 or r >= fh:
            return 999.0
        return float(rgb[r, max(x, 0):min(x + w, fw)].mean())

    # Shrink left edge
    for _ in range(max_shrink):
        if col_bright(x) > limit:
            x += 1
            w -= 1
        else:
            break

    # Shrink right edge
    for _ in range(max_shrink):
        if col_bright(x + w - 1) > limit:
            w -= 1
        else:
            break

    # Shrink top edge
    for _ in range(max_shrink):
        if row_bright(y) > limit:
            y += 1
            h -= 1
        else:
            break

    # Shrink bottom edge
    for _ in range(max_shrink):
        if row_bright(y + h - 1) > limit:
            h -= 1
        else:
            break

    return (x, y, max(1, w), max(1, h))


def _compute_slate_fit(
    x: int,
    y: int,
    w: int,
    h: int,
    source_aspect: float = 16.0 / 9.0,
) -> dict[str, float]:
    """
    Longest side of fit box = longest side of contour bbox; other side from AR.
    Centered on contour; clamped to stay inside bbox.
    """
    bw, bh = float(w), float(h)
    m = max(bw, bh)
    ar = max(0.25, min(4.0, float(source_aspect)))
    if ar >= 1.0:
        fit_w = m
        fit_h = m / ar
    else:
        fit_h = m
        fit_w = m * ar
    if fit_w > bw:
        s = bw / fit_w
        fit_w, fit_h = bw, fit_h * s
    if fit_h > bh:
        s = bh / fit_h
        fit_h, fit_w = fit_h * s, fit_w * s
    cx = x + bw / 2.0
    cy = y + bh / 2.0
    left = cx - fit_w / 2.0
    top = cy - fit_h / 2.0
    return {
        "left": round(left, 2),
        "top": round(top, 2),
        "width": round(fit_w, 2),
        "height": round(fit_h, 2),
        "center_x": round(cx, 2),
        "center_y": round(cy, 2),
        "contour_max_side": round(m, 2),
        "contour_bbox": {"x": x, "y": y, "w": w, "h": h},
        "aspect_ratio": round(ar, 4),
    }


def analyze_package_alpha(
    path: str,
    *,
    source_aspect: float = 16.0 / 9.0,
    threshold: int = 40,
) -> dict[str, Any]:
    """
    Full analysis when a package is selected / analyzed.

    Uses MoviePy to read the alpha mask (has_mask=True) then inverts it so the
    transparent hole becomes a white region.  Contour detection on the inverted
    mask matches the legacy resize_sponsor_stitch / _insert_sponsor_into_jacket
    pipeline exactly.

    Returns alpha_box, keyframes, slate_fit, resolution, fps.
    """
    try:
        import cv2
        import numpy as np
        from moviepy import VideoFileClip, vfx
    except ImportError as exc:
        return {
            "alpha_box": None,
            "keyframes": [],
            "slate_fit": None,
            "resolution": {"width": 0, "height": 0},
            "fps": 25.0,
            "error": f"missing_dependency: {exc}",
        }

    # ── Open with MoviePy (extracts alpha channel) ─────────────────────
    try:
        template = VideoFileClip(path, has_mask=True)
    except Exception as exc:
        return {
            "alpha_box": None,
            "keyframes": [],
            "slate_fit": None,
            "resolution": {"width": 0, "height": 0},
            "fps": 25.0,
            "error": f"open_failed: {exc}",
        }

    fps = float(template.fps or 25.0)
    fw, fh = template.size  # (width, height)
    frame_count = int(template.duration * fps) if template.duration else 0

    mask_clip = template.mask
    if mask_clip is None:
        # No alpha channel at all — fall back to BGR threshold detection
        template.close()
        return _analyze_no_alpha_fallback(
            path, fps=fps, fw=fw, fh=fh, frame_count=frame_count,
            source_aspect=source_aspect, threshold=threshold,
        )

    # Invert: transparent (0) becomes white (1) — legacy approach
    inverted_mask = mask_clip.with_effects([vfx.InvertColors()])

    # ── Detect hole: try preferred frame, then fallback candidates ──────
    sample_idx = min(_PREFERRED_MASK_FRAME, max(frame_count - 1, 0))
    sample_t = sample_idx / fps if fps > 0 else 0

    mask_frame = inverted_mask.get_frame(sample_t)
    rect = _contour_bbox_from_mask_frame(mask_frame, polygon=True)

    if rect is None:
        for try_idx in (0, 50, 200, frame_count // 2):
            if try_idx >= frame_count and frame_count > 0:
                continue
            t = try_idx / fps if fps > 0 else 0
            try:
                mf = inverted_mask.get_frame(t)
            except Exception:
                continue
            rect = _contour_bbox_from_mask_frame(mf, polygon=True)
            if rect is not None:
                sample_idx = try_idx
                sample_t = t
                break

    if rect is None:
        template.close()
        return {
            "alpha_box": None,
            "keyframes": [],
            "slate_fit": None,
            "resolution": {"width": fw, "height": fh},
            "fps": fps,
        }

    x, y, w, h = rect

    # ── Refine bbox using RGB so it matches the visible black region ───
    try:
        rgb_frame = template.get_frame(sample_t)
        x, y, w, h = _refine_bbox_with_rgb(rgb_frame, x, y, w, h)
    except Exception:
        pass  # keep the alpha-only bbox if RGB read fails

    # ── Find actual start: scan backwards from the detected frame ──────
    start_sec = 0.0
    if sample_t > 0:
        t_back = sample_t - (1.0 / fps if fps > 0 else 0.04)
        while t_back >= 0:
            try:
                mf = inverted_mask.get_frame(t_back)
            except Exception:
                break
            r = _contour_bbox_from_mask_frame(mf, polygon=True)
            if r is None:
                start_sec = round(t_back + (1.0 / fps if fps > 0 else 0.04), 4)
                break
            t_back -= 0.5
        # If we scanned all the way to 0 and still found the hole, start_sec stays 0

    # ── Keyframes: sample forward while contour exists / changes ───────
    keyframes: list[dict[str, Any]] = [
        {"time_sec": start_sec, "x": x, "y": y, "w": w, "h": h}
    ]
    last_key = (x, y, w, h)
    t_cursor = sample_t + _KEYFRAME_INTERVAL_SEC
    max_t = template.duration if template.duration else start_sec + _MAX_KEYFRAME_DURATION

    while t_cursor <= min(max_t, start_sec + _MAX_KEYFRAME_DURATION):
        try:
            mf = inverted_mask.get_frame(t_cursor)
        except Exception:
            break
        r = _contour_bbox_from_mask_frame(mf, polygon=True)
        if not r:
            break
        nx, ny, nw, nh = r
        dx = abs(nw - last_key[2]) / max(1, last_key[2])
        dy = abs(nh - last_key[3]) / max(1, last_key[3])
        dpos = max(abs(nx - last_key[0]), abs(ny - last_key[1])) / max(fw, fh, 1)
        if dx > 0.03 or dy > 0.03 or dpos > 0.02:
            keyframes.append({
                "time_sec": round(t_cursor, 4),
                "x": nx, "y": ny, "w": nw, "h": nh,
            })
            last_key = (nx, ny, nw, nh)
        t_cursor += _KEYFRAME_INTERVAL_SEC

    template.close()

    # ── Build response ─────────────────────────────────────────────────
    frame_area = max(1, fw * fh)
    area_ratio = (w * h) / frame_area
    alpha_box: Optional[dict[str, Any]] = None
    if area_ratio >= 0.001:
        alpha_box = {
            "x": x, "y": y, "w": w, "h": h,
            "start_sec": start_sec,
        }

    slate_fit = _compute_slate_fit(x, y, w, h, source_aspect=source_aspect)
    # Also return the raw contour bbox as a pixel-perfect fit
    slate_fit["contour_left"] = x
    slate_fit["contour_top"] = y
    slate_fit["contour_width"] = w
    slate_fit["contour_height"] = h

    return {
        "alpha_box": alpha_box,
        "keyframes": keyframes,
        "slate_fit": slate_fit,
        "resolution": {"width": fw, "height": fh},
        "fps": round(fps, 3),
    }


# ── Fallback for videos without an alpha channel (e.g. .mp4) ──────────

def _analyze_no_alpha_fallback(
    path: str,
    *,
    fps: float,
    fw: int,
    fh: int,
    frame_count: int,
    source_aspect: float,
    threshold: int,
) -> dict[str, Any]:
    """
    BGR-threshold approach (mute_editor._detect_black_rectangle style)
    for videos that have no alpha channel.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return {
            "alpha_box": None, "keyframes": [], "slate_fit": None,
            "resolution": {"width": fw, "height": fh}, "fps": fps,
            "error": "opencv_not_installed",
        }

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return {
            "alpha_box": None, "keyframes": [], "slate_fit": None,
            "resolution": {"width": fw, "height": fh}, "fps": fps,
            "error": "open_failed",
        }

    def detect(frame_bgr: Any) -> Optional[tuple[int, int, int, int]]:
        H, W = frame_bgr.shape[:2]
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)
        k = max(3, int(min(H, W) * 0.01) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        best, best_score = None, -1e18
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            area = w * h
            if area < 0.01 * (W * H):
                continue
            ca = cv2.contourArea(c)
            fill = ca / max(1.0, float(area))
            rx, ry = x + w / 2.0, y + h / 2.0
            dist = ((rx - W / 2.0) ** 2 + (ry - H / 2.0) ** 2) ** 0.5
            dist_norm = dist / (max(W, H) + 1e-6)
            score = (area / (W * H)) * 3.0 + fill * 2.0 - dist_norm * 2.5
            if score > best_score:
                best_score = score
                best = (int(x), int(y), int(w), int(h))
        return best

    preferred = max(0, 99)
    first_rect: Optional[tuple[int, int, int, int]] = None
    first_idx: Optional[int] = None
    cap.set(cv2.CAP_PROP_POS_FRAMES, preferred)
    ret, frame = cap.read()
    if ret and frame is not None:
        r = detect(frame)
        if r:
            first_rect, first_idx = r, preferred

    if first_rect is None:
        max_scan = min(frame_count, 900) if frame_count > 0 else 900
        for idx in range(max_scan):
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame = cap.read()
            if not ret or frame is None:
                continue
            r = detect(frame)
            if r:
                first_rect, first_idx = r, idx
                break

    if first_rect is None or first_idx is None:
        cap.release()
        return {
            "alpha_box": None, "keyframes": [], "slate_fit": None,
            "resolution": {"width": fw, "height": fh}, "fps": fps,
        }

    start_sec = round(first_idx / fps, 4)
    x, y, w, h = first_rect
    keyframes: list[dict[str, Any]] = [
        {"time_sec": start_sec, "x": x, "y": y, "w": w, "h": h}
    ]
    cap.release()

    alpha_box: Optional[dict[str, Any]] = None
    if (w * h) / max(1, fw * fh) >= 0.001:
        alpha_box = {"x": x, "y": y, "w": w, "h": h, "start_sec": start_sec}

    slate_fit = _compute_slate_fit(x, y, w, h, source_aspect=source_aspect)
    return {
        "alpha_box": alpha_box, "keyframes": keyframes, "slate_fit": slate_fit,
        "resolution": {"width": fw, "height": fh}, "fps": round(fps, 3),
    }
