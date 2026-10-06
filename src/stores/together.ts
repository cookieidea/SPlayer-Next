import type {
  TogetherRoom,
  TogetherSession,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";

export const useTogetherStore = defineStore("together", () => {
  const session = ref<TogetherSession | null>(null);
  const room = shallowRef<TogetherRoom | null>(null);
  const inRoom = computed(() => session.value !== null);
  const busy = ref(false);

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
  };

  const memberNames = computed(() => {
    const members = room.value?.members ?? [];
    if (members.length === 0) return "";
    return members.map((member) => member.nickname || member.userId).join("、");
  });

  return { session, room, inRoom, busy, apply, memberNames };
});
