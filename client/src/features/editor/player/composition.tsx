import { SequenceItem } from "./sequence-item";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { dispatch, filter, subject } from "@designcombo/events";
import { EDIT_OBJECT, ENTER_EDIT_MODE } from "@designcombo/state";
import { groupTrackItems } from "../utils/track-items";
import { TransitionSeries, Transitions } from "@designcombo/transitions";
import { calculateTextHeight } from "../utils/text";
import { OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import useStore from "../store/use-store";

const PROMO_HOLE_ROLES = new Set(["video"]);

// Always-mounted video element for any video item.
// Stays in the DOM from composition mount so the browser can preload the file.
// Visibility is toggled via CSS — no mount/unmount decode latency.
const AlwaysMountedVideo = React.memo(
  ({
    item,
    fps,
    currentFrame,
    holeLayout
  }: {
    item: any;
    fps: number;
    currentFrame: number;
    holeLayout?: { left: number; top: number; width: number; height: number } | null;
  }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const prevFrameRef = useRef(currentFrame);
    const details = item.details || {};

    // For promo hole videos, use the authoritative alpha hole dimensions
    // instead of details which may be overwritten by ADD_VIDEO's scaleMode.
    const containerLeft = holeLayout?.left ?? details.left ?? 0;
    const containerTop = holeLayout?.top ?? details.top ?? 0;
    const containerWidth = holeLayout?.width ?? details.crop?.width ?? details.width ?? "100%";
    const containerHeight = holeLayout?.height ?? details.crop?.height ?? details.height ?? "100%";

    const fromFrame = Math.round((item.display.from / 1000) * fps);
    const toFrame = Math.round((item.display.to / 1000) * fps);
    const isActive = currentFrame >= fromFrame && currentFrame < toFrame;
    const playbackRate = item.playbackRate || 1;
    const trimFromSec = (item.trim?.from ?? 0) / 1000;
    const volume = details.volume ?? 0;
    const isMuted = volume <= 0;

    useEffect(() => {
      const vid = videoRef.current;
      if (!vid) return;

      const targetTime =
        trimFromSec +
        (Math.max(0, currentFrame - fromFrame) / fps) * playbackRate;
      const frameDelta = currentFrame - prevFrameRef.current;
      prevFrameRef.current = currentFrame;

      // Sync volume
      vid.muted = isMuted;
      if (!isMuted) vid.volume = Math.min(1, Math.max(0, volume / 100));

      if (!isActive) {
        if (!vid.paused) vid.pause();
        return;
      }

      // Frame advancing by 1 means smooth playback; anything else is a seek/scrub
      const isSmoothing = frameDelta === 1;

      if (isSmoothing) {
        vid.playbackRate = playbackRate;
        if (vid.paused) {
          vid.currentTime = targetTime;
          vid.play().catch(() => {});
        } else if (Math.abs(vid.currentTime - targetTime) > 0.3) {
          vid.currentTime = targetTime;
        }
      } else {
        if (!vid.paused) vid.pause();
        vid.currentTime = targetTime;
      }

      // If no new frame arrives within 100ms the player was paused —
      // pause the native video so it doesn't keep running.
      const pauseTimer = setTimeout(() => {
        if (!vid.paused) vid.pause();
      }, 100);
      return () => clearTimeout(pauseTimer);
    }, [currentFrame, isActive, fromFrame, fps, playbackRate, trimFromSec, isMuted, volume]);

    const cw = typeof containerWidth === "number" ? containerWidth : 0;
    const ch = typeof containerHeight === "number" ? containerHeight : 0;
    const borderRadiusPx = cw && ch
      ? `${Math.min(cw, ch) * ((details.borderRadius || 0) / 100)}px`
      : "0px";

    const boxShadow = [
      details.borderWidth
        ? `0 0 0 ${details.borderWidth}px ${details.borderColor || "transparent"}`
        : "",
      details.boxShadow
        ? `${details.boxShadow.x}px ${details.boxShadow.y}px ${details.boxShadow.blur}px ${details.boxShadow.color}`
        : ""
    ].filter(Boolean).join(", ") || "none";

    return (
      <div
        id={item.id}
        data-track-item="transition-element"
        className={`designcombo-scene-item id-${item.id} designcombo-scene-item-type-${item.type}`}
        style={{
          position: "absolute",
          left: containerLeft,
          top: containerTop,
          width: containerWidth,
          height: containerHeight,
          overflow: "hidden",
          visibility: isActive ? "visible" : "hidden",
          pointerEvents: "auto",
          transform: holeLayout ? "none" : (details.transform || "none"),
          opacity: details.opacity !== undefined ? details.opacity / 100 : 1,
          transformOrigin: details.transformOrigin || "center center",
          rotate: holeLayout ? "0deg" : (details.rotate || "0deg"),
          filter: `brightness(${details.brightness ?? 100}%) blur(${details.blur ?? 0}px)`,
          borderRadius: borderRadiusPx,
          boxShadow
        }}
      >
        <video
          ref={videoRef}
          src={details.src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: borderRadiusPx
          }}
          preload="auto"
          playsInline
          crossOrigin="anonymous"
        />
      </div>
    );
  }
);

