import type {
  TogetherRoom,
  TogetherSession,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";

const INVITED_KEY = "together-invited";

const readInvited = (): Record<string, string[]> => {
  try {
    const raw = localStorage.getItem(INVITED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export const useTogetherStore = defineStore("together", () => {
  const session = ref<TogetherSession | null>(null);
  const room = shallowRef<TogetherRoom | null>(null);
  const inRoom = computed(() => session.value !== null);
  const busy = ref(false);
  const invitedByRoom = ref<Record<string, string[]>>(readInvited());

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

  const invitedIds = computed(() => {
    const roomId = session.value?.roomId;
    if (!roomId) return [] as string[];
    return invitedByRoom.value[roomId] ?? [];
  });

  const isInvited = (userId: string): boolean => invitedIds.value.includes(userId);

  const markInvited = (userId: string, roomIdArg?: string): void => {
    const roomId = roomIdArg || session.value?.roomId;
    if (!roomId || !userId) return;
    const current = invitedByRoom.value[roomId] ?? [];
    if (current.includes(userId)) return;
    invitedByRoom.value = {
      ...invitedByRoom.value,
      [roomId]: [...current, userId],
    };
    try {
      localStorage.setItem(INVITED_KEY, JSON.stringify(invitedByRoom.value));
    } catch {
      void 0;
    }
  };

  const memberNames = computed(() => {
    const members = room.value?.members ?? [];
    if (members.length === 0) return "";
    return members.map((member) => member.nickname || member.userId).join("、");
  });

  return { session, room, inRoom, busy, apply, memberNames, invitedIds, isInvited, markInvited };
});
