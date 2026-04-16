export const calculateFrames = (
  display: { from: number; to: number },
  fps: number
) => {
  const from = Math.round((display.from / 1000) * fps);
  const durationInFrames = Math.round((display.to / 1000) * fps) - from;
  return { from, durationInFrames };
};
