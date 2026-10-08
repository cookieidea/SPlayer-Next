<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { useStatusStore } from "@/stores/status";
import { useUserStore } from "@/stores/user";
import { useCopyText } from "@/composables/useCopyText";
import { toast } from "@/composables/useToast";
import * as together from "@/services/listenTogether";
import * as togetherMulti from "@/services/listenTogetherMulti";
import { buildMultiInvitation, isMultiInvitation } from "@shared/utils/togetherInvitation";
import { togetherSongAction } from "@/utils/togetherRoom";
import type { TogetherSongAction } from "@/utils/togetherRoom";
import type {
  TogetherFriend,
  TogetherInviteCard,
  TogetherMultiRoom,
  TogetherRoom,
  TogetherRoomSong,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const store = useTogetherStore();
const multiStore = useTogetherMultiStore();
const user = useUserStore();
const { copy } = useCopyText();

const invitationInput = ref("");
const friends = shallowRef<TogetherFriend[]>([]);
const friendsLoading = ref(false);
const invites = shallowRef<TogetherInviteCard[]>([]);
const roomView = ref(false);
let leaving = false;
const leavingMulti = ref(false);
const frozenMulti = ref<TogetherMultiRoom | null>(null);
// 队列行的标题/歌手来自 queueTracks，不一起冻住的话淡出期间会退化成 #歌曲id
const frozenQueueTracks = shallowRef<Track[]>([]);
let inboxToken = 0;
let friendsToken = 0;
const friendListRef = ref<HTMLElement | null>(null);
let friendListScroll = 0;
const userId = computed(() => String(user.profile?.userId ?? ""));
const frozenInvitation = ref("");
const invitation = computed(() =>
  leavingDual.value ? frozenInvitation.value : together.invitationOf(),
);
/** 退出期间冻结房间信息：清空 store 后视图会翻到加入界面，淡出还没结束就"变脸" */
const leavingDual = ref(false);
const frozenDual = ref<TogetherRoom | null>(null);
const dualRoom = computed(() => (leavingDual.value ? frozenDual.value : store.room));
const roomId = computed(() => dualRoom.value?.roomId ?? "");
const roomMembers = computed(() => dualRoom.value?.members ?? []);

const multiRoom = computed(() => (leavingMulti.value ? frozenMulti.value : multiStore.room));

/** 展示以房间歌曲为准；曲目详情单独查表，解析失败不会让下标与歌曲错位 */
const multiQueueSongs = computed(() => {
  const room = multiRoom.value;
  if (!room) return [] as TogetherRoomSong[];
  return [...(room.playSong ? [room.playSong] : []), ...room.nextSongs];
});

/**
 * 陌生人可见性。账号级设置（实测由 listening/privacy 的 listening_entrance 控制）。
 * 界面如实反映服务端状态：服务端默认为关，不主动写就不会被放开
 */
const strangerVisible = ref(false);

const onToggleStranger = async (value: boolean): Promise<void> => {
  strangerVisible.value = value;
  // 写失败要拨回去：账号级设置若显示与服务端不符，用户会以为已经放开了
  if (!(await togetherMulti.setStrangerVisible(value))) strangerVisible.value = !value;
};

/** 建房前选择要邀请的好友：0~1 人建双人房，2 人以上建多人房 */
const createFriends = shallowRef<TogetherFriend[]>([]);
const pickedFriends = ref<string[]>([]);

const loadCreateFriends = async (): Promise<void> => {
  if (!userId.value) return;
  createFriends.value = await together.loadFriends(userId.value);
};

const togglePick = (friend: TogetherFriend): void => {
  const id = friend.userId;
  pickedFriends.value = pickedFriends.value.includes(id)
    ? pickedFriends.value.filter((item) => item !== id)
    : [...pickedFriends.value, id];
};

/** 房间队列 / 邀请好友 两个面板 */
const multiPane = ref("queue");
const multiPanes = computed(() => [
  { key: "queue", label: t("player.together.roomQueue") },
  { key: "invite", label: t("player.together.inviteFriends") },
]);

const multiFriends = shallowRef<TogetherFriend[]>([]);

const loadMultiFriends = async (): Promise<void> => {
  if (!userId.value) return;
  multiFriends.value = await together.loadFriends(userId.value);
};

const onInviteMulti = async (friend: TogetherFriend): Promise<void> => {
  pending.value = `invite:${friend.userId}`;
  try {
    await togetherMulti.inviteMultiFriends([friend.userId]);
  } finally {
    pending.value = "";
  }
};

/** 复用曲目菜单那套判定：只有"自己在待播窗口里的歌"才给移除按钮 */
const roomActionOf = (song: TogetherRoomSong): TogetherSongAction =>
  togetherSongAction(
    true,
    song.songId,
    userId.value,
    multiRoom.value?.playSong?.songId ?? "",
    multiRoom.value?.nextSongs ?? [],
  );

/** 把 songRcmdUid 映成昵称。"0" 是系统推荐，不显示 */
const recommenderOf = (uid: string): string => {
  if (!uid || uid === "0") return "";
  const member = multiRoom.value?.members.find((item) => item.userId === uid);
  if (!member) return t("player.together.recommended");
  return member.userId === userId.value
    ? t("player.together.me")
    : member.nickname || member.userId;
};

const trackOf = (songId: string): Track | undefined => {
  const tracks = leavingMulti.value ? frozenQueueTracks.value : multiStore.queueTracks;
  return tracks.find((track) => track.id === songId);
};

const queueTitle = (songId: string): string => trackOf(songId)?.title ?? `#${songId}`;

const queueArtist = (songId: string): string => {
  const track = trackOf(songId);
  return track ? artistText(track) : "";
};

const onVoteSkip = async (): Promise<void> => {
  await togetherMulti.voteSkipMultiSong();
};

/** 移除只对「待播」的歌曲生效，正在播的那首由服务端拒绝（队列首项即当前曲） */
const onRemoveMultiSong = async (songId: string): Promise<void> => {
  await togetherMulti.removeMultiSong(songId);
};

const artistText = (track: Track): string =>
  (track.artists ?? [])
    .map((artist) => artist.name)
    .filter(Boolean)
    .join("、");
const onCopyMultiLink = (): void => {
  const room = multiRoom.value;
  if (!room) return;
  copy(togetherMulti.shareMultiInvitation(room.roomId, userId.value));
};

const onLeaveMulti = async (): Promise<void> => {
  pending.value = "leave";
  // 退出期间冻结房间信息：store 被清空后视图会翻到加入界面，淡出还没结束就"变脸"
  frozenMulti.value = multiStore.room;
  frozenQueueTracks.value = multiStore.queueTracks;
  leavingMulti.value = true;
  emit("update:open", false);
  try {
    await togetherMulti.leaveTogetherMulti();
  } finally {
    leavingMulti.value = false;
    pending.value = "";
  }
};

watch(multiPane, (pane) => {
  if (pane === "invite") void loadMultiFriends();
});

watch(
  () => props.open,
  (open) => {
    if (!open) {
      invitationInput.value = "";
      return;
    }
    roomView.value = store.inRoom;
    void loadInbox();
    if (store.inRoom) void loadFriends();
    else {
      void loadCreateFriends();
      void togetherMulti.getStrangerVisible().then((v) => (strangerVisible.value = v));
    }
  },
);

watch(
  () =>
    [
      store.session?.roomId,
      (store.room?.members ?? []).map((member) => member.userId).join("_"),
    ].join("|"),
  () => {
    if (!props.open) return;
    if (!leaving) roomView.value = store.inRoom;
    void loadInbox();
    if (store.inRoom) void loadFriends();
  },
);

/**
 * 建房。选 0~1 位好友建双人房，选 2 位以上建多人房
 * （多人房需要一首起播歌，因此要求当前正在播放）
 */
/**
 * 建双人房。选中 1 位好友时顺手邀请他。
 * 多人房走另一个按钮，两者不再按人数自动分流，否则两个入口语义重叠
 */
const onCreate = async (): Promise<void> => {
  if (needLogin()) return;
  pending.value = "create";
  try {
    if (!(await together.createRoom(userId.value))) return;
  } finally {
    pending.value = "";
  }
  if (pickedFriends.value.length > 0) {
    const friend = createFriends.value.find((item) => item.userId === pickedFriends.value[0]);
    if (friend) await together.inviteFriend(friend);
  }
  pickedFriends.value = [];
  roomView.value = true;
};

/** 建多人房并邀请已选好友。需要当前正在播放一首歌作为起播曲 */
const onCreateMulti = async (): Promise<void> => {
  if (needLogin()) return;
  pending.value = "createMulti";
  try {
    if (!(await togetherMulti.createMultiRoom(userId.value))) return;
  } finally {
    pending.value = "";
  }
  if (pickedFriends.value.length > 0) {
    await togetherMulti.inviteMultiFriends(pickedFriends.value);
  }
  pickedFriends.value = [];
  // 不关对话框：多人房视图由 multiStore.room 驱动，关掉会让人以为退出去了，
  // 得重新点一起听才看得到房间信息
};

const onJoin = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  pending.value = "join";
  try {
    await runJoin();
  } finally {
    pending.value = "";
  }
};

