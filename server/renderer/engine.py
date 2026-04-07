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
    Fills in missing/invalid trim using timeline length × playbackRate (matches Remotion).
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
        t_to = min(src_dur, t_from + 0.04) if src_dur > 0 else t_from + 0.04

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
    return int(ox), int(oy), int(sw), int(sh)


def _calculate_duration(design: dict) -> float:
    """Calculate total video duration in seconds from track items."""
    max_time = 0
    for item in design.get("trackItemsMap", {}).values():
        disp = item.get("display", {})
        end = disp.get("to", 0)
        if end > max_time:
            max_time = end
    return max_time / 1000.0


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

    # ── Step 1: Download assets ───────────────────────────────────
    if progress_callback:
        await progress_callback(5, "Downloading assets...")
    asset_map = await download_assets(design_dict, work_dir)

    # ── Step 2: Prepare inputs and filters ────────────────────────
    if progress_callback:
        await progress_callback(15, "Preparing layers...")

    inputs = []          # FFmpeg input arg lists (each is a list of strings)
    filter_parts = []    # filter_complex parts
    audio_labels = []    # labels of audio streams to mix
    overlay_idx = 0      # counter for overlay labels
    input_idx = 0        # counter for input index

    # Input 0: base canvas (solid color background)
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
    items_map = design_dict.get("trackItemsMap", {})
    item_ids = design_dict.get("trackItemIds", [])
    trans_map = design_dict.get("transitionsMap", {})

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

        # Skip unsupported types
        if item_type in SKIPPED_ITEM_TYPES:
            continue

        # ── VIDEO items ───────────────────────────────────────────
        if item_type == "video":
            if len(items_in_group) == 1 and not transitions_in_group:
                # Single video, no transitions
                result = _process_single_video(
                    first_item, asset_map, inputs, filter_parts,
                    input_idx, current_video_label, canvas_w, canvas_h, fps
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
                    current_video_label, canvas_w, canvas_h, fps
                )
                if result:
                    input_idx = result["next_input_idx"]
                    current_video_label = result["video_label"]
                    for al in result.get("audio_labels", []):
                        audio_labels.append(al)

        # ── AUDIO items ───────────────────────────────────────────
        elif item_type == "audio":
            result = _process_audio(
                first_item, asset_map, inputs, filter_parts, input_idx, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                if result.get("audio_label"):
                    audio_labels.append(result["audio_label"])

        # ── IMAGE items ───────────────────────────────────────────
        elif item_type == "image":
            result = _process_image(
                first_item, asset_map, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
            )
            if result:
                input_idx = result["next_input_idx"]
                current_video_label = result["video_label"]

        # ── TEXT items ────────────────────────────────────────────
        elif item_type == "text":
            result = _process_text(
                first_item, asset_map, overlays_dir, inputs, filter_parts,
                input_idx, current_video_label, canvas_w, canvas_h, fps
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
            filter_parts.append(
                f"{mix_inputs}amix=inputs={len(audio_labels)}:"
                f"duration=longest:dropout_transition=0[{audio_out_label}]"
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

    print(f"[ENGINE] Running FFmpeg command:")
    print(f"  {' '.join(cmd_parts[:20])}...")

    proc = await asyncio.create_subprocess_exec(
        *cmd_parts,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        err_text = stderr.decode()[-2000:]
        print(f"[ENGINE] FFmpeg error:\n{err_text}")
        raise RuntimeError(f"FFmpeg failed (code {proc.returncode}): {err_text}")

    if progress_callback:
        await progress_callback(100, "Complete")

    return output_path


# ═══════════════════════════════════════════════════════════════════
# Layer processors
# ═══════════════════════════════════════════════════════════════════


def _process_single_video(
    item, asset_map, inputs, filters, input_idx,
    current_label, canvas_w, canvas_h, fps
):
    details = item.get("details", {})
    src = details.get("src", "")
    local_path = asset_map.get(src)
    if not local_path:
        return None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0

    t_from, t_to = _resolve_source_trim(item, local_path, d_from, d_to)

    playback_rate = item.get("playbackRate", 1) or 1
    volume = (details.get("volume", 100) or 0) / 100.0
    scale = _parse_scale_from_transform(details.get("transform", "none"))

    left = parse_css_px(details.get("left", 0))
    top = parse_css_px(details.get("top", 0))
    w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
    h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))

    ox, oy, sw, sh = _calculate_overlay_pos(left, top, w, h, scale)

    opacity = (details.get("opacity", 100) or 100) / 100.0
    brightness = (details.get("brightness", 100) or 100) / 100.0
    blur_val = details.get("blur", 0) or 0
    flip_x = details.get("flipX", False)
    flip_y = details.get("flipY", False)
    rotate_deg = parse_css_px(details.get("rotate", "0deg").replace("deg", ""))

    crop = details.get("crop")

    # Build input
    inputs.append(["-i", local_path])
    v_label = f"v{input_idx}"

    # Build video filter chain
    v_filters = []

    # Trim
    v_filters.append(f"trim={t_from}:{t_to},setpts=PTS-STARTPTS")

    # Playback rate
    if playback_rate != 1:
        v_filters.append(f"setpts=PTS/{playback_rate}")

    # Crop
    if crop and crop.get("width") and crop.get("height"):
        v_filters.append(
            f"crop={int(crop['width'])}:{int(crop['height'])}:"
            f"{int(crop.get('x', 0))}:{int(crop.get('y', 0))}"
        )

    # Scale
    v_filters.append(f"scale={sw}:{sh}")

    # Flip
    if flip_x:
        v_filters.append("hflip")
    if flip_y:
        v_filters.append("vflip")

    # Rotate
    if rotate_deg and rotate_deg != 0:
        v_filters.append(
            f"rotate={rotate_deg}*PI/180:fillcolor=none:ow=rotw({rotate_deg}*PI/180):oh=roth({rotate_deg}*PI/180)"
        )

    # Brightness
    if brightness != 1.0:
        v_filters.append(f"eq=brightness={brightness - 1.0}")

    # Blur
    if blur_val > 0:
        v_filters.append(f"boxblur={int(blur_val)}:{int(blur_val)}")

    # Opacity (using format + colorchannelmixer)
    if opacity < 1.0:
        v_filters.append(f"format=rgba,colorchannelmixer=aa={opacity}")

    # Pad to ensure proper alpha overlay
    v_filters.append("format=rgba")

    filter_chain = ",".join(v_filters)
    filters.append(f"[{input_idx}:v]{filter_chain}[{v_label}]")

    # Overlay onto current
    next_label = f"ov{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{v_label}]overlay={ox}:{oy}:{enable}:format=auto[{next_label}]"
    )

    # Audio (skip when stream missing — otherwise FFmpeg fails on [N:a])
    a_label = None
    if volume > 0 and _input_has_audio(local_path):
        a_label = f"a{input_idx}"
        a_filters = []
        a_filters.append(f"atrim={t_from}:{t_to},asetpts=PTS-STARTPTS")
        if playback_rate != 1:
            # atempo only supports 0.5-100.0
            rate = max(0.5, min(100.0, playback_rate))
            a_filters.append(f"atempo={rate}")
        a_filters.append(f"volume={volume}")
        # Delay audio to match display start
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
    input_idx, current_label, canvas_w, canvas_h, fps
):
    """Process multiple video items connected by transitions using xfade."""
    if not items:
        return None

    audio_labels = []
    video_labels = []

    # First, prepare each video as a separate stream
    for item in items:
        details = item.get("details", {})
        src = details.get("src", "")
        local_path = asset_map.get(src)
        if not local_path:
            continue

        display = item.get("display", {})
        d_from = display.get("from", 0) / 1000.0
        d_to = display.get("to", 0) / 1000.0
        dur = d_to - d_from

        t_from, t_to = _resolve_source_trim(item, local_path, d_from, d_to)

        playback_rate = item.get("playbackRate", 1) or 1
        volume = (details.get("volume", 100) or 0) / 100.0
        scale = _parse_scale_from_transform(details.get("transform", "none"))

        left = parse_css_px(details.get("left", 0))
        top_val = parse_css_px(details.get("top", 0))
        w = parse_css_length(details.get("width"), float(canvas_w), float(canvas_w))
        h = parse_css_length(details.get("height"), float(canvas_h), float(canvas_h))
        _, _, sw, sh = _calculate_overlay_pos(left, top_val, w, h, scale)

        inputs.append(["-i", local_path])
        v_label = f"xv{input_idx}"

        v_filters = [
            f"trim={t_from}:{t_to},setpts=PTS-STARTPTS",
            f"scale={sw}:{sh}",
            "format=rgba",
        ]
        if playback_rate != 1:
            v_filters.insert(1, f"setpts=PTS/{playback_rate}")

        filters.append(f"[{input_idx}:v]{','.join(v_filters)}[{v_label}]")
        video_labels.append((v_label, dur, item))

        # Audio
        if volume > 0 and _input_has_audio(local_path):
            a_label = f"xa{input_idx}"
            a_filters = [f"atrim={t_from}:{t_to},asetpts=PTS-STARTPTS"]
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

    # Overlay the xfaded result onto the current canvas (time-bounded like single clips)
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

    final_label = f"ovg{input_idx}"
    enable = f"enable='between(t,{d_from},{d_to})'"
    filters.append(
        f"[{current_label}][{result_label}]overlay={ox}:{oy}:{enable}:format=auto[{final_label}]"
    )

    return {
        "next_input_idx": input_idx,
        "video_label": final_label,
        "audio_labels": audio_labels,
    }


