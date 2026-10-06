/**
 * 网易云「一起听」渲染端状态
 *
 * 房间协议在主进程，这里只保存界面需要的部分与会话标识：房间是否在线、成员、
 * 邀请链接，以及一个递增的同步事件序号供服务层消费。
 */

import type {
  TogetherRoom,
  TogetherSession,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";

export const useTogetherStore = defineStore("together", () => {
  /** 当前会话，未加入房间时为 null */
  const session = ref<TogetherSession | null>(null);
  /** 房间信息 */
  const room = shallowRef<TogetherRoom | null>(null);
  /** 是否在房间内 */
  const inRoom = computed(() => session.value !== null);
  /** 最近一条同步事件，供服务层 watch */
  const event = shallowRef<TogetherSyncEvent | null>(null);
  /** 事件序号，同一事件重复到达时也能触发消费 */
  const eventId = ref(0);
  /** 正在等待创建 / 加入结果 */
  const busy = ref(false);

  /**
   * 应用一次主进程下发的事件
   * @param next - 同步事件
   */
  const apply = (next: TogetherSyncEvent): void => {
    if (next.type === "session") {
      session.value = next.session;
      room.value = next.room;
    } else if (next.type === "room") {
      room.value = next.room;
    } else if (next.type === "session-end") {
      session.value = null;
      room.value = null;
    }
    event.value = next;
    eventId.value += 1;
  };

  /** 成员昵称串，缺昵称时退回用户 ID */
  const memberNames = computed(() => {
    const members = room.value?.members ?? [];
    if (members.length === 0) return "";
    return members.map((member) => member.nickname || member.userId).join("、");
  });

  return { session, room, inRoom, event, eventId, busy, apply, memberNames };
});