const Composition = () => {
  const [editableTextId, setEditableTextId] = useState<string | null>(null);
  const {
    trackItemIds,
    trackItemsMap,
    fps,
    sceneMoveableRef,
    size,
    transitionsMap,
    structure,
    activeIds
  } = useStore();
  const frame = useCurrentFrame();

  const groupedItems = groupTrackItems({
    trackItemIds,
    transitionsMap,
    trackItemsMap: trackItemsMap
  });
  const mediaItems = Object.values(trackItemsMap).filter((item) => {
    return item.type === "video" || item.type === "audio";
  });

  const handleTextChange = (id: string, _: string) => {
    const elRef = document.querySelector(`.id-${id}`) as HTMLDivElement;
    const containerDiv = elRef.firstElementChild
      ?.firstElementChild as HTMLDivElement;
    const textDiv = elRef.firstElementChild?.firstElementChild
      ?.firstElementChild?.firstElementChild
      ?.firstElementChild as HTMLDivElement;

    const {
      fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      lineHeight,
      textShadow,
      webkitTextStroke,
      textTransform
    } = textDiv.style;
    if (!elRef.innerText) return;

    // Check if any word is wider than current container
    const words = elRef.innerText.split(/\s+/);
    const longestWord = words.reduce(
      (longest, word) => (word.length > longest.length ? word : longest),
      ""
    );

    // Create temporary element to measure longest word width
    const tempDiv = document.createElement("div");
    tempDiv.style.visibility = "hidden";
    tempDiv.style.position = "absolute";
    tempDiv.style.top = "-1000px";
    tempDiv.style.fontSize = fontSize;
    tempDiv.style.fontFamily = fontFamily;
    tempDiv.style.fontWeight = fontWeight;
    tempDiv.style.letterSpacing = letterSpacing;
    tempDiv.textContent = longestWord;
    document.body.appendChild(tempDiv);
    const wordWidth = tempDiv.offsetWidth;
    document.body.removeChild(tempDiv);

    // Expand width if word is wider than current container
    const currentWidth = elRef.clientWidth;
    if (wordWidth > currentWidth) {
      elRef.style.width = `${wordWidth}px`;
      textDiv.style.width = `${wordWidth}px`;
      containerDiv.style.width = `${wordWidth}px`;
    }

    const newHeight = calculateTextHeight({
      family: fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      lineHeight,
      text: elRef.innerText || "",
      textShadow: textShadow,
      webkitTextStroke,
      width: elRef.style.width,
      id: id,
      textTransform
    });
    const currentHeight = elRef.clientHeight;
    if (newHeight > currentHeight) {
      elRef.style.height = `${newHeight}px`;
      textDiv.style.height = `${newHeight}px`;
    }
    sceneMoveableRef?.current?.moveable.updateRect();
    sceneMoveableRef?.current?.moveable.forceUpdate();
  };

  const onTextBlur = (id: string, _: string) => {
    const elRef = document.querySelector(`.id-${id}`) as HTMLDivElement;
    const textDiv = elRef.firstElementChild?.firstElementChild
      ?.firstElementChild as HTMLDivElement;
    const {
      fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      lineHeight,
      textShadow,
      webkitTextStroke,
      textTransform
    } = textDiv.style;
    const { width } = elRef.style;
    if (!elRef.innerText) return;
    const newHeight = calculateTextHeight({
      family: fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
      lineHeight,
      text: elRef.innerText || "",
      textShadow: textShadow,
      webkitTextStroke,
      width,
      id: id,
      textTransform
    });
    dispatch(EDIT_OBJECT, {
      payload: {
        [id]: {
          details: {
            height: newHeight
          }
        }
      }
    });
  };

  //   handle track and track item events - updates
  useEffect(() => {
    const stateEvents = subject.pipe(
      filter(({ key }) => key.startsWith(ENTER_EDIT_MODE))
    );

    const subscription = stateEvents.subscribe((obj) => {
      if (obj.key === ENTER_EDIT_MODE) {
        if (editableTextId) {
          // get element by  data-text-id={id}
          const element = document.querySelector(
            `[data-text-id="${editableTextId}"]`
          ) as HTMLDivElement;

          let text = "";
          if (element) {
            for (let i = 0; i < element.childNodes.length; i++) {
              const node = element.childNodes[i];
              if (node.nodeType === Node.TEXT_NODE) {
                const nodeText = node.textContent || "";
                text += nodeText;
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const nodeText = node.textContent || "";
                text += `\n${nodeText}`;
              }
            }
          }

          if (trackItemIds.includes(editableTextId)) {
            dispatch(EDIT_OBJECT, {
              payload: {
                [editableTextId]: {
                  details: {
                    text: text || ""
                  }
                }
              }
            });
          }
        }
        setEditableTextId(obj.value?.payload.id);
      }
    });
    return () => subscription.unsubscribe();
  }, [editableTextId]);

  const alpha = useStore((s) => s.alphaInfo);

  const pkgMeta = useMemo(() => {
    const pkg = Object.values(trackItemsMap).find(
      (item: any) =>
        item?.details?.promoRole === "package" ||
        item?.metadata?.promoRole === "package"
    ) as any | undefined;
    return {
      maskSrc: pkg?.details?.alphaProxySrc || pkg?.metadata?.alphaProxySrc || "",
      pkgItem: pkg
    };
  }, [trackItemsMap]);

  const hasMaskVideo = !!pkgMeta.maskSrc;

  // Collect IDs of all standalone (non-transition) video items
  const standaloneVideoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groupedItems) {
      if (group.length !== 1) continue;
      const item = trackItemsMap[group[0].id];
      if (item?.type === "video") ids.add(item.id);
    }
    return ids;
  }, [groupedItems, trackItemsMap]);

  // Authoritative alpha hole layout — used to size promo hole videos
  // regardless of what ADD_VIDEO's scaleMode does to details.width/height.
  const alphaHoleLayout = useMemo(() => {
    if (!alpha) return null;
    if (alpha.slateFit && alpha.slateFit.width > 0 && alpha.slateFit.height > 0) {
      return alpha.slateFit;
    }
    if (alpha.w > 0 && alpha.h > 0) {
      return { left: alpha.x, top: alpha.y, width: alpha.w, height: alpha.h };
    }
    return null;
  }, [alpha]);

  // Partition standalone videos by role for layered rendering
  const { packageVideos, promoHoleVideos, regularVideos } = useMemo(() => {
    const pkg: any[] = [];
    const promo: any[] = [];
    const regular: any[] = [];
    for (const id of standaloneVideoIds) {
      const item = trackItemsMap[id] as any;
      if (!item) continue;
      const role = item.details?.promoRole || item.metadata?.promoRole;
      if (role === "package") pkg.push(item);
      else if (role && PROMO_HOLE_ROLES.has(role)) promo.push(item);
      else regular.push(item);
    }
    const byStart = (a: any, b: any) => a.display.from - b.display.from;
    pkg.sort(byStart);
    promo.sort(byStart);
    regular.sort(byStart);
    return { packageVideos: pkg, promoHoleVideos: promo, regularVideos: regular };
  }, [standaloneVideoIds, trackItemsMap]);

  const maskOverlay = useMemo(() => {
    if (!hasMaskVideo || !pkgMeta.pkgItem) return null;
    const pkg = pkgMeta.pkgItem;
    const fromFrame = Math.round(((pkg.display?.from ?? 0) / 1000) * fps);
    const toFrame = Math.round(((pkg.display?.to ?? 0) / 1000) * fps);
    const dur = Math.max(1, toFrame - fromFrame);
    const trimFromFrame = Math.round(((pkg.trim?.from ?? 0) / 1000) * fps);
    const trimToFrame = pkg.trim?.to
      ? Math.round((pkg.trim.to / 1000) * fps)
      : undefined;
    return (
      <Sequence from={fromFrame} durationInFrames={dur} layout="none">
        <div
          style={{
            position: "absolute",
            inset: 0,
            mixBlendMode: "multiply",
            pointerEvents: "none"
          }}
        >
          <OffthreadVideo
            startFrom={trimFromFrame}
            endAt={trimToFrame || dur}
            src={pkgMeta.maskSrc}
            style={{ width: "100%", height: "100%", objectFit: "fill" }}
            volume={0}
          />
        </div>
      </Sequence>
    );
  }, [hasMaskVideo, pkgMeta, fps]);

  return (
    <>
      {hasMaskVideo && (
        <div
          key="pkg-black-bg"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            background: "black"
          }}
        />
      )}

      {groupedItems.map((group, index) => {
        if (group.length === 1) {
          const item = trackItemsMap[group[0].id];

          // All standalone video items are rendered via AlwaysMountedVideo below
          if (standaloneVideoIds.has(item.id)) {
            return null;
          }

          return SequenceItem[item.type](item, {
            fps,
            handleTextChange,
            onTextBlur,
            editableTextId,
            frame,
            size,
            isTransition: false
          });
        }
        const firstItem = trackItemsMap[group[0].id];
        const from = (firstItem.display.from / 1000) * fps;
        return (
          <TransitionSeries from={from} key={index}>
            {group.map((item) => {
              if (item.type === "transition") {
                const durationInFrames = (item.duration / 1000) * fps;
                return Transitions[item.kind]({
                  durationInFrames,
                  ...size,
                  id: item.id,
                  direction: item.direction
                });
              }
              return SequenceItem[item.type](trackItemsMap[item.id], {
                fps,
                handleTextChange,
                editableTextId,
                isTransition: true,
                size
              });
            })}
          </TransitionSeries>
        );
      })}

      {/* Package videos — always-mounted at zIndex: 1 */}
      {packageVideos.map((item: any) => (
        <div
          key={`pkg-${item.id}`}
          style={{ position: "absolute", inset: 0, zIndex: 1 }}
        >
          <AlwaysMountedVideo item={item} fps={fps} currentFrame={frame} />
        </div>
      ))}

      {/* Regular videos (no promo role) — always-mounted */}
      {regularVideos.map((item: any) => (
        <AlwaysMountedVideo
          key={`vid-${item.id}`}
          item={item}
          fps={fps}
          currentFrame={frame}
        />
      ))}

      {/* Promo hole videos — always-mounted in blend mode composite at zIndex: 2 */}
      {hasMaskVideo && promoHoleVideos.length > 0 && (
        <div
          key="promo-mask-composite"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            isolation: "isolate",
            mixBlendMode: "lighten",
            background: "black",
            pointerEvents: "none"
          }}
        >
          {promoHoleVideos.map((item: any) => (
            <AlwaysMountedVideo
              key={item.id}
              item={item}
              fps={fps}
              currentFrame={frame}
              holeLayout={alphaHoleLayout}
            />
          ))}
          {maskOverlay}
        </div>
      )}

      {/* Promo hole videos without mask — use alpha hole layout directly */}
      {!hasMaskVideo &&
        alphaHoleLayout &&
        promoHoleVideos.map((item: any) => (
          <AlwaysMountedVideo
            key={`clip-${item.id}`}
            item={item}
            fps={fps}
            currentFrame={frame}
            holeLayout={alphaHoleLayout}
          />
        ))}
    </>
  );
};

export default Composition;
