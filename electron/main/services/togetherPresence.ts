/**
 * 多人一起听房间是否活跃。
 *
 * 单独成模块是因为 ipc/player 需要据此屏蔽系统媒体键，
 * 而直接 import listenTogetherMulti 会把整条网易云 API 依赖链拖进播放器 IPC，
 * 连单元测试都跑不起来
 */
let active = false;

/** 由多人一起听服务在房间活跃/结束时维护 */
export const setMultiRoomActive = (value: boolean): void => {
  active = value;
};

export const isMultiRoomActive = (): boolean => active;
