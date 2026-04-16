"""
Main rendering engine. Orchestrates FFmpeg to composite the final video
from the design JSON, downloaded assets, and pre-rendered overlays.
"""
import os
import re
import math
import shutil
import asyncio
import subprocess
import tempfile
from typing import Optional

from .media import download_assets
from .text_renderer import (
    parse_css_px,
    parse_css_length,
    render_text_layer,
    render_caption_states,
    render_shape_overlay,
    render_progress_bar_frame,
)

# ── Supported feature sets ──────────────────────────────────────────
SUPPORTED_TRANSITIONS = {"none", "fade", "slide", "wipe", "circle", "rectangle"}
SKIPPED_ITEM_TYPES = {
    "linealAudioBars", "waveAudioBars", "hillAudioBars",
    "radialAudioBars", "illustration",
}

# Map DesignCombo transition kinds to FFmpeg xfade names
XFADE_MAP = {
    "fade": "fade",
    "slide": {
        "from-left": "slideleft",
        "from-right": "slideright",
        "from-top": "slideup",
        "from-bottom": "slidedown",
    },
    "wipe": {
        "from-left": "wipeleft",
        "from-right": "wiperight",
        "from-top": "wipeup",
        "from-bottom": "wipedown",
    },
    "circle": "circlecrop",
    "rectangle": "rectcrop",
}


def _probe_media_duration_sec(path: str) -> float:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return max(0.0, float((proc.stdout or "").strip() or 0))
    except (ValueError, TypeError):
        return 0.0


def _probe_resolution(path: str) -> tuple[int, int]:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                path,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        out = (proc.stdout or "").strip()
        if "x" in out:
            w, h = out.split("x")
            return int(float(w)), int(float(h))
    except Exception:
        pass
    return 0, 0


def _detect_black_box(path: str, sample_frames: int = 90, threshold: int = 12):
    """
    Detect black alpha hole (contour bbox) and when it first appears.
    Delegates to package_alpha temporal analysis; returns legacy {x,y,w,h,start_sec}.
    """
    from .package_alpha import analyze_package_alpha

    _ = sample_frames
    _ = threshold
    result = analyze_package_alpha(path)
    return result.get("alpha_box")


def _input_has_audio(path: str) -> bool:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                path,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return bool((proc.stdout or "").strip())
    except Exception:
        return False


def _resolve_source_trim(
    item: dict,
    local_path: str,
    d_from_sec: float,
    d_to_sec: float,
) -> tuple[float, float]:
    """
    Map timeline clip [d_from_sec, d_to_sec] to source trim [t_from, t_to] in seconds.
    Fills in missing/invalid trim using timeline length x playbackRate (matches Remotion).
    When probe fails (src_dur=0), trusts the timeline duration instead of producing
    a tiny 0.04s clip.
    """
    trim = item.get("trim") or {}
    t_from = float(trim.get("from", 0) or 0) / 1000.0
    t_to = float(trim.get("to", 0) or 0) / 1000.0
    pr = float(item.get("playbackRate", 1) or 1)
    src_dur = _probe_media_duration_sec(local_path)
    timeline_sec = max(0.001, d_to_sec - d_from_sec)

    if t_to <= t_from:
        need = timeline_sec * pr
        t_to = t_from + need

    if src_dur > 0:
        t_to = min(t_to, src_dur)
        t_from = min(t_from, max(0.0, src_dur - 0.001))
        if t_to <= t_from:
            t_to = t_from + max(timeline_sec * pr, 0.1)
            t_to = min(t_to, src_dur)
    else:
        print(f"[WARN] Could not probe duration for {local_path}, using timeline duration {timeline_sec}s")

    if t_to <= t_from:
        t_to = t_from + max(timeline_sec * pr, 0.1)

    return t_from, t_to


def _parse_scale_from_transform(transform: str) -> float:
    """Extract scale value from CSS transform string like 'scale(3)'."""
    if not transform or transform == "none":
        return 1.0
    m = re.search(r"scale\(([\d.]+)\)", transform)
    return float(m.group(1)) if m else 1.0


def _calculate_overlay_pos(left, top, width, height, scale):
    """Calculate FFmpeg overlay x,y accounting for CSS transform-origin center."""
    cx = left + width / 2
    cy = top + height / 2
    sw = width * scale
    sh = height * scale
    ox = cx - sw / 2
    oy = cy - sh / 2
    return int(round(ox)), int(round(oy)), max(2, int(round(sw))), max(2, int(round(sh)))


def _calculate_duration(design: dict) -> float:
    """Calculate total video duration in seconds from track items."""
    max_time = 0
    for item in design.get("trackItemsMap", {}).values():
        disp = item.get("display", {})
        end = disp.get("to", 0)
        if end > max_time:
            max_time = end
    return max_time / 1000.0


def _get_promo_role(item: dict) -> Optional[str]:
    metadata = item.get("metadata", {})
    details = item.get("details", {})
    return (
        metadata.get("promoRole")
        or details.get("promoRole")
        or item.get("promoRole")
    )


