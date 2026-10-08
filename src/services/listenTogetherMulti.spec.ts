import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playFrom: vi.fn(() => Promise.resolve()),
  playAtIndex: vi.fn(() => Promise.resolve()),
  songsByIds: vi.fn<(ids: Array<string | number>) => Promise<unknown[]>>(() => Promise.resolve([])),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  seek: vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve()),
  play: vi.fn(() => Promise.resolve()),
  getCurrentTime: vi.fn<() => number>(() => 0),
}));

vi.mock("@/core/player", () => ({
  playFrom: mocks.playFrom,
  playAtIndex: mocks.playAtIndex,
  seek: mocks.seek,
  play: mocks.play,
  // 与真实语义一致：插进队列并返回实际下标（afterIndex 之后）
  insertToQueue: (item: Track, afterIndex?: number) => {
    const at = afterIndex === undefined ? queue.queue.value.length : afterIndex + 1;
    queue.insertToQueue(item, at);
    return at;
  },
}));

const mediaMock = vi.hoisted(() => {
  const state: { track: unknown } = { track: undefined };
  return {
    state,
    useMediaStore: () => ({
      get track() {
        return state.track;
      },
      setTrack: (next: unknown) => {
        state.track = next;
      },
    }),
  };
});

vi.mock("@/stores/media", () => ({ useMediaStore: mediaMock.useMediaStore }));
vi.mock("@/stores/user", () => ({ useUserStore: () => ({ profile: { userId: 88 } }) }));
vi.mock("@/apis/song/netease", () => ({ songsByIds: mocks.songsByIds }));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));
vi.mock("@/services/playback", () => ({ getCurrentTime: mocks.getCurrentTime }));

import type { TogetherMultiEvent, TogetherMultiRoom } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";
import type * as ServiceModule from "./listenTogetherMulti";

let queue: {
  setQueue: (items: readonly Track[]) => void;
  insertToQueue: (item: Track, index: number) => void;
  findTrackIndex: (id: string) => number;
  queue: { value: Track[] };
};
let mods: typeof ServiceModule;

const track = (id: string): Track =>
  ({ id, source: "netease", title: id, artists: [], duration: 1000 }) as Track;

const room = (playSong: string | null, nextSongs: string[]): TogetherMultiRoom => ({
  roomId: "R_1",
  creatorId: "77",
  chatRoomId: "chat1",
  members: [{ userId: "77", nickname: "A", avatarUrl: "" }],
  playSong: playSong ? { songId: playSong, songBizId: 0, songRcmdUid: "" } : null,
  nextSongs: nextSongs.map((id) => ({ songId: id, songBizId: 0, songRcmdUid: "" })),
  playStartTime: 0,
  playDuration: 0,
});

const roomEvent = (value: TogetherMultiRoom): TogetherMultiEvent => ({
  type: "room",
  room: value,
  generation: 1,
});

const loadedIndex = (): number | undefined => {
  const from = mocks.playFrom.mock.calls[0] as unknown as [unknown, number] | undefined;
  if (from) return from[1];
  const at = mocks.playAtIndex.mock.calls[0] as unknown as [number] | undefined;
  if (at) return at[0];
  return undefined;
};

const loadCount = (): number =>
  mocks.playFrom.mock.calls.length + mocks.playAtIndex.mock.calls.length;

let emit: ((event: TogetherMultiEvent) => void) | null = null;

