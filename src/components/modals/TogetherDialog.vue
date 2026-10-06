<script setup lang="ts">
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
const friends = shallowRef<TogetherFriend[]>([]);
const friendsLoading = ref(false);
const invites = shallowRef<TogetherInviteCard[]>([]);
const roomView = ref(false);
let leaving = false;
const userId = computed(() => String(user.profile?.userId ?? ""));
const invitation = computed(() => together.invitationOf());
const memberNames = ref("");
const roomId = ref("");
const memberText = computed(() => memberNames.value || t("player.together.waitingPeer"));

const snapRoom = (): void => {
  memberNames.value = store.memberNames;
  roomId.value = store.room?.roomId ?? "";
};

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
  },
);

watch(
  () => [store.session?.roomId, store.room?.members.length ?? 0].join("|"),
  () => {
    if (!props.open) return;
    if (!leaving) roomView.value = store.inRoom;
    snapRoom();
    void loadInbox();
    if (store.inRoom) void loadFriends();
  },
);

const onCreate = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  if (!(await together.createRoom(userId.value))) return;
  roomView.value = true;
  snapRoom();
};

const onJoin = async (): Promise<void> => {
  if (!userId.value) {
    toast.warning(t("player.together.needLogin"));
    return;
  }
  const value = invitationInput.value.trim();
  if (!value) return;
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
  invites.value = await together.loadInvites();
};

const onAccept = async (card: TogetherInviteCard): Promise<void> => {
  if (!(await together.acceptInvite(card, userId.value))) return;
  invites.value = [];
  roomView.value = true;
  snapRoom();
};

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
      <template v-if="roomView">
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
