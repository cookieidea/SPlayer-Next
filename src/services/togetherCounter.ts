let seekRevision = 0;
let endRevision = 0;

export const countTogetherAction = (kind: "seek" | "ended"): void => {
  if (kind === "seek") seekRevision += 1;
  else endRevision += 1;
};

export const readTogetherCounters = (): { seekRevision: number; endRevision: number } => ({
  seekRevision,
  endRevision,
});