/** 加入的实际流程：按链接形态分流到双人或多人的协议 */
const runJoin = async (): Promise<void> => {
  const value = invitationInput.value.trim();
  if (!value) return;
  // 多人房分享链接与双人共用这一个输入框，靠链接路径分流
  if (isMultiInvitation(value)) {
    if (!(await togetherMulti.joinTogetherMulti(value, userId.value))) return;
    invitationInput.value = "";
    // 与建房一致：不关对话框。多人房视图由 multiStore.room 驱动，
    // 关掉会让人以为没进去，还得重新点一起听才看得到房间
    return;
  }
  if (!(await together.joinRoom(value, userId.value))) return;
  invitationInput.value = "";
  roomView.value = true;
};

const onLeave = async (): Promise<void> => {
  leaving = true;
  frozenDual.value = store.room;
  frozenInvitation.value = invitation.value;
  leavingDual.value = true;
  emit("update:open", false);
  pending.value = "leave";
  try {
    await together.leaveRoom();
  } finally {
    leavingDual.value = false;
    leaving = false;
    pending.value = "";
  }
  friends.value = [];
  invites.value = [];
};

const onCopy = (): void => void copy(invitation.value);

const loadInbox = async (): Promise<void> => {
  if (!userId.value) return;
  const token = ++inboxToken;
  const next = await together.loadInvites();
  if (token === inboxToken) invites.value = next;
};

