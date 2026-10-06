<script setup lang="ts">
/**
 * 网易云「一起听」房间面板
 *
 * 未在房间时提供创建与邀请链接加入；在房间时展示成员与邀请链接，可复制或退出。
 */

import { useTogetherStore } from "@/stores/together";
import { useUserStore } from "@/stores/user";
import { useCopyText } from "@/composables/useCopyText";
import { toast } from "@/composables/useToast";
import * as together from "@/services/listenTogether";
import type { TogetherFriend, TogetherInviteCard } from "@shared/types/listenTogether";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const store = useTogetherStore();
const user = useUserStore();
const { copy } = useCopyText();

const invitationInput = ref("");
/** 可邀请的好友（我已关注的人） */
const friends = shallowRef<TogetherFriend[]>([]);
const friendsLoading = ref(false);
/** 收到的一起听邀请（来自私信卡片） */
const invites = shallowRef<TogetherInviteCard[]>([]);
/** 本机用户 ID，未登录时为空串 */
const userId = computed(() => String(user.profile?.userId ?? ""));
const invitation = computed(() => together.invitationOf());
const memberText = computed(() => store.memberNames || t("player.together.waitingPeer"));

// 组件由播放条常驻挂载，关闭时不会卸载，输入内容得自己清掉
watch(
  () => props.open,
  (open) => {
    if (!open) {
      invitationInput.value = "";
      return;
    }
    // 进房间时拉好友；不在房间时要看有没有别人发来的邀请
    void loadInbox();
    if (store.inRoom) void loadFriends();
  },
);

const onCreate = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  await together.createRoom(userId.value);
};

const onJoin = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  const value = invitationInput.value.trim();
  if (!value) return;
  if (await together.joinRoom(value, userId.value)) invitationInput.value = "";
};

const onLeave = async (): Promise<void> => {
  await together.leaveRoom();
  emit("update:open", false);
};

const onCopy = (): void => void copy(invitation.value);

/** 拉一次收件箱：对方点过「邀请」但没分享链接时，只有这里能看到 */
const loadInbox = async (): Promise<void> => {
  if (!userId.value) return;
  invites.value = await together.loadInvites();
};

const onAccept = async (card: TogetherInviteCard): Promise<void> => {
  if (await together.acceptInvite(card, userId.value)) invites.value = [];
};

/** 拉一次关注列表：进入房间后再拉，才能标出已在房间内的人 */
const loadFriends = async (): Promise<void> => {
  if (!userId.value || friendsLoading.value) return;
  friendsLoading.value = true;
  try {
    friends.value = await together.loadFriends(userId.value);
  } finally {
    friendsLoading.value = false;
  }
};

const onInvite = async (friend: TogetherFriend): Promise<void> => {
  if (await together.inviteFriend(friend)) await loadFriends();
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
      <template v-if="store.inRoom">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-on-surface-variant">{{ t("player.together.members") }}</span>
          <span class="text-sm break-all">{{ memberText }}</span>
          <span class="text-xs text-on-surface-variant mt-2">{{ t("player.together.room") }}</span>
          <span class="text-xs break-all text-on-surface-variant/80">{{ store.room?.roomId }}</span>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-xs text-on-surface-variant">
            {{ t("player.together.inviteFriends") }}
          </span>
          <p v-if="friendsLoading" class="text-xs text-on-surface-variant/70">
            {{ t("common.loading") }}
          </p>
          <p v-else-if="friends.length === 0" class="text-xs text-on-surface-variant/70">
            {{ t("player.together.noFriends") }}
          </p>
          <div v-else class="flex flex-col gap-1 max-h-[180px] overflow-y-auto pr-1">
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
            <SButton size="small" type="primary" :loading="store.busy" @click="onAccept(card)">
              {{ t("player.together.accept") }}
            </SButton>
          </div>
        </div>

        <p class="text-sm text-on-surface-variant leading-relaxed">
          {{ userId ? t("player.together.hint") : t("player.together.needLogin") }}
        </p>
        <SButton type="primary" :loading="store.busy" :disabled="!userId" @click="onCreate">
          {{ t("player.together.create") }}
        </SButton>
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