def _get_local_path(item: dict, asset_map: dict[str, str], prefer_original: bool = False) -> Optional[str]:
    metadata = item.get("metadata", {})
    details = item.get("details", {})
    item_id = item.get("id", "?")

    original_candidates = [
        ("metadata.originalSrc", metadata.get("originalSrc")),
        ("metadata.originalUrl", metadata.get("originalUrl")),
        ("details.originalSrc", details.get("originalSrc")),
    ]
    proxy_candidates = [
        ("metadata.proxySrc", metadata.get("proxySrc")),
        ("metadata.proxyUrl", metadata.get("proxyUrl")),
        ("details.src", details.get("src")),
        ("metadata.uploadedUrl", metadata.get("uploadedUrl")),
    ]

    candidates = (original_candidates + proxy_candidates) if prefer_original else proxy_candidates

    for label, key in candidates:
        if not key:
            continue
        if key in asset_map:
            is_original = label.startswith("metadata.original") or label.startswith("details.original")
            kind = "ORIGINAL" if is_original else "PROXY"
            print(f"[ENGINE] Item {item_id}: using {kind} via {label}")
            return asset_map[key]

    print(f"[WARN] Item {item_id}: no local path found in asset_map (prefer_original={prefer_original})")
    return None


def _clamp_alpha_start(start_sec: float, alpha_start: Optional[float], role: Optional[str]) -> float:
    if alpha_start is None or role is None:
        return start_sec
    if role in {"mute", "overlay", "text", "sponsorAudio", "audio", "programSlate"}:
        return max(start_sec, alpha_start)
    return start_sec


def _group_items_with_transitions(design: dict) -> list[list[dict]]:
    """
    Group track items by transition connections (same as frontend groupTrackItems).
    Returns list of groups, each group is a list of items/transitions.
    """
    items_map = design.get("trackItemsMap", {})
    trans_map = design.get("transitionsMap", {})
    item_ids = design.get("trackItemIds", [])

    # Build transition lookup
    from_map = {}
    for t in trans_map.values():
        if t.get("kind", "none") != "none":
            from_map[t["fromId"]] = t

    groups = []
    processed = set()

    for item_id in item_ids:
        if item_id in processed:
            continue
        # Check if this item is the target of a transition (skip, it'll be reached)
        is_target = any(
            t["toId"] == item_id and t.get("kind", "none") != "none"
            for t in trans_map.values()
        )
        if is_target and item_id not in processed:
            continue

        group = []
        current = item_id
        while current and current not in processed:
            processed.add(current)
            if current in items_map:
                group.append(items_map[current])
            t = from_map.get(current)
            if t:
                group.append(t)
                current = t["toId"]
            else:
                current = None
        if group:
            groups.append(group)

    return groups


