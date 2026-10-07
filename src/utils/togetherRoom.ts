/** 房型判定集中在共享层：主进程与渲染端都要用同一套规则 */
export const isMultiRoomType = (roomType: string): boolean =>
  (roomType ?? "").toUpperCase().startsWith("MULTI");

export type TogetherSongAction = "add" | "top" | "remove" | "none";

/**
 * 曲目菜单该给哪个房间操作。
 * 不在房间时没有操作；在房间里则取决于这首歌是否已在房间队列——
 * 不在队列只能"加入"，已在队列才能"置顶/移除"，否则会给出必然失败的操作
 */
export const togetherSongAction = (
  inRoom: boolean,
  songId: string,
  roomSongIds: readonly string[],
): TogetherSongAction => {
  if (!inRoom || !songId) return "none";
  return roomSongIds.includes(songId) ? "top" : "add";
};
