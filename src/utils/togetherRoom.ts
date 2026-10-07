/** 房型判定集中在共享层：主进程与渲染端都要用同一套规则 */
export const isMultiRoomType = (roomType: string): boolean =>
  (roomType ?? "").toUpperCase().startsWith("MULTI");

export type TogetherSongAction = "add" | "pending" | "none";

export interface TogetherRoomSongRef {
  songId: string;
  songRcmdUid: string;
}

/**
 * 曲目菜单该给哪个房间操作。
 * pending 的范围必须用「当前曲 + 待播」这个窗口，而不是房间历史歌单：
 * 一首歌播完之后应当能重新加入，用历史歌单会让它永远停在"已加入"
 */
export const togetherSongAction = (
  inRoom: boolean,
  songId: string,
  selfUserId: string,
  currentSongId: string,
  nextSongs: readonly TogetherRoomSongRef[],
): TogetherSongAction => {
  if (!inRoom || !songId) return "none";
  if (songId === currentSongId) return "pending";
  const pending = nextSongs.find((song) => song.songId === songId);
  if (!pending) return "add";
  // 只能删自己加的：别人的歌由服务端拒绝，不给入口
  return pending.songRcmdUid === selfUserId ? "pending" : "none";
};