async def render_design(
    design_dict: dict,
    options: dict,
    work_dir: str,
    progress_callback=None,
) -> str:
    """
    Main render function. Returns path to the output MP4.
    """
    fps = options.get("fps", design_dict.get("fps", 30))
    canvas_w = design_dict.get("size", {}).get("width", 1080)
    canvas_h = design_dict.get("size", {}).get("height", 1920)
    duration = _calculate_duration(design_dict)

    if duration <= 0:
        raise ValueError("Design has zero duration")

    os.makedirs(work_dir, exist_ok=True)
    overlays_dir = os.path.join(work_dir, "overlays")
    os.makedirs(overlays_dir, exist_ok=True)

    import json
    with open(os.path.join(work_dir, "design.json"), "w") as _djf:
        json.dump(design_dict, _djf, indent=2, default=str)

    # ── Step 1: Download assets ───────────────────────────────────
    if progress_callback:
        await progress_callback(5, "Downloading assets...")
    asset_map = await download_assets(design_dict, work_dir)

    # ── Step 1b: detect package + alpha box, prefer original sources ─────────
    track_items_map = design_dict.get("trackItemsMap", {})
    package_path = None
    package_item = next(
        (itm for itm in track_items_map.values() if _get_promo_role(itm) == "package"),
        None,
    )
    alpha_info = None
    if package_item:
        package_path = _get_local_path(package_item, asset_map, prefer_original=True)
        if package_path:
            pw, ph = _probe_resolution(package_path)
            if pw and ph:
                canvas_w, canvas_h = pw, ph
            alpha_info = _detect_black_box(package_path)

    alpha_hole_rect = None
    if alpha_info and all(k in alpha_info for k in ("x", "y", "w", "h")):
        alpha_hole_rect = (
            int(alpha_info["x"]),
            int(alpha_info["y"]),
            int(alpha_info["w"]),
            int(alpha_info["h"]),
        )
    print(f"[ENGINE] Alpha detection: alpha_info={alpha_info}, alpha_hole_rect={alpha_hole_rect}")

    # ── Step 2: Prepare inputs and filters ────────────────────────
    if progress_callback:
        await progress_callback(15, "Preparing layers...")

    inputs = []          # FFmpeg input arg lists (each is a list of strings)
    filter_parts = []    # filter_complex parts
    audio_labels = []    # labels of audio streams to mix
    overlay_idx = 0      # counter for overlay labels
    input_idx = 0        # counter for input index

    # Input 0: base canvas (package loop or solid color background)
    if package_path:
        inputs.append(["-stream_loop", "-1", "-i", package_path])
        base_label = "pkg0"
        filter_parts.append(f"[0:v]scale={canvas_w}:{canvas_h},format=rgba[{base_label}]")
        current_video_label = base_label
        input_idx = 1
        if _input_has_audio(package_path):
            a_label = "pkg_a0"
            filter_parts.append(
                f"[0:a]atrim=0:{duration},asetpts=PTS-STARTPTS[{a_label}]"
            )
            audio_labels.append(a_label)
    else:
        bg_color = "black"
        bg_data = design_dict.get("background", {})
        if isinstance(bg_data, dict) and bg_data.get("type") == "color":
            bg_color = bg_data.get("value", "black")
        elif isinstance(bg_data, str):
            bg_color = bg_data if bg_data != "transparent" else "black"

        inputs.append([
            "-f", "lavfi", "-i",
            f"color=c={_escape_ffmpeg_color(bg_color)}:s={canvas_w}x{canvas_h}:r={fps}:d={duration}"
        ])
        current_video_label = "0:v"
        input_idx = 1

    # Sort items by track order (trackItemIds defines z-order)
    items_map = track_items_map
    item_ids = design_dict.get("trackItemIds", [])
    role_priority = {
        "package": 0,
        "backgroundMusic": 1,
        "programSlate": 2,
        "sponsorAudio": 3,
        "audio": 3,
        "mute": 4,
        "overlay": 5,
        "text": 6,
    }
    if item_ids:
        item_ids = sorted(
            item_ids,
            key=lambda i: role_priority.get(_get_promo_role(items_map.get(i, {})) or items_map.get(i, {}).get("type"), 50),
        )
        design_dict["trackItemIds"] = item_ids
    trans_map = design_dict.get("transitionsMap", {})

    # Pair mutes with sponsor audios (by order on timeline) to stretch video to audio duration
    sponsor_audios = [itm for itm in track_items_map.values() if _get_promo_role(itm) in {"sponsorAudio", "audio"}]
    mutes = [itm for itm in track_items_map.values() if _get_promo_role(itm) == "mute"]

    def _stem(name: str) -> set[str]:
        import re
        tokens = re.sub(r"[^a-z0-9]+", " ", name.lower()).split()
        return set(t for t in tokens if len(t) > 1)

    def _name(item: dict) -> str:
        details = item.get("details", {})
        return details.get("name") or details.get("fileName") or details.get("src") or item.get("id") or ""

    mute_targets: dict[str, float] = {}
    used_audios = set()
    for mute in mutes:
        m_name = _name(mute)
        m_tokens = _stem(m_name)
        best = None
        best_score = -1
        for aud in sponsor_audios:
            if aud.get("id") in used_audios:
                continue
            a_name = _name(aud)
            a_tokens = _stem(a_name)
            score = len(m_tokens & a_tokens)
            if score > best_score:
                best_score = score
                best = aud
        if best:
            used_audios.add(best.get("id"))
            aud_path = _get_local_path(best, asset_map, prefer_original=True)
            if aud_path:
                dur = _probe_media_duration_sec(aud_path)
                if dur > 0:
                    mute_targets[mute.get("id")] = dur

    # Process groups (items connected by transitions)
    groups = _group_items_with_transitions(design_dict)

    for group in groups:
        # Separate items and transitions in the group
        items_in_group = [g for g in group if "type" in g and g.get("type") != "transition"]
        transitions_in_group = [g for g in group if g.get("type") == "transition" or "fromId" in g]

        if not items_in_group:
            continue

        first_item = items_in_group[0]
        item_type = first_item.get("type", "")
        item_role = _get_promo_role(first_item)

        # Skip unsupported types
        if item_type in SKIPPED_ITEM_TYPES:
            continue
        if item_role == "package":
            # already used as base layer
            continue

        # ── VIDEO items ───────────────────────────────────────────
        if item_type == "video":
            if len(items_in_group) == 1 and not transitions_in_group:
                # Single video, no transitions
                result = _process_single_video(
                    first_item, asset_map, inputs, filter_parts,
                    input_idx, current_video_label, canvas_w, canvas_h, fps,
                    stretch_targets=mute_targets,
                    alpha_start=alpha_info["start_sec"] if alpha_info else None,
                    alpha_hole_rect=alpha_hole_rect,
                    total_video_duration=duration,
                )
                if result:
                    input_idx = result["next_input_idx"]
                    current_video_label = result["video_label"]
                    if result.get("audio_label"):
                        audio_labels.append(result["audio_label"])
            else:
                # Multiple videos with transitions
                result = _process_video_group_with_transitions(
                    items_in_group, transitions_in_group, asset_map,
                    inputs, filter_parts, input_idx,
                    current_video_label, canvas_w, canvas_h, fps,
                    alpha_start=alpha_info["start_sec"] if alpha_info else None,
                )
                if result:
                    input_idx = result["next_input_idx"]
                    current_video_label = result["video_label"]
                    for al in result.get("audio_labels", []):
                        audio_labels.append(al)

        # ── AUDIO items ───────────────────────────────────────────
        elif item_type == "audio":
            result = _process_audio(
                first_item, asset_map, inputs, filter_parts, input_idx, fps,
                alpha_start=alpha_info["start_sec"] if alpha_info else None,
                total_duration=duration,
            )
            if result:
                input_idx = result["next_input_idx"]
                if result.get("audio_label"):
                    audio_labels.append(result["audio_label"])

        # ── IMAGE items ───────────────────────────────────────────
        elif item_type == "image":
            result = _process_image(
                first_item, asset_map, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps,
                alpha_start=alpha_info["start_sec"] if alpha_info else None,
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── TEXT items ────────────────────────────────────────────
        elif item_type == "text":
            result = _process_text(
                first_item, asset_map, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps,
                alpha_start=alpha_info["start_sec"] if alpha_info else None,
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── CAPTION items ─────────────────────────────────────────
        elif item_type == "caption":
            result = _process_caption(
                first_item, asset_map, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── SHAPE items ───────────────────────────────────────────
        elif item_type == "shape":
            result = _process_shape(
                first_item, asset_map, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── PROGRESS BAR items ────────────────────────────────────
        elif item_type == "progressBar":
            result = await _process_progress_bar(
                first_item, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── PROGRESS FRAME items ──────────────────────────────────
        elif item_type == "progressFrame":
            result = await _process_progress_bar(
                first_item, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

    # ── Step 3: Audio mixing ──────────────────────────────────────
    audio_out_label = None
    if audio_labels:
        if len(audio_labels) == 1:
            audio_out_label = audio_labels[0]
        else:
            mix_inputs = "".join(f"[{l}]" for l in audio_labels)
            audio_out_label = "amixed"
            weights = " ".join("1" for _ in audio_labels)
            filter_parts.append(
                f"{mix_inputs}amix=inputs={len(audio_labels)}:"
                f"duration=longest:dropout_transition=0:"
                f"normalize=0:weights={weights}[{audio_out_label}]"
            )

    # ── Step 4: Build and run FFmpeg command ───────────────────────
    if progress_callback:
        await progress_callback(30, "Rendering video...")

    output_path = os.path.join(work_dir, "output.mp4")

    cmd_parts = ["ffmpeg", "-y"]
    for inp in inputs:
        cmd_parts.extend(inp)

    # Only add filter_complex if we have filters
    if filter_parts:
        filter_complex = ";\n".join(filter_parts)
        cmd_parts.extend(["-filter_complex", filter_complex])
        cmd_parts.extend(["-map", f"[{current_video_label}]"])
        if audio_out_label:
            cmd_parts.extend(["-map", f"[{audio_out_label}]"])
    else:
        # No filters: direct passthrough of canvas
        pass

    cmd_parts.extend([
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ])
    if audio_out_label:
        cmd_parts.extend(["-c:a", "aac", "-b:a", "192k"])
    else:
        cmd_parts.extend(["-an"])
    cmd_parts.extend(["-t", str(duration)])
    cmd_parts.append(output_path)

    print(f"[ENGINE] Canvas: {canvas_w}x{canvas_h}, duration: {duration}s, fps: {fps}")
    print(f"[ENGINE] Total inputs: {len(inputs)}, audio streams: {len(audio_labels)}")
    if filter_parts:
        print(f"[ENGINE] filter_complex ({len(filter_parts)} parts):")
        for i, fp in enumerate(filter_parts):
            print(f"  [{i}] {fp}")
    cmd_safe = []
    for p in cmd_parts:
        if "\n" in p:
            cmd_safe.append(repr(p)[:200])
        else:
            cmd_safe.append(p)
    print(f"[ENGINE] FFmpeg command:\n  {' '.join(cmd_safe)}")

    proc = await asyncio.create_subprocess_exec(
        *cmd_parts,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        err_text = stderr.decode()[-4000:]
        print(f"[ENGINE] FFmpeg FAILED (code {proc.returncode}):\n{err_text}")
        raise RuntimeError(f"FFmpeg failed (code {proc.returncode}): {err_text}")
    else:
        print(f"[ENGINE] FFmpeg completed successfully: {output_path}")

    if progress_callback:
        await progress_callback(100, "Complete")

    return output_path


# ═══════════════════════════════════════════════════════════════════
# Layer processors
# ═══════════════════════════════════════════════════════════════════


def _process_single_video(
    item, asset_map, inputs, filters, input_idx,
    current_label, canvas_w, canvas_h, fps,
    stretch_targets=None,
    alpha_start=None,
    alpha_hole_rect=None,
    total_video_duration=None,
):
    details = item.get("details", {})
    role = _get_promo_role(item)
    local_path = _get_local_path(item, asset_map, prefer_original=True)
    if not local_path:
        return None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0
    d_from = _clamp_alpha_start(d_from, alpha_start, role)

    t_from, t_to = _resolve_source_trim(item, local_path, d_from, d_to)
    target_dur = None
    if stretch_targets and item.get("id") in stretch_targets:
        target_dur = stretch_targets.get(item.get("id"))

    playback_rate = item.get("playbackRate", 1) or 1
    if role == "mute" and target_dur and target_dur > 0:
        actual = t_to - t_from
        if actual > 0:
            playback_rate = actual / target_dur
    volume = (details.get("volume", 100) or 100) / 100.0
    scale = _parse_scale_from_transform(details.get("transform", "none"))

    left = parse_css_px(details.get("left", 0))
    top = parse_css_px(details.get("top", 0))
    w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
    h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))
    crop = details.get("crop")

    # For hole-bound videos (mute/programSlate/video): force-fit into the alpha hole rect.
    # The client may fail to set proper dimensions (timing race in applyHoleLayoutAfterPromoAdd),
    # so the server always uses the detected alpha hole as the authoritative source.
    _HOLE_ROLES = ("programSlate", "mute", "video")
    if alpha_hole_rect and role in _HOLE_ROLES:
        ax, ay, aw, ah = (int(alpha_hole_rect[0]), int(alpha_hole_rect[1]),
                          int(alpha_hole_rect[2]), int(alpha_hole_rect[3]))
        left = float(ax)
        top = float(ay)
        w = float(aw)
        h = float(ah)
        scale = 1.0
        crop = None
        print(f"[ENGINE] Video {item.get('id','?')}: role={role}, "
              f"OVERRIDING to alpha hole: left={left} top={top} w={w} h={h}")

    ox, oy, sw, sh = _calculate_overlay_pos(left, top, w, h, scale)

    print(f"[ENGINE] Video {item.get('id','?')}: role={role}, "
          f"raw left={details.get('left')}, top={details.get('top')}, "
          f"width={details.get('width')}, height={details.get('height')}, "
          f"parsed l={left} t={top} w={w} h={h}, "
          f"overlay ox={ox} oy={oy} sw={sw} sh={sh}, scale={scale}, "
          f"crop={crop}, alpha_hole={alpha_hole_rect}")

    opacity = (details.get("opacity", 100) or 100) / 100.0
    brightness = (details.get("brightness", 100) or 100) / 100.0
    blur_val = details.get("blur", 0) or 0
    flip_x = details.get("flipX", False)
    flip_y = details.get("flipY", False)
    rotate_deg = parse_css_px(details.get("rotate", "0deg").replace("deg", ""))

    # Build input with seeking for reliable codec compatibility
    trim_dur = t_to - t_from
    input_args = []
    if t_from > 0.01:
        input_args.extend(["-ss", str(t_from)])
    input_args.extend(["-t", str(trim_dur), "-i", local_path])
    inputs.append(input_args)
    v_label = f"v{input_idx}"

    # Build video filter chain (no trim filter needed -- seeking done at input level)
    v_filters = []
    v_filters.append("setpts=PTS-STARTPTS")

    if playback_rate != 1:
        v_filters.append(f"setpts=PTS/{playback_rate}")

    if crop and crop.get("width") and crop.get("height"):
        v_filters.append(
            f"crop={int(crop['width'])}:{int(crop['height'])}:"
            f"{int(crop.get('x', 0))}:{int(crop.get('y', 0))}"
        )

    v_filters.append(f"scale={sw}:{sh}")

    if flip_x:
        v_filters.append("hflip")
    if flip_y:
        v_filters.append("vflip")

    if rotate_deg and rotate_deg != 0:
        v_filters.append(
            f"rotate={rotate_deg}*PI/180:fillcolor=none:ow=rotw({rotate_deg}*PI/180):oh=roth({rotate_deg}*PI/180)"
        )

    if brightness != 1.0:
        v_filters.append(f"eq=brightness={brightness - 1.0}")

    if blur_val > 0:
        v_filters.append(f"boxblur={int(blur_val)}:{int(blur_val)}")

    if opacity < 1.0:
        v_filters.append(f"format=rgba,colorchannelmixer=aa={opacity}")

    next_label = f"ov{input_idx}"

    use_hole = (
        alpha_hole_rect
        and role in _HOLE_ROLES
        and total_video_duration
        and float(total_video_duration) > 0
    )

    if use_hole:
        ax, ay, aw, ah = (int(alpha_hole_rect[0]), int(alpha_hole_rect[1]),
                          int(alpha_hole_rect[2]), int(alpha_hole_rect[3]))
        pad_x = max(0, ox)
        pad_y = max(0, oy)
        v_filters.append(f"pad={canvas_w}:{canvas_h}:{pad_x}:{pad_y}:black@0")
        v_filters.append("format=rgba")
        filter_chain = ",".join(v_filters)
        vp_lbl = f"vpad{input_idx}"
        mk_lbl = f"mskh{input_idx}"
        filters.append(f"[{input_idx}:v]{filter_chain}[{vp_lbl}]")
        td = float(total_video_duration)
        filters.append(
            f"color=c=black@0:s={canvas_w}x{canvas_h}:r={fps}:d={td},"
            f"format=rgba,drawbox=x={ax}:y={ay}:w={aw}:h={ah}:color=white@1:t=fill[{mk_lbl}]"
        )
        # alphamerge first, THEN tpad — tpad before alphamerge would turn
        # transparent padding into opaque black (mask forces alpha=255 in hole)
        merged_lbl = f"mrg{input_idx}"
        filters.append(f"[{vp_lbl}][{mk_lbl}]alphamerge[{merged_lbl}]")
        overlay_src = merged_lbl
        if d_from > 0.001:
            tp_lbl = f"tp{input_idx}"
            filters.append(f"[{merged_lbl}]tpad=start_duration={d_from}:color=black@0[{tp_lbl}]")
            overlay_src = tp_lbl
        filters.append(
            f"[{current_label}][{overlay_src}]overlay=0:0:eof_action=pass:format=auto[{next_label}]"
        )
    else:
        v_filters.append("format=rgba")
        if d_from > 0.001:
            v_filters.append(f"tpad=start_duration={d_from}:color=black@0")
        filter_chain = ",".join(v_filters)
        filters.append(f"[{input_idx}:v]{filter_chain}[{v_label}]")
        filters.append(
            f"[{current_label}][{v_label}]overlay={ox}:{oy}:eof_action=pass:format=auto[{next_label}]"
        )

    # Audio (input already seeked via -ss/-t, so no atrim needed)
    a_label = None
    if volume > 0 and _input_has_audio(local_path):
        a_label = f"a{input_idx}"
        a_filters = []
        a_filters.append("asetpts=PTS-STARTPTS")
        if playback_rate != 1:
            rate = max(0.5, min(100.0, playback_rate))
            a_filters.append(f"atempo={rate}")
        a_filters.append(f"volume={volume}")
        if d_from > 0:
            delay_ms = int(d_from * 1000)
            a_filters.append(f"adelay={delay_ms}|{delay_ms}")
        a_chain = ",".join(a_filters)
        filters.append(f"[{input_idx}:a]{a_chain}[{a_label}]")

    return {
        "next_input_idx": input_idx + 1,
        "video_label": next_label,
        "audio_label": a_label,
    }


def _process_video_group_with_transitions(
    items, transitions, asset_map, inputs, filters,
    input_idx, current_label, canvas_w, canvas_h, fps,
    alpha_start=None,
):
    """Process multiple video items connected by transitions using xfade."""
    if not items:
        return None

    audio_labels = []
    video_labels = []

    # First, prepare each video as a separate stream
    for item in items:
        details = item.get("details", {})
        local_path = _get_local_path(item, asset_map, prefer_original=True)
        if not local_path:
            continue

        display = item.get("display", {})
        role = _get_promo_role(item)
        d_from = display.get("from", 0) / 1000.0
        d_to = display.get("to", 0) / 1000.0
        d_from = _clamp_alpha_start(d_from, alpha_start, role)
        dur = d_to - d_from

        t_from, t_to = _resolve_source_trim(item, local_path, d_from, d_to)

        playback_rate = item.get("playbackRate", 1) or 1
        volume = (details.get("volume", 100) or 100) / 100.0
        scale = _parse_scale_from_transform(details.get("transform", "none"))

        left = parse_css_px(details.get("left", 0))
        top_val = parse_css_px(details.get("top", 0))
        w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
        h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))
        _, _, sw, sh = _calculate_overlay_pos(left, top_val, w, h, scale)

        trim_dur = t_to - t_from
        input_args = []
        if t_from > 0.01:
            input_args.extend(["-ss", str(t_from)])
        input_args.extend(["-t", str(trim_dur), "-i", local_path])
        inputs.append(input_args)
        v_label = f"xv{input_idx}"

        v_filters = [
            "setpts=PTS-STARTPTS",
            f"scale={sw}:{sh}",
            "format=rgba",
        ]
        if playback_rate != 1:
            v_filters.insert(1, f"setpts=PTS/{playback_rate}")

        filters.append(f"[{input_idx}:v]{','.join(v_filters)}[{v_label}]")
        video_labels.append((v_label, dur, item))

        # Audio (input already seeked via -ss/-t)
        if volume > 0 and _input_has_audio(local_path):
            a_label = f"xa{input_idx}"
            a_filters = ["asetpts=PTS-STARTPTS"]
            if playback_rate != 1:
                a_filters.append(f"atempo={max(0.5, min(100.0, playback_rate))}")
            a_filters.append(f"volume={volume}")
            if d_from > 0:
                delay_ms = int(d_from * 1000)
                a_filters.append(f"adelay={delay_ms}|{delay_ms}")
            filters.append(f"[{input_idx}:a]{','.join(a_filters)}[{a_label}]")
            audio_labels.append(a_label)

        input_idx += 1

    if not video_labels:
        return None

    # Chain videos with xfade transitions
    result_label = video_labels[0][0]
    offset_acc = video_labels[0][1]

    for i, trans in enumerate(transitions):
        if i + 1 >= len(video_labels):
            break

        next_label = video_labels[i + 1][0]
        next_dur = video_labels[i + 1][1]
        t_dur = trans.get("duration", 500) / 1000.0
        kind = trans.get("kind", "fade")

        xfade_name = _get_xfade_name(kind, trans.get("direction"))
        offset = max(0, offset_acc - t_dur)

        out_label = f"xf{input_idx}_{i}"
        filters.append(
            f"[{result_label}][{next_label}]xfade=transition={xfade_name}:"
            f"duration={t_dur}:offset={offset}[{out_label}]"
        )
        result_label = out_label
        offset_acc += next_dur - t_dur

    # Overlay the xfaded result onto the current canvas
    first_item = items[0]
    last_item = items[-1]
    d_from = first_item.get("display", {}).get("from", 0) / 1000.0
    d_to = last_item.get("display", {}).get("to", 0) / 1000.0
    details = first_item.get("details", {})
    left = parse_css_px(details.get("left", 0))
    top_val = parse_css_px(details.get("top", 0))
    w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
    h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))
    s = _parse_scale_from_transform(details.get("transform", "none"))
    ox, oy, _, _ = _calculate_overlay_pos(left, top_val, w, h, s)

    if d_from > 0.001:
        tpad_lbl = f"tpg{input_idx}"
        filters.append(
            f"[{result_label}]format=rgba,tpad=start_duration={d_from}:color=black@0[{tpad_lbl}]"
        )
        result_label = tpad_lbl

    final_label = f"ovg{input_idx}"
    filters.append(
        f"[{current_label}][{result_label}]overlay={ox}:{oy}:eof_action=pass:format=auto[{final_label}]"
    )

    return {
        "next_input_idx": input_idx,
        "video_label": final_label,
        "audio_labels": audio_labels,
    }


def _process_audio(item, asset_map, inputs, filters, input_idx, fps, alpha_start=None, total_duration=None):
    details = item.get("details", {})
    role = _get_promo_role(item)
    local_path = _get_local_path(item, asset_map, prefer_original=True)
    if not local_path:
        return None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_from = _clamp_alpha_start(d_from, alpha_start, role)

    trim = item.get("trim", {})
    t_from = trim.get("from", 0) / 1000.0 if trim else 0
    t_to = trim.get("to", 0) / 1000.0 if trim else 99999

    playback_rate = item.get("playbackRate", 1) or 1
    volume = (details.get("volume", 100) or 100) / 100.0

    is_bgm = role == "backgroundMusic" and total_duration

    input_args = []
    if is_bgm:
        input_args.extend(["-stream_loop", "-1"])
    if t_from > 0.01 and not is_bgm:
        input_args.extend(["-ss", str(t_from)])
    if not is_bgm and t_to < 99000:
        trim_dur = t_to - t_from
        input_args.extend(["-t", str(trim_dur)])
    input_args.extend(["-i", local_path])
    inputs.append(input_args)

    a_label = f"au{input_idx}"

    a_filters = ["asetpts=PTS-STARTPTS"]
    if is_bgm:
        if t_from > 0.01:
            a_filters.append(f"atrim={t_from}")
            a_filters.append("asetpts=PTS-STARTPTS")
        a_filters.append(f"atrim=0:{total_duration}")
        a_filters.append("asetpts=PTS-STARTPTS")
    if playback_rate != 1:
        a_filters.append(f"atempo={max(0.5, min(100.0, playback_rate))}")
    a_filters.append(f"volume={volume}")
    if d_from > 0:
        delay_ms = int(d_from * 1000)
        a_filters.append(f"adelay={delay_ms}|{delay_ms}")

    filters.append(f"[{input_idx}:a]{','.join(a_filters)}[{a_label}]")

    return {
        "next_input_idx": input_idx + 1,
        "audio_label": a_label,
    }


def _process_image(
    item, asset_map, inputs, filters, input_idx,
    current_label, canvas_w, canvas_h, fps,
    alpha_start=None,
):
    details = item.get("details", {})
    local_path = _get_local_path(item, asset_map, prefer_original=True)
    if not local_path:
        return None

    display = item.get("display", {})
    role = _get_promo_role(item)
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0
    d_from = _clamp_alpha_start(d_from, alpha_start, role)

    scale = _parse_scale_from_transform(details.get("transform", "none"))
    left = parse_css_px(details.get("left", 0))
    top_val = parse_css_px(details.get("top", 0))
    w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
    h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))
    ox, oy, sw, sh = _calculate_overlay_pos(left, top_val, w, h, scale)

    opacity = (details.get("opacity", 100) or 100) / 100.0
    flip_x = details.get("flipX", False)
    flip_y = details.get("flipY", False)
    crop = details.get("crop")

    inputs.append(["-i", local_path])
    v_label = f"img{input_idx}"

    v_filters = ["loop=loop=-1:size=1:start=0"]
    if crop and crop.get("width") and crop.get("height"):
        v_filters.append(
            f"crop={int(crop['width'])}:{int(crop['height'])}:"
            f"{int(crop.get('x', 0))}:{int(crop.get('y', 0))}"
        )
    v_filters.append(f"scale={sw}:{sh}")
    if flip_x:
        v_filters.append("hflip")
    if flip_y:
        v_filters.append("vflip")
    if opacity < 1.0:
        v_filters.append(f"format=rgba,colorchannelmixer=aa={opacity}")
    v_filters.append("format=rgba")

    filters.append(f"[{input_idx}:v]{','.join(v_filters)}[{v_label}]")

    next_label = f"ov{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{v_label}]overlay={ox}:{oy}:{enable}:format=auto[{next_label}]"
    )

    return {
        "next_input_idx": input_idx + 1,
        "video_label": next_label,
    }