const onAccept = async (card: TogetherInviteCard): Promise<void> => {
  pending.value = `accept:${card.roomId}`;
  try {
    await runAccept(card);
  } finally {
    pending.value = "";
  }
};

const runAccept = async (card: TogetherInviteCard): Promise<void> => {
  // 多人大厅的邀请必须走多人协议：双人的 ack 接口加入不了多人房
  if (card.multi) {
    const link = buildMultiInvitation(card.roomId, card.inviterId);
    if (!(await togetherMulti.joinTogetherMulti(link, userId.value))) return;
    invites.value = [];
    return;
  }
  if (!(await together.acceptInvite(card, userId.value))) return;
  invites.value = [];
  roomView.value = true;
};

/** 每个操作各自的忙状态：共用一个全局标志会让四个按钮一起转圈 */
const pending = ref<
  | ""
  | "create"
  | "createMulti"
  | "matchDuo"
  | "matchMulti"
  | "join"
  | `invite:${string}`
  | "leave"
  | `accept:${string}`
>("");

const needLogin = (): boolean => {
  if (userId.value) return false;
  toast.warning(t("player.together.needLogin"));
  return true;
};

const onStartMatch = async (): Promise<void> => {
  if (needLogin()) return;
  // 匹配状态由服务层维护：失败/超时都要由它复位，界面自己记会卡在"匹配中"
  pending.value = "matchDuo";
  try {
    await togetherMulti.startStrangerMatch(userId.value);
  } finally {
    pending.value = "";
  }
};

const onStartMultiMatch = async (): Promise<void> => {
  if (needLogin()) return;
  // 多人匹配要带当前播放的歌曲，没有就传 0
  pending.value = "matchMulti";
  try {
    await togetherMulti.startMultiMatch(String(useStatusStore().currentTrack?.id ?? "0"));
  } finally {
    pending.value = "";
  }
};

