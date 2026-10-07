<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { useStatusStore } from "@/stores/status";
import { useUserStore } from "@/stores/user";
import { useCopyText } from "@/composables/useCopyText";
import { toast } from "@/composables/useToast";
import * as together from "@/services/listenTogether";
import * as togetherMulti from "@/services/listenTogetherMulti";
import { isMultiInvitation } from "@shared/utils/togetherInvitation";
import type {
  TogetherFriend,
  TogetherInviteCard,
  TogetherMultiRoom,
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
const frozenMembers = ref("");
let inboxToken = 0;
let friendsToken = 0;
const friendListRef = ref<HTMLElement | null>(null);
let friendListScroll = 0;
const userId = computed(() => String(user.profile?.userId ?? ""));
const invitation = computed(() => together.invitationOf());
const memberNames = ref("");
const roomId = ref("");
const memberText = computed(() => memberNames.value || t("player.together.waitingPeer"));

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
  await togetherMulti.setStrangerVisible(value);
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
  await togetherMulti.inviteMultiFriends([friend.userId]);
};

/** 只有自己加的才给移除按钮：服务端对别人的歌会回"只能删除自己添加的歌曲哦～" */
const isMine = (songRcmdUid: string): boolean =>
  Boolean(songRcmdUid) && songRcmdUid === userId.value;

/** 把 songRcmdUid 映成昵称。"0" 是系统推荐，不显示 */
const recommenderOf = (uid: string): string => {
  if (!uid || uid === "0") return "";
  const member = multiRoom.value?.members.find((item) => item.userId === uid);
  if (!member) return t("player.together.recommended");
  return member.userId === userId.value
    ? t("player.together.me")
    : member.nickname || member.userId;
};

const trackOf = (songId: string): Track | undefined =>
  multiStore.queueTracks.find((track) => track.id === songId);

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
  // 退出期间冻结房间信息：store 被清空后视图会翻到加入界面，淡出还没结束就"变脸"
  frozenMulti.value = multiStore.room;
  frozenMembers.value = multiStore.memberNames;
  leavingMulti.value = true;
  emit("update:open", false);
  try {
    await togetherMulti.leaveTogetherMulti();
  } finally {
    leavingMulti.value = false;
  }
};

const snapRoom = (): void => {
  memberNames.value = store.memberNames;
  roomId.value = store.room?.roomId ?? "";
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
    snapRoom();
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
    snapRoom();
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
  if (!(await together.createRoom(userId.value))) return;
  if (pickedFriends.value.length > 0) {
    const friend = createFriends.value.find((item) => item.userId === pickedFriends.value[0]);
    if (friend) await together.inviteFriend(friend);
  }
  pickedFriends.value = [];
  roomView.value = true;
  snapRoom();
};

/** 建多人房并邀请已选好友。需要当前正在播放一首歌作为起播曲 */
const onCreateMulti = async (): Promise<void> => {
  if (needLogin()) return;
  if (!(await togetherMulti.createMultiRoom(userId.value))) return;
  if (pickedFriends.value.length > 0) {
    await togetherMulti.inviteMultiFriends(pickedFriends.value);
  }
  pickedFriends.value = [];
  emit("update:open", false);
};

const onJoin = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  const value = invitationInput.value.trim();
  if (!value) return;
  // 多人房分享链接与双人共用这一个输入框，靠链接路径分流
  if (isMultiInvitation(value)) {
    if (!(await togetherMulti.joinTogetherMulti(value, userId.value))) return;
    invitationInput.value = "";
    emit("update:open", false);
    return;
  }
  if (!(await together.joinRoom(value, userId.value))) return;
  invitationInput.value = "";
  roomView.value = true;
  snapRoom();
};

const onLeave = async (): Promise<void> => {
  leaving = true;
  emit("update:open", false);
  try {
    await together.leaveRoom();
  } finally {
    leaving = false;
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
  if (!(await together.acceptInvite(card, userId.value))) return;
  invites.value = [];
  roomView.value = true;
  snapRoom();
};

/** 空串表示未在匹配；否则标明在匹配哪一类 */
const matching = ref<"" | "duo" | "multi">("");

const needLogin = (): boolean => {
  if (userId.value) return false;
  toast.warning(t("player.together.needLogin"));
  return true;
};

const onStartMatch = async (): Promise<void> => {
  if (needLogin()) return;
  matching.value = "duo";
  await togetherMulti.startStrangerMatch(userId.value);
};

const onStartMultiMatch = async (): Promise<void> => {
  if (needLogin()) return;
  matching.value = "multi";
  // 多人匹配要带当前播放的歌曲，没有就传 0
  await togetherMulti.startMultiMatch(String(useStatusStore().currentTrack?.id ?? "0"));
};

const onCancelMatch = async (): Promise<void> => {
  if (matching.value === "multi") await togetherMulti.cancelMultiMatch();
  else await togetherMulti.cancelStrangerMatch();
  matching.value = "";
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
                    v-if="index > 0 && isMine(song.songRcmdUid)"
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
                    :disabled="multiStore.busy"
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
            :loading="multiStore.busy"
            @click="onLeaveMulti"
          >
            {{ t("player.together.leave") }}
          </SButton>
        </div>
      </template>
      <template v-else-if="roomView">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-on-surface-variant">{{ t("player.together.members") }}</span>
          <span class="text-sm break-all">{{ memberText }}</span>
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

        <SButton type="error" variant="secondary" :loading="store.busy" @click="onLeave">
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
            <SButton size="small" type="primary" :loading="store.busy" @click="onAccept(card)">
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
              :loading="store.busy"
              :disabled="!userId"
              @click="onCreate"
            >
              {{ t("player.together.create") }}
            </SButton>
            <SButton
              class="flex-1"
              variant="secondary"
              :loading="multiStore.busy"
              :disabled="!userId"
              @click="onCreateMulti"
            >
              {{ t("player.together.createMulti") }}
            </SButton>
          </div>
          <div class="flex gap-2">
            <template v-if="!matching">
              <SButton
                class="flex-1"
                type="info"
                variant="secondary"
                :loading="multiStore.busy"
                :disabled="!userId"
                @click="onStartMatch"
              >
                {{ t("player.together.matchDuo") }}
              </SButton>
              <SButton
                class="flex-1"
                type="info"
                variant="secondary"
                :loading="multiStore.busy"
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
            :loading="store.busy"
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