def _process_text(
    item, asset_map, overlays_dir, inputs, filters,
    input_idx, current_label, canvas_w, canvas_h, fps,
    alpha_start=None,
):
    details = item.get("details", {})
    font_url = details.get("fontUrl")
    font_path = asset_map.get(font_url) if font_url else None
    if font_url and not font_path:
        print(f"[WARN] Font not resolved for text item {item.get('id')}: {font_url}")

    display = item.get("display", {})
    role = _get_promo_role(item)
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0
    d_from = _clamp_alpha_start(d_from, alpha_start, role)

    layer_img, box_w, box_h = render_text_layer(
        details, (canvas_w, canvas_h), font_path
    )
    png_path = os.path.join(overlays_dir, f"text_{item['id']}.png")
    layer_img.save(png_path)

    scale = _parse_scale_from_transform(details.get("transform", "none"))
    left = parse_css_px(details.get("left", 0))
    top_val = parse_css_px(details.get("top", 0))
    ox, oy, sw, sh = _calculate_overlay_pos(
        left, top_val, float(box_w), float(box_h), scale
    )

    opacity = (details.get("opacity", 100) or 100) / 100.0
    brightness = (details.get("brightness", 100) or 100) / 100.0
    blur_val = details.get("blur", 0) or 0
    flip_x = details.get("flipX", False)
    flip_y = details.get("flipY", False)
    rotate_deg = parse_css_px(str(details.get("rotate", "0deg")).replace("deg", ""))

    inputs.append(["-i", png_path])
    v_label = f"txt{input_idx}"
    v_filters = [f"scale={int(sw)}:{int(sh)}"]
    if flip_x:
        v_filters.append("hflip")
    if flip_y:
        v_filters.append("vflip")
    if rotate_deg and rotate_deg != 0:
        v_filters.append(
            f"rotate={rotate_deg}*PI/180:fillcolor=none:"
            f"ow=rotw({rotate_deg}*PI/180):oh=roth({rotate_deg}*PI/180)"
        )
    if brightness != 1.0:
        v_filters.append(f"eq=brightness={brightness - 1.0}")
    if blur_val > 0:
        v_filters.append(f"boxblur={int(blur_val)}:{int(blur_val)}")
    if opacity < 1.0:
        v_filters.append(f"format=rgba,colorchannelmixer=aa={opacity}")
    v_filters.append("format=rgba")
    filters.append(f"[{input_idx}:v]{','.join(v_filters)}[{v_label}]")

    next_label = f"ov{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{v_label}]overlay={ox}:{oy}:{enable}:format=auto[{next_label}]"
    )

    return {
        "next_input_idx": input_idx + 1,
        "video_label": next_label,
    }


