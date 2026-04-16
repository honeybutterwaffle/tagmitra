import TimelineBase from "@designcombo/timeline";
import Video from "./video";
import { throttle } from "lodash";
import Audio from "./audio";
import { TimelineOptions } from "@designcombo/timeline";
import { ITrack, ITimelineScaleState } from "@designcombo/types";

class Timeline extends TimelineBase {
  public isShiftKey: boolean = false;
  constructor(
    canvasEl: HTMLCanvasElement,
    options: Partial<TimelineOptions> & {
      scale: ITimelineScaleState;
      duration: number;
      guideLineColor?: string;
    }
  ) {
    super(canvasEl, options); // Call the parent class constructor

    // Add shift keyboard listener
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      this.isShiftKey = true;
    }
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      this.isShiftKey = false;
    }
  };

  public purge(): void {
    super.purge();

    // Cleanup event listener for Shift key
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  /**
   * Keep all timeline rows in `this.tracks` (promo template: 7 fixed lanes).
   * Parent `filterEmptyTracks` drops empty non-static tracks or keeps static empty lanes visible;
   * we only dedupe by id so state always retains every lane.
   */
  filterEmptyTracks(): void {
    const seen = new Set<string>();
    this.tracks = this.tracks.filter(
      (t) => !seen.has(t.id) && (seen.add(t.id), true)
    );
  }

  private _applyTrackFilter = false;

  private getVisibleTracksForCanvas(): ITrack[] {
    const active = this.activeIds ?? [];
    return this.tracks.filter((track) => {
      if (track.items.length > 0) return true;
      return active.some((id) => track.items.includes(id));
    });
  }

  renderTracks(): void {
    if (!this._applyTrackFilter) {
      super.renderTracks();
      return;
    }
    const full = this.tracks;
    this.tracks = this.getVisibleTracksForCanvas();
    try {
      super.renderTracks();
    } finally {
      this.tracks = full;
    }
  }

  /**
   * Push original filenames onto canvas objects so labels show real names
   * instead of proxy filenames. Uses the upload store entries (matched by URL)
   * as the source of truth, falling back to details.name from the store.
   */
  private syncItemNames(uploads: any[]): void {
    const urlToName = new Map<string, string>();
    for (const u of uploads) {
      const name = u.fileName || u.file?.name || "";
      if (!name) continue;
      const proxyUrl = u.metadata?.proxyUrl || u.metadata?.uploadedUrl || u.url;
      const origUrl = u.metadata?.originalUrl;
      if (proxyUrl) urlToName.set(proxyUrl, name);
      if (origUrl) urlToName.set(origUrl, name);
    }

    const objects = this.getObjects();
    for (const obj of objects) {
      const o = obj as any;
      if (typeof o.name !== "string" || !o.id) continue;
      const storeItem = this.trackItemsMap[o.id];
      if (!storeItem) continue;

      const src = storeItem.details?.src || "";
      const origSrc = storeItem.details?.originalSrc || storeItem.metadata?.originalSrc || "";
      const proxySrc = storeItem.metadata?.proxySrc || "";

      const originalName =
        urlToName.get(src) ||
        urlToName.get(origSrc) ||
        urlToName.get(proxySrc) ||
        storeItem.details?.name ||
        (storeItem.name && storeItem.name !== storeItem.type
          ? storeItem.name
          : null);

      if (originalName && o.name !== originalName) {
        o.name = originalName;
      }
    }
  }

  /** Call after store-driven `activeIds` / `tracks` / `trackItemsMap` changes (parent updateState does not rebuild rows). */
  public syncPromoTrackVisibility(activeIdsFromStore: string[], uploads?: any[]): void {
    this.activeIds = activeIdsFromStore;
    this.syncItemNames(uploads || []);
    this._applyTrackFilter = true;
    try {
      this.renderTracks();
    } finally {
      this._applyTrackFilter = false;
    }
    this.alignItemsToTrack();
    this.refreshTrackLayout();
    this.setTrackItemCoords();
    this.calcBounding();
    this.requestRenderAll();
  }

  public setViewportPos(posX: number, posY: number) {
    const limitedPos = this.getViewportPos(posX, posY);
    const vt = this.viewportTransform;
    vt[4] = limitedPos.x;
    vt[5] = limitedPos.y;
    this.requestRenderAll();
    this.setActiveTrackItemCoords();
    this.onScrollChange();

    this.onScroll?.({
      scrollTop: limitedPos.y,
      scrollLeft: limitedPos.x - this.spacing.left
    });
  }

  public onScrollChange = throttle(async () => {
    const objects = this.getObjects();
    const viewportTransform = this.viewportTransform;
    const scrollLeft = viewportTransform[4];
    for (const object of objects) {
      if (object instanceof Video || object instanceof Audio) {
        object.onScrollChange({ scrollLeft });
      }
    }
  }, 250);

  public scrollTo({
    scrollLeft,
    scrollTop
  }: {
    scrollLeft?: number;
    scrollTop?: number;
  }): void {
    const vt = this.viewportTransform; // Create a shallow copy
    let hasChanged = false;

    if (typeof scrollLeft === "number") {
      vt[4] = -scrollLeft + this.spacing.left;
      hasChanged = true;
    }
    if (typeof scrollTop === "number") {
      vt[5] = -scrollTop;
      hasChanged = true;
    }

    if (hasChanged) {
      this.viewportTransform = vt;
      this.getActiveObject()?.setCoords();
      this.onScrollChange();
      this.requestRenderAll();
    }
  }
}

export default Timeline;
