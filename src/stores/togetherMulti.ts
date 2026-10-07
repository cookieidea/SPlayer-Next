import type {
  TogetherMultiEvent,
  TogetherMultiRoom,
  TogetherMultiSession,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

export const useTogetherMultiStore = defineStore("togetherMulti", () => {
  const session = ref<TogetherMultiSession | null>(null);
  const room = shallowRef<TogetherMultiRoom | null>(null);
  const inRoom = computed(() => session.value !== null);
  const busy = ref(false);
  /** 正在匹配的房型（空串=未在匹配）。由服务层维护：只有它知道匹配何时结束 */
  const matching = ref<"" | "duo" | "multi">("");
  // 房间队列（当前曲 + 接下来几首）。它是只读展示用的，永远不进本地播放队列
  const queueTracks = shallowRef<Track[]>([]);

  const apply = (next: TogetherMultiEvent): void => {
    // 旧会话的迟到事件必须丢弃：退房后它会把新会话的状态覆盖掉
    // error 不属于任何会话，直接放过
    if (next.type === "error") return;
    const expected = session.value?.generation;
    const incoming = next.type === "session" ? next.session.generation : next.generation;
    if (next.type !== "session" && incoming !== expected) return;

    if (next.type === "session") {
      session.value = next.session;
      room.value = next.room;
    } else if (next.type === "room") {
      room.value = next.room;
    } else {
      session.value = null;
      room.value = null;
      queueTracks.value = [];
    }
  };

  const memberNames = computed(() => {
    const members = room.value?.members ?? [];
    if (members.length === 0) return "";
    return members.map((member) => member.nickname || member.userId).join("、");
  });

  return { session, room, inRoom, busy, matching, queueTracks, apply, memberNames };
});