def _process_caption(
    item, asset_map, overlays_dir, inputs, filters,
    input_idx, current_label, canvas_w, canvas_h, fps
):
    details = item.get("details", {})
    font_url = details.get("fontUrl")
    font_path = asset_map.get(font_url) if font_url else None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0

    states = render_caption_states(details, (canvas_w, canvas_h), d_from, font_path)
    if not states:
        return None

    current = current_label
    for si, state in enumerate(states):
        png_path = os.path.join(overlays_dir, f"cap_{item['id']}_{si}.png")
        state["image"].save(png_path)

        inputs.append(["-i", png_path])
        v_label = f"cap{input_idx}_{si}"
        filters.append(f"[{input_idx}:v]format=rgba[{v_label}]")

        next_label = f"ovc{input_idx}_{si}"
        enable = f"enable='between(t,{state['start_sec']},{state['end_sec']})'"
        filters.append(
            f"[{current}][{v_label}]overlay=0:0:{enable}:format=auto[{next_label}]"
        )
        current = next_label
        input_idx += 1

    return {
        "next_input_idx": input_idx,
        "video_label": current,
    }


def _process_shape(
    item, asset_map, overlays_dir, inputs, filters,
    input_idx, current_label, canvas_w, canvas_h, fps
):
    details = item.get("details", {})
    src = details.get("src", "")
    svg_path = asset_map.get(src)

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0

    img = render_shape_overlay(details, (canvas_w, canvas_h), svg_path)
    if img is None:
        return None

    png_path = os.path.join(overlays_dir, f"shape_{item['id']}.png")
    img.save(png_path)

    inputs.append(["-i", png_path])
    v_label = f"shp{input_idx}"
    filters.append(f"[{input_idx}:v]format=rgba[{v_label}]")

    next_label = f"ov{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{v_label}]overlay=0:0:{enable}:format=auto[{next_label}]"
    )

    return {
        "next_input_idx": input_idx + 1,
        "video_label": next_label,
    }