describe("多人一起听渲染端服务", () => {
  beforeEach(async () => {
    vi.resetModules();
    setActivePinia(createPinia());
    emit = null;
    mediaMock.state.track = undefined;
    queue = await import("@/stores/queue");
    mods = await import("./listenTogetherMulti");
    for (const fn of Object.values(mocks)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
    (window as unknown as { api: Record<string, unknown> }).api = {
      together: {
        restore: vi.fn(() => Promise.resolve(null)),
        leave: vi.fn(() => Promise.resolve()),
        sync: vi.fn(),
      },
      togetherMulti: {
        getSession: vi.fn(() => Promise.resolve(null)),
        join: vi.fn(() => Promise.resolve({})),
        restore: vi.fn(() => Promise.resolve(null)),
        leave: vi.fn(() => Promise.resolve()),
        addSong: vi.fn(() => Promise.resolve()),
        topSong: vi.fn(() => Promise.resolve()),
        switchSong: vi.fn(() => Promise.resolve()),
        onEvent: vi.fn((callback: (event: TogetherMultiEvent) => void) => {
          emit = callback;
          return () => {
            emit = null;
          };
        }),
      },
    };
  });

  it("进入房间时把房间当前曲目插进本地队列并播放，不顶掉用户歌单", async () => {
    queue.setQueue([track("mine1"), track("mine2")]);
    mocks.songsByIds.mockResolvedValue([track("room1")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("room1", ["room2"])));

    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    const ids = queue.queue.value.map((item) => item.id);
    expect(ids).toContain("mine1");
    expect(ids).toContain("mine2");
    expect(ids).toContain("room1");
  });

  it("本地已有房间当前曲目时就地播放，不重复插入也不重排", async () => {
    queue.setQueue([track("mine1"), track("room1"), track("mine2")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("room1", [])));

    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    expect(queue.queue.value.map((item) => item.id)).toEqual(["mine1", "room1", "mine2"]);
    expect(loadedIndex()).toBe(1);
  });

  it("本地已经在放房间当前曲目时不重复切歌", async () => {
    mediaMock.state.track = track("room1");
    queue.setQueue([track("room1")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("room1", [])));
    await Promise.resolve();

    expect(loadCount()).toBe(0);
  });

  it("房间切歌后跟随到新曲目", async () => {
    queue.setQueue([track("mine1")]);
    mediaMock.state.track = track("room1");
    mocks.songsByIds.mockResolvedValue([track("room2")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("room2", [])));

    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    expect(queue.queue.value.map((item) => item.id)).toContain("mine1");
    expect(queue.queue.value.map((item) => item.id)).toContain("room2");
  });

  it("房间队列只用于展示，且内容没变时不重复拉取曲目详情", async () => {
    mocks.songsByIds.mockResolvedValue([track("room1"), track("room2")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("room1", ["room2"])));
    const store = (await import("@/stores/togetherMulti")).useTogetherMultiStore();
    await vi.waitFor(() => expect(store.queueTracks.map((t) => t.id)).toEqual(["room1", "room2"]));
    // 房间队列是展示用的，绝不能进本地播放队列
    expect(queue.queue.value.length).toBeLessThan(2);

    const calls = mocks.songsByIds.mock.calls.length;
    emit?.(roomEvent(room("room1", ["room2"])));
    await Promise.resolve();
    expect(mocks.songsByIds.mock.calls.length).toBe(calls);
  });

  it("跟随房间换曲只动本地播放器，不产生任何服务端调用", async () => {
    queue.setQueue([track("mine1")]);
    mocks.songsByIds.mockResolvedValue([track("room1")]);
    mods.initTogetherMulti();

    const api = window.api.togetherMulti as unknown as Record<string, ReturnType<typeof vi.fn>>;
    for (const fn of Object.values(api)) fn.mockClear?.();

    emit?.(roomEvent(room("room1", [])));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));

    // 多人房只通过房间面板的置顶改队列；本地换曲上报会与房间互相拉扯
    for (const [name, fn] of Object.entries(api)) {
      expect(fn.mock.calls.length, `${name} 不该被调用`).toBe(0);
    }
  });

  it("同一首歌但进度差得多时对齐房间进度", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    // 房间在 3 秒前起播，本地才播了 0.5 秒
    const roomWithProgress: TogetherMultiRoom = {
      ...room("room1", []),
      playStartTime: Date.now() - 30000,
      playDuration: 200000,
    };
    mocks.getCurrentTime.mockReturnValue(500);
    mods.initTogetherMulti();

    emit?.(roomEvent(roomWithProgress));

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    // 目标是毫秒（约 30 秒），不是秒
    const target = mocks.seek.mock.calls[0]?.[0] as number;
    expect(target).toBeGreaterThan(29000);
    expect(target).toBeLessThan(31000);
  });

  it("进度接近时不做 seek，避免反复抖动", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    mocks.getCurrentTime.mockReturnValue(29800);
    mods.initTogetherMulti();

    emit?.(roomEvent({ ...room("room1", []), playStartTime: Date.now() - 30000 }));
    await Promise.resolve();

    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("匹配超时后界面状态复位，不会卡在取消匹配", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    (api.togetherMulti as Record<string, unknown>).startMatch = vi.fn(() =>
      Promise.resolve({ success: true }),
    );
    (api.togetherMulti as Record<string, unknown>).cancelMatch = vi.fn(() => Promise.resolve());
    api.together = { getSession: vi.fn(() => Promise.resolve(null)) };

    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    mods.initTogetherMulti();

    await mods.startStrangerMatch("88");
    expect(useTogetherMultiStore().matching).toBe("duo");

    // 轮询上限 60 次 × 3 秒；超时后必须复位，否则界面只剩"取消匹配"、无法重试
    await vi.advanceTimersByTimeAsync(3000 * 62);

    expect(useTogetherMultiStore().matching).toBe("");
    vi.useRealTimers();
  });

  it("匹配轮询直接问服务端，而不是读主进程内存", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const together = api.together as Record<string, ReturnType<typeof vi.fn>>;
    (api.togetherMulti as Record<string, unknown>).startMatch = vi.fn(() =>
      Promise.resolve({ success: true }),
    );
    (api.togetherMulti as Record<string, unknown>).cancelMatch = vi.fn(() => Promise.resolve());

    mods.initTogetherMulti();
    await mods.startStrangerMatch("88");
    await vi.advanceTimersByTimeAsync(3100);

    // getSession 读的是主进程内存里的会话，只有渲染端调过 restore 才会有值；
    // 轮询它的话，匹配成功也永远发现不了
    expect(together.restore).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
