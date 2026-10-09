/**
 * 一起听房间活跃标志。
 *
 * 播放器核心需要在"是否在房间里"时改变行为（例如房内不做本地自动交接），
 * 但它可能在 pinia 尚未激活的上下文被调用，直接读 store 会抛错；
 * 这里用一个由房间服务维护的布尔标志，读取永远安全
 */
let active = false;

export const setTogetherRoomActive = (next: boolean): void => {
  active = next;
};

export const isTogetherRoomActive = (): boolean => active;
