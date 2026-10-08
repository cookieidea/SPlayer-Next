import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  voteSkip: vi.fn(() => Promise.resolve()),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/services/listenTogetherMulti", () => ({
  addMultiSong: vi.fn(() => Promise.resolve()),
  voteSkipMultiSong: mocks.voteSkip,
}));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));

import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { useTogetherPlaybackGuard } from "@/composables/useTogetherPlaybackGuard";

const messages = { zh: { player: { together: { localPlayDisabled: "x" } } } };
const i18n = createI18n({ legacy: false, locale: "zh", messages });

/** useI18n 只能在 setup 里调用，所以用一个空组件把 composable 跑起来 */
const mountGuard = () => {
  let guard!: ReturnType<typeof useTogetherPlaybackGuard>;
  const Probe = {
    setup() {
      guard = useTogetherPlaybackGuard();
      return () => null;
    },
  };
  mount(Probe, { global: { plugins: [i18n] } });
  return guard;
};

describe("一起听播放守卫", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.voteSkip.mockClear();
  });

  it("房内上/下一首走投票，不是本地切歌", () => {
    const store = useTogetherMultiStore();
    // inRoom 由 session 决定，不是 room
    store.session = { roomId: "R1", userId: "77", generation: 1 };
    store.room = {
      roomId: "R1",
      creatorId: "77",
      chatRoomId: "c",
      members: [],
      playSong: { songId: "s1", songBizId: 0, songRcmdUid: "" },
      nextSongs: [],
      playStartTime: 0,
      playDuration: 0,
    };
    const guard = mountGuard();

    expect(guard.blockTrackSwitch()).toBe(true);
    expect(mocks.voteSkip).toHaveBeenCalled();
  });

  it("不在房内时上/下一首照常本地切歌", () => {
    const guard = mountGuard();
    expect(guard.blockTrackSwitch()).toBe(false);
    expect(mocks.voteSkip).not.toHaveBeenCalled();
  });

  it("歌曲页的上下曲入口确实接了投票守卫", async () => {
    // 上面两条测的是 guard 自身；这条确保 FullPlayer 真的用了它，
    // 否则改回了 blockLocalPlay 也不会被发现
    const src = readFileSync(
      `${process.cwd()}/src/components/player/FullPlayer/index.vue`,
      "utf-8",
    );
    expect(src).toContain("guard.blockTrackSwitch()");
  });
});