def _process_audio(item, asset_map, inputs, filters, input_idx, fps):
    details = item.get("details", {})
    src = details.get("src", "")
    local_path = asset_map.get(src)
    if not local_path:
        return None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0

    trim = item.get("trim", {})
    t_from = trim.get("from", 0) / 1000.0 if trim else 0
    t_to = trim.get("to", 0) / 1000.0 if trim else 99999

    playback_rate = item.get("playbackRate", 1) or 1
    volume = (details.get("volume", 100) or 100) / 100.0

    inputs.append(["-i", local_path])
    a_label = f"au{input_idx}"

    a_filters = [f"atrim={t_from}:{t_to},asetpts=PTS-STARTPTS"]
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
    current_label, canvas_w, canvas_h, fps
):
    details = item.get("details", {})
    src = details.get("src", "")
    local_path = asset_map.get(src)
    if not local_path:
        return None

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0

    scale = _parse_scale_from_transform(details.get("transform", "none"))
    left = parse_css_px(details.get("left", 0))
    top_val = parse_css_px(details.get("top", 0))
    w = parse_css_length(details.get("width"), float(canvas_w), 100.0)
    h = parse_css_length(details.get("height"), float(canvas_h), 100.0)
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
    input_idx, current_label, canvas_w, canvas_h, fps
):
    details = item.get("details", {})
    font_url = details.get("fontUrl")
    font_path = asset_map.get(font_url) if font_url else None
    if font_url and not font_path:
        print(f"[WARN] Font not resolved for text item {item.get('id')}: {font_url}")

    display = item.get("display", {})
    d_from = display.get("from", 0) / 1000.0
    d_to = display.get("to", 0) / 1000.0

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
