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

defineProps<{ open: boolean }>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const store = useTogetherStore();
const user = useUserStore();
const { copy } = useCopyText();

const invitationInput = ref("");
/** 本机用户 ID，未登录时为空串 */
const userId = computed(() => String(user.profile?.userId ?? ""));
const invitation = computed(() => together.invitationOf());
const memberText = computed(() => store.memberNames || t("player.together.waitingPeer"));

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
