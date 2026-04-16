/**
 * 6 tracks (top → bottom in the timeline UI):
 * Text, Overlay, Video, Audio, Background Music, Package
 *
 * restrictive accepts + static: true keep clips on the intended lanes:
 * - package / video / bg music: accepts [] → placement via promo UI (targetTrackId)
 * - audio: accepts ["audio"] only
 */
export const design = {
  id: "promo-template",
  fps: 30,
  size: {
    width: 1920,
    height: 1080
  },
  background: {
    type: "color",
    value: "black"
  },
  tracks: [
    {
      id: "text",
      name: "Text",
      type: "text",
      accepts: ["text", "caption"],
      items: [],
      magnetic: false,
      static: true
    },
    {
      id: "overlay",
      name: "Overlay",
      type: "image",
      accepts: ["image"],
      items: [],
      magnetic: false,
      static: true
    },
    {
      id: "video",
      name: "Video",
      type: "video",
      accepts: [],
      items: [],
      magnetic: false,
      static: true
    },
    {
      id: "audio",
      name: "Audio",
      type: "audio",
      accepts: ["audio"],
      items: [],
      magnetic: false,
      static: true
    },
    {
      id: "backgroundMusic",
      name: "Background Music",
      type: "audio",
      accepts: [],
      items: [],
      magnetic: false,
      static: true
    },
    {
      id: "package",
      name: "Package",
      type: "video",
      accepts: [],
      items: [],
      magnetic: false,
      static: true
    }
  ],
  trackItemIds: [],
  transitionsMap: {},
  trackItemsMap: {}
};
