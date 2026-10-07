/** 房型判定集中在共享层：主进程与渲染端都要用同一套规则 */
export const isMultiRoomType = (roomType: string): boolean =>
  (roomType ?? "").toUpperCase().startsWith("MULTI");

/**
 * 能否共享到一起听房间。
 *
 * 只有网易云在线歌曲能给到对方：本地文件与流媒体服务器上的曲子对方的客户端
 * 根本拿不到；云盘歌曲虽然带真实 songId，但它是上传者账号私有的，
 * 别人点开也放不出来。这些一律不参与房间队列，否则对方会卡在无法播放的歌上
 */
export const isTogetherShareable = (track: {
  source?: string;
  cloud?: boolean;
  serverId?: string;
}): boolean => track.source === "netease" && track.cloud !== true && !track.serverId;
