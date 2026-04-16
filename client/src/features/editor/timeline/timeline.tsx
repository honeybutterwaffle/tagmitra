import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./header";
import Ruler from "./ruler";
import { timeMsToUnits, unitsToTimeMs } from "@designcombo/timeline";
import CanvasTimeline from "./items/timeline";
import useStore from "../store/use-store";
import Playhead from "./playhead";
import { useTheme } from "next-themes";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import {
  Audio,
  Image,
  Text,
  Video,
  Caption,
  Helper,
  Track,
  LinealAudioBars,
  RadialAudioBars,
  WaveAudioBars,
  HillAudioBars
} from "./items";
import StateManager from "@designcombo/state";
import {
  TIMELINE_OFFSET_CANVAS_LEFT,
  TIMELINE_OFFSET_CANVAS_RIGHT
} from "../constants/constants";
import PreviewTrackItem from "./items/preview-drag-item";
import { useTimelineOffsetX } from "../hooks/use-timeline-offset";
import { useStateManagerEvents } from "../hooks/use-state-manager-events";
import { useResizbleTimeline } from "../hooks/use-resizable-timeline";
import { extractFilenameFromSrc } from "./items/draw-name-label";
import useUploadStore from "../store/use-upload-store";
import { Trash2 } from "lucide-react";
import { throttle } from "lodash";

CanvasTimeline.registerItems({
  Text,
  Image,
  Audio,
  Video,
  Caption,
  Helper,
  Track,
  PreviewTrackItem,
  LinealAudioBars,
  RadialAudioBars,
  WaveAudioBars,
  HillAudioBars
});

