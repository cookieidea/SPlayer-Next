import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onTrackEndedAutoClose: vi.fn(() => false),
  onTrackEndedStats: vi.fn(),
  isTogetherActive: vi.fn(() => false),
  waitForRoomAdvance: vi.fn(() => Promise.resolve(true)),
  countTogetherAction: vi.fn(),
  nextTrack: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
  play: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/autoClose", () => ({ onTrackEnded: mocks.onTrackEndedAutoClose }));
vi.mock("@/core/player/stats", () => ({ onTrackEnded: mocks.onTrackEndedStats }));
vi.mock("@/services/listenTogether", () => ({ isTogetherActive: mocks.isTogetherActive }));
vi.mock("@/services/listenTogetherMulti", () => ({
  waitForRoomAdvance: mocks.waitForRoomAdvance,
}));
vi.mock("@/services/togetherCounter", () => ({ countTogetherAction: mocks.countTogetherAction }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/composables/useToast", () => ({
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const passthrough = () => Promise.resolve();
vi.mock("@/core/player/index", () => ({
  nextTrack: mocks.nextTrack,
  seek: mocks.seek,
  play: mocks.play,
  pause: passthrough,
  playNow: passthrough,
  prevTrack: passthrough,
  insertManyToQueue: vi.fn(() => 0),
  invalidatePlaybackOperation: vi.fn(),
  isSeeking: vi.fn(() => false),
  isSmartTransitionActive: vi.fn(() => false),
  hasReachedSeekTarget: vi.fn(() => false),
  markSeek: vi.fn(),
  recoverFromSourceFailure: passthrough,
  refreshDevices: passthrough,
  setRepeatMode: vi.fn(),
  setShuffleMode: vi.fn(),
  trySmartTransition: vi.fn(() => Promise.resolve(false)),
  applySavedVolumeForActiveDevice: vi.fn(),
  getActiveDeviceId: vi.fn(() => ""),
}));

import type { PlayerEvent } from "@shared/types/player";

let mods: typeof import("./events");

describe("播放器事件收尾", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    for (const fn of Object.values(mocks)) fn.mockClear();
    mocks.onTrackEndedAutoClose.mockReturnValue(false);
    mocks.isTogetherActive.mockReturnValue(false);
    mods = await import("./events");
  });

  /** 播完一曲：ended 事件由主进程推送 */
  const endedEvent = (): PlayerEvent => ({ type: "ended", data: {} }) as PlayerEvent;

  it("一起听时仍要结算播放统计", async () => {
    mocks.isTogetherActive.mockReturnValue(true);

    await mods.handleEvent(endedEvent());

    // 统计与房间无关：跳过会让听歌记录在一整场一起听里全丢
    expect(mocks.onTrackEndedStats).toHaveBeenCalled();
  });

  it("一起听时仍要处理定时关闭的等本曲结束", async () => {
    mocks.isTogetherActive.mockReturnValue(true);
    mocks.onTrackEndedAutoClose.mockReturnValue(true);

    await mods.handleEvent(endedEvent());

    // "播完这首就关"是用户设的闹钟，不该因为进了房间就失灵
    expect(mocks.onTrackEndedAutoClose).toHaveBeenCalled();
  });

  it("一起听时不本地推进下一首", async () => {
    mocks.isTogetherActive.mockReturnValue(true);

    await mods.handleEvent(endedEvent());

    expect(mocks.nextTrack).not.toHaveBeenCalled();
    expect(mocks.waitForRoomAdvance).toHaveBeenCalled();
  });

  it("不在房间时正常推进下一首", async () => {
    await mods.handleEvent(endedEvent());

    expect(mocks.nextTrack).toHaveBeenCalled();
    expect(mocks.waitForRoomAdvance).not.toHaveBeenCalled();
  });
});