async def _process_progress_bar(
    item, overlays_dir, inputs, filters, input_idx,
    current_label, canvas_w, canvas_h, fps
):
    """Render progress bar as a sequence of frames, then overlay as video."""
    details = item.get("details", {})
    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0
    duration = d_to - d_from
    num_frames = max(1, int(duration * fps))

    frame_dir = os.path.join(overlays_dir, f"prog_{item['id']}")
    os.makedirs(frame_dir, exist_ok=True)

    for fi in range(num_frames):
        progress = (fi / max(1, num_frames - 1)) * 100
        img = render_progress_bar_frame(details, (canvas_w, canvas_h), progress)
        img.save(os.path.join(frame_dir, f"frame_{fi:05d}.png"))

    # Create video from frames
    frame_pattern = os.path.join(frame_dir, "frame_%05d.png")
    inputs.append(["-framerate", str(fps), "-i", frame_pattern])
    v_label = f"prog{input_idx}"
    filters.append(f"[{input_idx}:v]format=rgba[{v_label}]")

    next_label = f"ov{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{v_label}]overlay=0:0:{enable}:format=auto[{next_label}]"
    )

    return {
        "next_input_idx": input_idx + 1,
        "video_label": next_label,
    }


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════


def _get_xfade_name(kind: str, direction: Optional[str] = None) -> str:
    mapping = XFADE_MAP.get(kind)
    if isinstance(mapping, dict):
        return mapping.get(direction or "from-left", "fade")
    elif isinstance(mapping, str):
        return mapping
    return "fade"


def _escape_ffmpeg_color(color: str) -> str:
    """Ensure color is FFmpeg-compatible."""
    if color.startswith("#"):
        return f"0x{color[1:]}"
    if color == "transparent":
        return "black@0"
    return color