const EMPTY_SIZE = { width: 0, height: 0 };
const Timeline = ({ stateManager }: { stateManager: StateManager }) => {
  // prevent duplicate scroll events
  const canScrollRef = useRef(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<CanvasTimeline | null>(null);
  const horizontalScrollbarVpRef = useRef<HTMLDivElement>(null);
  const {
    scale,
    playerRef,
    fps,
    duration,
    setState,
    timeline,
    activeIds,
    tracks,
    trackItemsMap
  } = useStore();
  const currentFrame = useCurrentPlayerFrame(playerRef);
  const [canvasSize, setCanvasSize] = useState(EMPTY_SIZE);
  const timelineOffsetX = useTimelineOffsetX();
  const {
    timelineContainerRef,
    timelineHeight,
    onMouseDown,
    onMouseMove,
    onMouseOut
  } = useResizbleTimeline();
  const { theme } = useTheme();

  const { setTimeline } = useStore();
  const uploads = useUploadStore((s) => s.uploads);
  const [tooltipInfo, setTooltipInfo] = useState<{
    name: string;
    duration: string;
    x: number;
    y: number;
  } | null>(null);

  const [gapInfo, setGapInfo] = useState<{
    trackId: string;
    gapStartMs: number;
    gapEndMs: number;
    itemIdsAfter: string[];
    x: number;
    y: number;
  } | null>(null);

  // Use the extracted state manager events hook
  useStateManagerEvents(stateManager);

  useEffect(() => {
    if (timeline) {
      const t = timeline as InstanceType<typeof CanvasTimeline>;
      if (typeof t.initScrollbars === "function") {
        t.initScrollbars({
          offsetX: 16,
          offsetY: 0,
          extraMarginX: 50,
          extraMarginY: 60,
          scrollbarWidth: 8,
          scrollbarColor: theme === "dark" ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.35)"
        });
      }
    }
    const timeout = setTimeout(() => {
      timeline?.requestRenderAll();
    }, 5);
    return () => clearTimeout(timeout);
  }, [theme, timeline]);

  useEffect(() => {
    const t = timeline as InstanceType<typeof CanvasTimeline> | null;
    if (!t || typeof t.syncPromoTrackVisibility !== "function") return;
    t.syncPromoTrackVisibility(activeIds, uploads);
  }, [timeline, activeIds, tracks, trackItemsMap, uploads]);

  useEffect(() => {
    if (!timeline || activeIds.length !== 1) {
      setTooltipInfo(null);
      return;
    }

    const itemId = activeIds[0];
    const item = trackItemsMap[itemId];
    if (!item) {
      setTooltipInfo(null);
      return;
    }

    const itemSrc = item.details?.src || "";
    const itemOrigSrc = item.details?.originalSrc || item.metadata?.originalSrc || "";
    const itemProxySrc = item.metadata?.proxySrc || "";
    let name: string | null = null;
    for (const u of uploads) {
      const uName = u.fileName || u.file?.name || "";
      if (!uName) continue;
      const uProxy = u.metadata?.proxyUrl || u.metadata?.uploadedUrl || u.url || "";
      const uOrig = u.metadata?.originalUrl || "";
      if (
        (itemSrc && (itemSrc === uProxy || itemSrc === uOrig)) ||
        (itemOrigSrc && (itemOrigSrc === uOrig || itemOrigSrc === uProxy)) ||
        (itemProxySrc && (itemProxySrc === uProxy || itemProxySrc === uOrig))
      ) {
        name = uName;
        break;
      }
    }
    if (!name) {
      name =
        item.details?.name ||
        (item.name && item.name !== item.type ? item.name : null) ||
        (itemSrc ? extractFilenameFromSrc(itemSrc as string) : null) ||
        item.type;
    }

    const durationMs = item.display.to - item.display.from;
    const totalSec = durationMs / 1000;
    let formattedDuration: string;
    if (totalSec < 60) {
      formattedDuration = `${totalSec.toFixed(2)}s`;
    } else {
      const min = Math.floor(totalSec / 60);
      const sec = Math.floor(totalSec % 60);
      formattedDuration = `${min}:${sec.toString().padStart(2, "0")}`;
    }

    const canvasEl = document.getElementById("designcombo-timeline-canvas");
    if (!canvasEl) {
      setTooltipInfo(null);
      return;
    }

    const t = timeline as InstanceType<typeof CanvasTimeline>;
    const obj = t.getObjects().find((o: any) => o.id === itemId);
    if (!obj) {
      setTooltipInfo(null);
      return;
    }

    const canvasRect = canvasEl.getBoundingClientRect();
    const containerEl = document.getElementById("timeline-container");
    const containerRect = containerEl?.getBoundingClientRect() ?? canvasRect;

    const vt = t.viewportTransform;
    const objLeft = obj.left * vt[0] + vt[4];
    const objTop = obj.top * vt[3] + vt[5];
    const objWidth = obj.width * vt[0];

    const tooltipX =
      canvasRect.left - containerRect.left + objLeft + objWidth / 2;
    const tooltipY = canvasRect.top - containerRect.top + objTop - 8;

    setTooltipInfo({
      name,
      duration: formattedDuration,
      x: tooltipX,
      y: tooltipY
    });
  }, [timeline, activeIds, trackItemsMap]);

  useEffect(() => {
    if (playerRef?.current) {
      canScrollRef.current = playerRef?.current.isPlaying();
    }
  }, [playerRef?.current?.isPlaying()]);

  useEffect(() => {
    const position = timeMsToUnits((currentFrame / fps) * 1000, scale.zoom);
    const canvasEl = canvasElRef.current;
    const horizontalScrollbar = horizontalScrollbarVpRef.current;

    if (!canvasEl || !horizontalScrollbar) return;

    const canvasBoudingX =
      canvasEl.getBoundingClientRect().x + canvasEl.clientWidth;
    const playHeadPos = position - scrollLeft + 40;
    if (playHeadPos >= canvasBoudingX) {
      const scrollDivWidth = horizontalScrollbar.clientWidth;
      const totalScrollWidth = horizontalScrollbar.scrollWidth;
      const currentPosScroll = horizontalScrollbar.scrollLeft;
      const availableScroll =
        totalScrollWidth - (scrollDivWidth + currentPosScroll);
      const scaleScroll = availableScroll / scrollDivWidth;
      if (scaleScroll >= 0) {
        if (scaleScroll > 1)
          horizontalScrollbar.scrollTo({
            left: currentPosScroll + scrollDivWidth
          });
        else
          horizontalScrollbar.scrollTo({
            left: totalScrollWidth - scrollDivWidth
          });
      }
    }
  }, [currentFrame]);

  const onResizeCanvas = (payload: { width: number; height: number }) => {
    setCanvasSize({
      width: payload.width,
      height: payload.height
    });
  };

  useEffect(() => {
    const canvasEl = canvasElRef.current;
    const timelineContainerEl = timelineContainerRef.current;

    if (!canvasEl || !timelineContainerEl) return;

    const containerWidth =
      (document.getElementById("timeline-header")?.clientWidth || 0) - 70;
    const containerHeight =
      (document.getElementById("playhead")?.clientHeight || 0) -
      (document.getElementById("playhead-handle")?.clientHeight || 0) -
      40;
    const canvas = new CanvasTimeline(canvasEl, {
      width: containerWidth,
      height: containerHeight,
      bounding: {
        width: containerWidth,
        height: 0
      },
      selectionColor: "rgba(0, 216, 214,0.1)",
      selectionBorderColor: "rgba(0, 216, 214,1.0)",
      onResizeCanvas,
      scale: scale,
      state: stateManager,
      duration,
      spacing: {
        left: TIMELINE_OFFSET_CANVAS_LEFT,
        right: TIMELINE_OFFSET_CANVAS_RIGHT
      },
      sizesMap: {
        caption: 32,
        text: 32,
        audio: 36,
        customTrack: 40,
        customTrack2: 40,
        linealAudioBars: 40,
        radialAudioBars: 40,
        waveAudioBars: 40,
        hillAudioBars: 40
      },
      itemTypes: [
        "text",
        "image",
        "audio",
        "video",
        "caption",
        "helper",
        "track",
        "composition",
        "template",
        "linealAudioBars",
        "radialAudioBars",
        "progressFrame",
        "progressBar",
        "waveAudioBars",
        "hillAudioBars"
      ],
      acceptsMap: {
        text: ["text", "caption"],
        image: ["image"],
        video: ["video"],
        audio: ["audio"],
        caption: ["caption", "text"],
        template: ["template"],
        customTrack: ["video"],
        customTrack2: ["video"],
        main: ["video"],
        linealAudioBars: ["audio", "linealAudioBars"],
        radialAudioBars: ["audio", "radialAudioBars"],
        waveAudioBars: ["audio", "waveAudioBars"],
        hillAudioBars: ["audio", "hillAudioBars"]
      },
      guideLineColor: theme === "dark" ? "#ffffff" : "#000000"
    });

    canvas.initScrollbars({
      offsetX: 16,
      offsetY: 0,
      extraMarginX: 50,
      extraMarginY: 60,
      scrollbarWidth: 8,
      scrollbarColor: theme === "dark" ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.35)"
    });

    canvas.onViewportChange((left: number) => {
      setScrollLeft(left + 16);
    });

    canvasRef.current = canvas;

    setCanvasSize({ width: containerWidth, height: containerHeight });
    setTimeline(canvas);

    return () => {
      canvas.purge();
    };
  }, []);

  const onClickRuler = (units: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const time = unitsToTimeMs(units, scale.zoom);
    playerRef?.current?.seekTo(Math.round((time * fps) / 1000));
  };

  const onRulerScroll = (newScrollLeft: number) => {
    // Update the timeline canvas scroll position
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.scrollTo({ scrollLeft: newScrollLeft });
    }

    // Update the horizontal scrollbar position
    if (horizontalScrollbarVpRef.current) {
      horizontalScrollbarVpRef.current.scrollLeft = newScrollLeft;
    }

    // Update the local scroll state
    setScrollLeft(newScrollLeft);
  };

  useEffect(() => {
    const availableScroll = horizontalScrollbarVpRef.current?.scrollWidth;
    if (!availableScroll || !timeline) return;
    const canvasWidth = timeline.width;
    if (availableScroll < canvasWidth + scrollLeft) {
      timeline.scrollTo({ scrollLeft: availableScroll - canvasWidth });
    }
  }, [scale]);

  // ── Gap detection on hover ──────────────────────────────────────
  const gapOverlayRef = useRef<HTMLDivElement>(null);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const trackItemsMapRef = useRef(trackItemsMap);
  trackItemsMapRef.current = trackItemsMap;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    if (!timeline) return;
    const t = timeline as InstanceType<typeof CanvasTimeline>;

    const detectGap = throttle((opt: any) => {
      if (opt.target) {
        setGapInfo(null);
        return;
      }

      const pointer = t.getPointer(opt.e);
      const canvasX = pointer.x;
      const canvasY = pointer.y;

      const hoverTimeMs = unitsToTimeMs(
        canvasX - TIMELINE_OFFSET_CANVAS_LEFT,
        scaleRef.current.zoom
      );
      if (hoverTimeMs < 0) {
        setGapInfo(null);
        return;
      }

      const trackObjects = t
        .getObjects()
        .filter(
          (o: any) =>
            o.constructor?.type === "Track" || o.type === "Track"
        );

      let matchedTrackId: string | null = null;
      let matchedTrkObj: any = null;
      for (const trk of trackObjects) {
        if (canvasY >= trk.top && canvasY <= trk.top + trk.height) {
          matchedTrackId = (trk as any).id;
          matchedTrkObj = trk;
          break;
        }
      }

      if (!matchedTrackId) {
        setGapInfo(null);
        return;
      }

      const currentTracks = tracksRef.current;
      const currentMap = trackItemsMapRef.current;
      const track = currentTracks.find((tk) => tk.id === matchedTrackId);
      if (!track || track.items.length < 2) {
        setGapInfo(null);
        return;
      }

      const sortedItems = track.items
        .map((id) => currentMap[id])
        .filter(Boolean)
        .sort((a, b) => a.display.from - b.display.from);

      if (sortedItems.length < 2) {
        setGapInfo(null);
        return;
      }

      for (let i = 0; i < sortedItems.length - 1; i++) {
        const cur = sortedItems[i];
        const nxt = sortedItems[i + 1];
        const gapStart = cur.display.to;
        const gapEnd = nxt.display.from;
        if (gapEnd - gapStart < 10) continue;

        if (hoverTimeMs >= gapStart && hoverTimeMs <= gapEnd) {
          const canvasEl = canvasElRef.current;
          if (!canvasEl) { setGapInfo(null); return; }

          const canvasRect = canvasEl.getBoundingClientRect();
          const containerEl = document.getElementById("timeline-container");
          const containerRect =
            containerEl?.getBoundingClientRect() ?? canvasRect;

          const vt = t.viewportTransform;
          const allObjs = t.getObjects();
          const leftObj = allObjs.find((o: any) => o.id === cur.id);
          const rightObj = allObjs.find((o: any) => o.id === nxt.id);

          let gapCenterPx: number;
          if (leftObj && rightObj) {
            const rightEdgeOfLeft =
              (leftObj.left + leftObj.width) * vt[0] + vt[4];
            const leftEdgeOfRight = rightObj.left * vt[0] + vt[4];
            gapCenterPx = (rightEdgeOfLeft + leftEdgeOfRight) / 2;
          } else {
            const cx =
              timeMsToUnits(
                (gapStart + gapEnd) / 2,
                scaleRef.current.zoom
              ) + TIMELINE_OFFSET_CANVAS_LEFT;
            gapCenterPx = cx * vt[0] + vt[4];
          }

          const trkCenterY = matchedTrkObj
            ? matchedTrkObj.top + matchedTrkObj.height / 2
            : canvasY;
          const trkCenterPx = trkCenterY * vt[3] + vt[5];

          const overlayX =
            canvasRect.left - containerRect.left + gapCenterPx;
          const overlayY =
            canvasRect.top - containerRect.top + trkCenterPx;

          const consecutiveIds: string[] = [];
          for (let j = i + 1; j < sortedItems.length; j++) {
            consecutiveIds.push(sortedItems[j].id);
            if (
              j + 1 < sortedItems.length &&
              sortedItems[j + 1].display.from - sortedItems[j].display.to > 10
            ) {
              break;
            }
          }

          setGapInfo({
            trackId: matchedTrackId,
            gapStartMs: gapStart,
            gapEndMs: gapEnd,
            itemIdsAfter: consecutiveIds,
            x: overlayX,
            y: overlayY
          });
          return;
        }
      }

      setGapInfo(null);
    }, 60);

    t.on("mouse:move", detectGap);
    return () => {
      t.off("mouse:move", detectGap);
      detectGap.cancel();
    };
  }, [timeline]);

  useEffect(() => {
    if (activeIds.length > 0) setGapInfo(null);
  }, [activeIds]);

  const handleDeleteGap = useCallback(() => {
    if (!gapInfo) return;
    const shiftMs = gapInfo.gapEndMs - gapInfo.gapStartMs;
    if (shiftMs <= 0) return;

    const currentState = stateManager.getState();
    const newMap = { ...currentState.trackItemsMap };

    for (const id of gapInfo.itemIdsAfter) {
      const item = newMap[id];
      if (!item) continue;
      newMap[id] = {
        ...item,
        display: {
          from: item.display.from - shiftMs,
          to: item.display.to - shiftMs
        }
      };
    }

    stateManager.updateState(
      { trackItemsMap: newMap },
      { kind: "update" }
    );

    const t = timeline as InstanceType<typeof CanvasTimeline> | null;
    if (t) {
      t.updateState({ kind: "update" });
      t.syncPromoTrackVisibility(activeIds, uploads);
    }

    setGapInfo(null);
  }, [gapInfo, stateManager, timeline, activeIds, uploads]);

  return (
    <div
      ref={timelineContainerRef}
      id="timeline-container"
      className="relative w-full overflow-hidden bg-card"
      style={{
        height: `${timelineHeight}px`,
        borderTopWidth: "1px",
        borderTopStyle: "solid",
        borderTopColor: "transparent"
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseOut={onMouseOut}
    >
      <Header />
      <Ruler
        onClick={onClickRuler}
        scrollLeft={scrollLeft}
        onScroll={onRulerScroll}
      />
      <Playhead scrollLeft={scrollLeft} />
      <div className="flex">
        <div
          style={{
            width: timelineOffsetX
          }}
          className="relative flex-none"
        />
        <div style={{ height: canvasSize.height }} className="relative flex-1">
          <div
            style={{ height: canvasSize.height }}
            ref={containerRef}
            className="absolute top-0 w-full"
          >
            <canvas id="designcombo-timeline-canvas" ref={canvasElRef} />
          </div>
        </div>
      </div>
      {tooltipInfo && (
        <div
          className="absolute z-50 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-md pointer-events-none whitespace-nowrap"
          style={{
            left: tooltipInfo.x,
            top: tooltipInfo.y,
            transform: "translate(-50%, -100%)"
          }}
        >
          {tooltipInfo.name} – {tooltipInfo.duration}
        </div>
      )}
      {gapInfo && (
        <div
          ref={gapOverlayRef}
          className="absolute z-50"
          style={{
            left: gapInfo.x,
            top: gapInfo.y,
            transform: "translate(-50%, -50%)"
          }}
          onMouseLeave={() => setGapInfo(null)}
        >
          <button
            onClick={handleDeleteGap}
            className="flex items-center justify-center h-7 w-7 rounded-full bg-card border border-border shadow-md hover:bg-muted transition-colors cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      )}
    </div>
  );
};

export default Timeline;