const onCancelMatch = async (): Promise<void> => {
  if (multiStore.matching === "multi") await togetherMulti.cancelMultiMatch();
  else await togetherMulti.cancelStrangerMatch();
};

const onRejectInvite = async (card: TogetherInviteCard): Promise<void> => {
  await together.rejectInvite(card.roomId);
  invites.value = invites.value.filter((item) => item.roomId !== card.roomId);
};

let friendsPending = false;

const loadFriends = async (): Promise<void> => {
  if (!userId.value) return;
  if (friendsLoading.value) {
    friendsPending = true;
    return;
  }
  friendsLoading.value = true;
  const token = ++friendsToken;
  const keepScroll = friendListRef.value?.scrollTop ?? friendListScroll;
  try {
    const next = await together.loadFriends(userId.value);
    if (token === friendsToken) friends.value = next;
  } finally {
    friendsLoading.value = false;
  }
  friendListScroll = keepScroll;
  await nextTick();
  if (friendListRef.value) friendListRef.value.scrollTop = keepScroll;
  if (friendsPending) {
    friendsPending = false;
    void loadFriends();
  }
};

const onInvite = async (friend: TogetherFriend): Promise<void> => {
  await together.inviteFriend(friend);
};
</script>

<template>
  <SDialog
    :open="open"
    :title="t('player.together.title')"
    :description="t('player.together.description')"
    width="440px"
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-4">
      <template v-if="multiRoom">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-on-surface-variant">{{ t("player.together.members") }}</span>
          <div v-if="multiRoom.members.length" class="flex flex-wrap gap-2">
            <div
              v-for="member in multiRoom.members"
              :key="member.userId"
              class="flex items-center gap-1.5"
            >
              <SImg :src="member.avatarUrl" class="size-6 rounded-full shrink-0" />
              <span class="text-xs truncate max-w-[88px]">
                {{ member.nickname || member.userId }}
              </span>
            </div>
          </div>
          <span v-else class="text-sm text-on-surface-variant/70">
            {{ t("player.together.waitingPeer") }}
          </span>
          <span class="text-xs text-on-surface-variant mt-2">{{ t("player.together.room") }}</span>
          <span class="text-xs break-all text-on-surface-variant/80">{{ multiRoom.roomId }}</span>
        </div>
        <STabs v-model="multiPane" type="segment" size="small" :tabs="multiPanes">
          <template #queue>
            <div class="flex flex-col gap-1 mt-3">
              <p v-if="multiQueueSongs.length === 0" class="text-xs text-on-surface-variant/70">
                {{ t("player.together.emptyQueue") }}
              </p>
              <div v-else class="flex flex-col gap-1 max-h-[160px] overflow-y-auto pr-1">
                <div
                  v-for="(song, index) in multiQueueSongs"
                  :key="song.songId"
                  class="flex items-center gap-2 text-xs"
                >
                  <span class="w-4 text-right text-on-surface-variant/60">{{ index + 1 }}</span>
                  <span class="flex-1 min-w-0 truncate">{{ queueTitle(song.songId) }}</span>
                  <span class="shrink-0 text-on-surface-variant/70">
                    {{ queueArtist(song.songId) }}
                  </span>
                  <span
                    v-if="recommenderOf(song.songRcmdUid)"
                    class="shrink-0 text-on-surface-variant/60 max-w-[64px] truncate"
                  >
                    {{ recommenderOf(song.songRcmdUid) }}
                  </span>
                  <SButton
                    v-if="roomActionOf(song) === 'pending'"
                    variant="ghost"
                    circle
                    size="small"
                    :title="t('player.together.removeFromRoom')"
                    @click="onRemoveMultiSong(song.songId)"
                  >
                    <template #icon><IconLucideX /></template>
                  </SButton>
                </div>
              </div>
            </div>
          </template>
          <template #invite>
            <div class="flex flex-col gap-2 mt-3">
              <p v-if="multiFriends.length === 0" class="text-xs text-on-surface-variant/70">
                {{ t("player.together.noFriends") }}
              </p>
              <div v-else class="flex flex-col gap-1 max-h-[160px] overflow-y-auto pr-1">
                <div
                  v-for="friend in multiFriends"
                  :key="friend.userId"
                  class="flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-primary/8"
                >
                  <SImg :src="friend.avatarUrl" class="size-7 rounded-full shrink-0" />
                  <span class="flex-1 min-w-0 truncate text-sm">{{ friend.nickname }}</span>
                  <SButton
                    size="small"
                    variant="secondary"
                    :loading="pending === `invite:${friend.userId}`"
                    @click="onInviteMulti(friend)"
                  >
                    {{ t("player.together.invite") }}
                  </SButton>
                </div>
              </div>
              <SDivider />
              <SButton variant="secondary" @click="onCopyMultiLink">
                {{ t("player.together.copy") }}
              </SButton>
            </div>
          </template>
        </STabs>
        <div class="flex items-center gap-2">
          <SButton variant="secondary" :disabled="!multiRoom.playSong" @click="onVoteSkip">
            <template #icon><IconLucideSkipForward /></template>
            {{ t("player.together.voteSkip") }}
          </SButton>
          <SButton
            type="error"
            variant="secondary"
            :loading="pending === 'leave'"
            @click="onLeaveMulti"
          >
            {{ t("player.together.leave") }}
          </SButton>
        </div>
      </template>
      <template v-else-if="roomView">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-on-surface-variant">{{ t("player.together.members") }}</span>
          <div v-if="roomMembers.length" class="flex flex-wrap gap-2">
            <div
              v-for="member in roomMembers"
              :key="member.userId"
              class="flex items-center gap-1.5"
            >
              <SImg :src="member.avatarUrl" class="size-6 rounded-full shrink-0" />
              <span class="text-xs truncate max-w-[88px]">
                {{ member.nickname || member.userId }}
              </span>
            </div>
          </div>
          <span v-else class="text-sm text-on-surface-variant/70">
            {{ t("player.together.waitingPeer") }}
          </span>
          <span class="text-xs text-on-surface-variant mt-2">{{ t("player.together.room") }}</span>
          <span class="text-xs break-all text-on-surface-variant/80">{{ roomId }}</span>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-xs text-on-surface-variant">
            {{ t("player.together.inviteFriends") }}
          </span>
          <p
            v-if="friendsLoading && friends.length === 0"
            class="text-xs text-on-surface-variant/70"
          >
            {{ t("common.loading") }}
          </p>
          <p v-else-if="friends.length === 0" class="text-xs text-on-surface-variant/70">
            {{ t("player.together.noFriends") }}
          </p>
          <div
            v-else
            ref="friendListRef"
            class="flex flex-col gap-1 max-h-[180px] overflow-y-auto pr-1"
          >
            <div
              v-for="friend in friends"
              :key="friend.userId"
              class="flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-on-surface/5"
            >
              <SImg
                v-if="friend.avatarUrl"
                :src="friend.avatarUrl"
                class="w-7 h-7 rounded-full shrink-0"
              />
              <span class="flex-1 text-sm truncate">{{ friend.nickname || friend.userId }}</span>
              <STag v-if="friend.joined" size="small" type="primary" variant="soft">
                {{ t("player.together.joined") }}
              </STag>
              <STag
                v-else-if="store.isInvited(friend.userId)"
                size="small"
                type="default"
                variant="soft"
              >
                {{ t("player.together.invited") }}
              </STag>
              <SButton
                v-else
                size="small"
                type="info"
                variant="secondary"
                @click="onInvite(friend)"
              >
                {{ t("player.together.invite") }}
              </SButton>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-xs text-on-surface-variant">
            {{ t("player.together.invitation") }}
          </span>
          <div class="flex items-center gap-2">
            <SInput :model-value="invitation" readonly class="flex-1" @focus="onCopy" />
            <SButton type="info" :disabled="!invitation" @click="onCopy">
              {{ t("player.together.copy") }}
            </SButton>
          </div>
        </div>

        <SButton type="error" variant="secondary" :loading="pending === 'leave'" @click="onLeave">
          {{ t("player.together.leave") }}
        </SButton>
      </template>

      <template v-else>
        <div v-if="invites.length > 0" class="flex flex-col gap-2">
          <span class="text-xs text-on-surface-variant">
            {{ t("player.together.pendingInvites") }}
          </span>
          <div
            v-for="card in invites"
            :key="card.roomId"
            class="flex items-center gap-2 px-2 py-2 rounded-lg bg-primary/8"
          >
            <SImg
              v-if="card.inviterAvatarUrl"
              :src="card.inviterAvatarUrl"
              class="w-8 h-8 rounded-full shrink-0"
            />
            <div class="flex-1 min-w-0 flex flex-col">
              <span class="text-sm truncate">
                {{ t("player.together.invitedBy", { name: card.inviterName || card.inviterId }) }}
              </span>
              <span class="text-xs text-on-surface-variant truncate">{{ card.title }}</span>
            </div>
            <SButton size="small" variant="secondary" @click="onRejectInvite(card)">
              {{ t("player.together.reject") }}
            </SButton>
            <SButton
              size="small"
              type="primary"
              :loading="pending === `accept:${card.roomId}`"
              @click="onAccept(card)"
            >
              {{ t("player.together.accept") }}
            </SButton>
          </div>
        </div>

        <p class="text-sm text-on-surface-variant leading-relaxed">
          {{ userId ? t("player.together.hint") : t("player.together.needLogin") }}
        </p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm">{{ t("player.together.allowStranger") }}</span>
          <SSwitch :model-value="strangerVisible" @update:model-value="onToggleStranger" />
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-xs text-on-surface-variant">
            {{ t("player.together.pickFriendsHint") }}
          </span>
          <p v-if="createFriends.length === 0" class="text-xs text-on-surface-variant/70">
            {{ t("player.together.noFriends") }}
          </p>
          <div v-else class="flex flex-col gap-1 max-h-[140px] overflow-y-auto pr-1">
            <div
              v-for="friend in createFriends"
              :key="friend.userId"
              class="flex items-center gap-2 px-1 py-1 rounded-lg cursor-pointer hover:bg-on-surface/5"
              :class="pickedFriends.includes(friend.userId) ? 'bg-primary/10' : ''"
              @click="togglePick(friend)"
            >
              <SImg :src="friend.avatarUrl" class="w-7 h-7 rounded-full shrink-0" />
              <span class="flex-1 text-sm truncate">{{ friend.nickname || friend.userId }}</span>
              <STag
                v-if="pickedFriends.includes(friend.userId)"
                size="small"
                type="primary"
                variant="soft"
              >
                {{ t("player.together.picked") }}
              </STag>
            </div>
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <div class="flex gap-2">
            <SButton
              class="flex-1"
              type="primary"
              :loading="pending === 'create'"
              :disabled="!userId"
              @click="onCreate"
            >
              {{ t("player.together.create") }}
            </SButton>
            <SButton
              class="flex-1"
              variant="secondary"
              :loading="pending === 'createMulti'"
              :disabled="!userId"
              @click="onCreateMulti"
            >
              {{ t("player.together.createMulti") }}
            </SButton>
          </div>
          <div class="flex gap-2">
            <template v-if="!multiStore.matching">
              <SButton
                class="flex-1"
                type="info"
                variant="secondary"
                :loading="pending === 'matchDuo'"
                :disabled="!userId"
                @click="onStartMatch"
              >
                {{ t("player.together.matchDuo") }}
              </SButton>
              <SButton
                class="flex-1"
                type="info"
                variant="secondary"
                :loading="pending === 'matchMulti'"
                :disabled="!userId"
                @click="onStartMultiMatch"
              >
                {{ t("player.together.matchMulti") }}
              </SButton>
            </template>
            <SButton v-else class="flex-1" type="error" variant="secondary" @click="onCancelMatch">
              {{ t("player.together.cancelMatch") }}
            </SButton>
          </div>
        </div>
        <SDivider />
        <div class="flex flex-col gap-2">
          <SInput
            v-model="invitationInput"
            :placeholder="t('player.together.inputPlaceholder')"
            :disabled="!userId"
          />
          <SButton
            type="info"
            variant="secondary"
            :loading="pending === 'join'"
            :disabled="!userId || !invitationInput.trim()"
            @click="onJoin"
          >
            {{ t("player.together.join") }}
          </SButton>
        </div>
      </template>
    </div>
  </SDialog>
</template>
