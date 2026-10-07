<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { voteSkipMultiSong } from "@/services/listenTogetherMulti";
import * as player from "@/core/player";

withDefaults(
  defineProps<{
    /** 紧凑模式 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const status = useStatusStore();
const media = useMediaStore();
const { isPlaying, isLoading, repeatMode, shuffleMode, heartMode, fmMode } = storeToRefs(status);

const { t } = useI18n();
const hasTrack = computed(() => !!media.track);
const multiStore = useTogetherMultiStore();

/**
 * 多人房里本地切歌会被心跳拉回房间当前曲，等于白切。
 * 改成向房间投一票（实测 operate=4，人数够时服务端直接切走），
 * 这才是该房间里唯一有效的切歌方式
 */
const onPrev = async (): Promise<void> => {
  if (multiStore.inRoom) {
    await voteSkipMultiSong();
    return;
  }
  await player.prevTrack();
};

const onNext = async (): Promise<void> => {
  if (multiStore.inRoom) {
    await voteSkipMultiSong();
    return;
  }
  await player.nextTrack();
};
</script>

<template>
  <div class="flex items-center" :class="compact ? 'gap-0' : 'gap-2.5'">
    <SButton
      class="will-change-transform"
      type="primary"
      variant="ghost"
      circle
      ripple
      :size="compact ? 32 : 38"
      @click="
        fmMode
          ? player.dislikeFmTrack()
          : heartMode
            ? player.exitHeartMode()
            : player.toggleShuffleMode()
      "
    >
      <template #icon>
        <IconLucideHeartOff v-if="fmMode" />
        <IconSpHeartMode v-else-if="heartMode" />
        <IconLucideShuffle v-else-if="shuffleMode === 'on'" />
        <IconSpPlayOrder v-else />
      </template>
    </SButton>
    <SButton
      class="will-change-transform"
      type="primary"
      variant="ghost"
      circle
      ripple
      :size="compact ? 34 : 38"
      :disabled="!hasTrack || fmMode"
      :title="multiStore.inRoom ? t('player.together.voteSkip') : undefined"
      @click="onPrev"
    >
      <template #icon><IconLucideSkipBack /></template>
    </SButton>
    <SButton
      type="primary"
      variant="secondary"
      circle
      ripple
      :class="[compact ? 'mx-0.5' : 'mx-1', 'will-change-transform']"
      :size="compact ? 40 : 44"
      :loading="isLoading"
      :disabled="!hasTrack && !isLoading"
      @click="player.togglePlay()"
    >
      <template #icon>
        <SIconSwap :active="isPlaying">
          <template #on><IconLucidePause /></template>
          <template #off><IconLucidePlay /></template>
        </SIconSwap>
      </template>
    </SButton>
    <SButton
      class="will-change-transform"
      type="primary"
      variant="ghost"
      circle
      ripple
      :size="compact ? 34 : 38"
      :disabled="!hasTrack"
      :title="multiStore.inRoom ? t('player.together.voteSkip') : undefined"
      @click="onNext"
    >
      <template #icon>
        <IconLucideVote v-if="multiStore.inRoom" />
        <IconLucideSkipForward v-else />
      </template>
    </SButton>
    <SButton
      class="will-change-transform"
      :type="fmMode ? 'default' : 'primary'"
      variant="ghost"
      circle
      ripple
      :size="compact ? 32 : 38"
      :disabled="fmMode"
      @click="player.cycleRepeatMode()"
    >
      <template #icon>
        <IconLucideInfinity v-if="fmMode" />
        <IconLucideRepeat1 v-else-if="repeatMode === 'one'" />
        <IconLucideRepeat v-else />
      </template>
    </SButton>
  </div>
</template>
