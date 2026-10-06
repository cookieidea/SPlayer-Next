let seekRevision = 0;
let endRevision = 0;
let counting = false;

export const setTogetherCounting = (active: boolean): void => {
  counting = active;
  if (!active) {
    seekRevision = 0;
    endRevision = 0;
  }
};

export const countTogetherAction = (kind: "seek" | "ended"): void => {
  if (!counting) return;
  if (kind === "seek") seekRevision += 1;
  else endRevision += 1;
};

export const readTogetherCounters = (): { seekRevision: number; endRevision: number } => ({
  seekRevision,
  endRevision,
});
