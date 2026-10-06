/**
 * 一起听的本地动作计数器
 *
 * 播放位置每秒都在漂移，不能直接当作变化；这里只记录「用户真正做了一次动作」，
 * 由同步层比对计数器的增量决定是否上报。独立成文件是为了让播放核心与同步服务
 * 双向可引用而不形成模块环。
 */

let seekRevision = 0;
let endRevision = 0;

/**
 * 记一次本地动作
 * @param kind - seek 或整曲播完
 */
export const countTogetherAction = (kind: "seek" | "ended"): void => {
  if (kind === "seek") seekRevision += 1;
  else endRevision += 1;
};

/** 当前计数 */
export const readTogetherCounters = (): { seekRevision: number; endRevision: number } => ({
  seekRevision,
  endRevision,
});
