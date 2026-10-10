<script setup lang="ts">
import type { Track } from "@shared/types/player";
import type { SVirtualListExposed } from "@/components/ui/SVirtualList.vue";
import { useQueuePanel } from "@/composables/useQueuePanel";
import { computed } from "vue";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { addMultiSong, topMultiSong } from "@/services/listenTogetherMulti";

defineEmits<{ close: [] }>();

const { t } = useI18n();
const multiStore = useTogetherMultiStore();
const listRef = shallowRef<SVirtualListExposed | null>(null);

const onAddToRoom = async (item: Track): Promise<void> => {
  await addMultiSong(item);
};

/**
 * 房内时显示房间队列（当前曲 + 待播），而不是本地播放队列：
 * 加歌只进房间不进本地队列，两套顺序必然漂移——用户看到的"列表错误"
 * 就是本地队列缺刚加的歌、顺序与房间不一致
 */
const {
  statusStore,
  queue,
  queueLength,
  formatArtists,
  playAt,
  removeAt,
  clearConfirmOpen,
  clearAll,
  scrollToCurrent,
} = useQueuePanel({ listRef });

const roomQueue = computed<Track[]>(() => {
  const tracks = multiStore.queueTracks;
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const room = multiStore.room;
  if (!room) return [];
  const ids = [
    ...(room.playSong ? [room.playSong.songId] : []),
    ...room.nextSongs.map((song) => song.songId),
  ];
  return ids.map((id) => byId.get(id)).filter((track): track is Track => track !== undefined);
});
const inRoom = computed(() => multiStore.inRoom);
const displayQueue = computed<Track[]>(() =>
  inRoom.value ? roomQueue.value : (queue.value as Track[]),
);
const currentSongId = computed(() => multiStore.room?.playSong?.songId ?? "");

/** 房内点歌：不是房内曲目就加入；已在待播则置顶让服务端切过去（跟随不变） */
const onRoomSongClick = async (item: Track): Promise<void> => {
  const room = multiStore.room;
  if (!room) return;
  if (item.id === room.playSong?.songId) return;
  const pending = room.nextSongs.find((song) => song.songId === item.id);
  if (pending) {
    await topMultiSong(item);
  } else {
    await addMultiSong(item);
  }
};
</script>

<template>
  <div class="flex flex-col h-full text-cover">
    <div class="shrink-0 flex items-start justify-between gap-4 pl-1 pr-20 pb-4">
      <div class="flex flex-col min-w-0 pl-2.5">
        <h2 class="m-0 text-2xl font-semibold leading-tight truncate">
          {{ t("playlist.title") }}
        </h2>
        <span class="text-sm text-cover/55 mt-1">
          {{ t("common.totalSongs", { count: queueLength }) }}
        </span>
      </div>
      <div class="shrink-0 flex items-center gap-3">
        <SButton
          type="cover"
          variant="secondary"
          round
          :size="40"
          :disabled="queueLength === 0"
          @click="scrollToCurrent"
        >
          <template #icon><IconLucideLocate /></template>
        </SButton>
        <SButton
          type="cover"
          variant="secondary"
          round
          :size="40"
          :disabled="queueLength === 0"
          @click="clearConfirmOpen = true"
        >
          <template #icon><IconLucideTrash2 /></template>
        </SButton>
        <SButton type="cover" variant="secondary" round :size="40" @click="$emit('close')">
          <template #icon><IconLucideX /></template>
        </SButton>
      </div>
    </div>
    <!-- 列表 -->
    <div
      v-if="queueLength > 0"
      class="flex-1 min-h-0"
      :style="{
        maskImage:
          'linear-gradient(180deg, transparent 0px, #000 32px, #000 calc(100% - 32px), transparent 100%)',
      }"
    >
      <SVirtualList
        ref="listRef"
        :items="displayQueue"
        :item-height="72"
        :padding-top="32"
        :padding-bottom="32"
        item-fixed
        cover
        height="100%"
        :default-scroll-index="Math.max(0, statusStore.playIndex)"
        :get-item-key="(item: Track) => item.id"
      >
        <template #default="{ item, index }: { item: Track; index: number }">
          <div class="relative pl-1 pr-20 py-1">
            <div
              class="group relative flex items-center gap-3 px-2.5 h-16 rounded-xl cursor-pointer transition-[background-color] duration-150"
              :class="
                (inRoom ? item.id === currentSongId : index === statusStore.playIndex)
                  ? 'bg-cover/14 text-cover'
                  : 'hover:bg-cover/8 active:bg-cover/12'
              "
              @click="inRoom ? onRoomSongClick(item) : playAt(index)"
            >
              <!-- 当前播放：左侧 indicator -->
              <span
                v-if="inRoom ? item.id === currentSongId : index === statusStore.playIndex"
                class="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-cover"
              />
              <SImg :src="item.cover" class="size-12 rounded-lg shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="text-base truncate font-medium leading-snug">{{ item.title }}</div>
                <div
                  class="text-sm truncate leading-snug mt-0.5"
                  :class="index === statusStore.playIndex ? 'text-cover/70' : 'text-cover/55'"
                >
                  {{ formatArtists(item.artists) }}
                </div>
              </div>
              <SButton
                v-if="multiStore.inRoom"
                type="cover"
                variant="ghost"
                circle
                size="tiny"
                class="opacity-0 group-hover:opacity-100"
                :title="t('player.together.addToRoom')"
                @click.stop="onAddToRoom(item)"
              >
                <template #icon><IconLucideUsers /></template>
              </SButton>
              <!-- 房内队列由服务端管理：本地移除会破坏跟随 -->
              <SButton
                v-if="!inRoom"
                type="cover"
                variant="ghost"
                circle
                size="tiny"
                class="opacity-0 group-hover:opacity-100"
                @click.stop="removeAt(index)"
              >
                <template #icon><IconLucideX /></template>
              </SButton>
            </div>
          </div>
        </template>
      </SVirtualList>
    </div>
    <!-- 空 -->
    <div v-else class="flex-1 flex items-center justify-center text-cover/35">
      <div class="text-center">
        <IconLucideListMusic class="size-10 mx-auto mb-2 opacity-40" />
        <div class="text-sm">{{ t("playlist.empty") }}</div>
      </div>
    </div>

    <!-- 清空确认 -->
    <SDialog v-model:open="clearConfirmOpen" :title="t('playlist.clearConfirmTitle')">
      {{ t("playlist.clearConfirmContent") }}
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">
          {{ t("common.cancel") }}
        </SButton>
        <SButton v-if="!inRoom" type="error" variant="secondary" @click="clearAll">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>
  </div>
</template>
