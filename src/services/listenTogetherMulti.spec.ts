import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playFrom: vi.fn(() => Promise.resolve()),
  playAtIndex: vi.fn(() => Promise.resolve()),
  songsByIds: vi.fn<(ids: Array<string | number>) => Promise<unknown[]>>(() => Promise.resolve([])),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/core/player", () => ({
  playFrom: mocks.playFrom,
  playAtIndex: mocks.playAtIndex,
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
vi.mock("@/apis/song/netease", () => ({ songsByIds: mocks.songsByIds }));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));

import type { TogetherMultiEvent, TogetherMultiRoom } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";
import type * as ServiceModule from "./listenTogetherMulti";

let queue: { setQueue: (items: readonly Track[]) => void; queue: { value: Track[] } };
let mods: typeof ServiceModule;

const track = (id: string): Track =>
  ({ id, source: "netease", title: id, artists: [], duration: 1000 }) as Track;

const room = (playSong: string | null, nextSongs: string[]): TogetherMultiRoom => ({
  roomId: "R_1",
  creatorId: "77",
  chatRoomId: "chat1",
  members: [{ userId: "77", nickname: "A", avatarUrl: "" }],
  playSong: playSong ? { songId: playSong, songBizId: 0 } : null,
  nextSongs: nextSongs.map((id) => ({ songId: id, songBizId: 0 })),
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

  it("进入房间时把房间队列设为本地队列并加载当前曲目", async () => {
    mocks.songsByIds.mockResolvedValue([track("1"), track("2")]);
    mods.initTogetherMulti();

    emit?.(roomEvent(room("1", ["2"])));

    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    expect(queue.queue.value.map((item) => item.id)).toEqual(["1", "2"]);
    // 房间队列以当前曲目打头，落点必为 0
    expect(loadedIndex()).toBe(0);
  });

  it("队列内容没变且本地已在放时不重建队列、不重载", async () => {
    mocks.songsByIds.mockResolvedValue([track("1"), track("2")]);
    mods.initTogetherMulti();
    emit?.(roomEvent(room("1", ["2"])));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    mediaMock.state.track = track("1");

    const entries = queue.queue.value;
    mocks.playFrom.mockClear();
    mocks.playAtIndex.mockClear();
    emit?.(roomEvent(room("1", ["2"])));
    await Promise.resolve();

    expect(queue.queue.value).toBe(entries);
    expect(loadCount()).toBe(0);
  });

  it("队列变了但当前曲目没变时只换队列、不重载正在放的那首", async () => {
    mocks.songsByIds.mockResolvedValue([track("1"), track("2")]);
    mods.initTogetherMulti();
    emit?.(roomEvent(room("1", ["2"])));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    mediaMock.state.track = track("1");

    // 房间加了一首：队列内容变了，但当前曲目仍是 1
    mocks.songsByIds.mockResolvedValue([track("1"), track("2"), track("3")]);
    mocks.playFrom.mockClear();
    mocks.playAtIndex.mockClear();
    emit?.(roomEvent(room("1", ["2", "3"])));
    await vi.waitFor(() => expect(queue.queue.value).toHaveLength(3));

    expect(loadCount()).toBe(0);
  });

  it("房间切歌后跟随到新曲目", async () => {
    mocks.songsByIds.mockResolvedValue([track("1"), track("2")]);
    mods.initTogetherMulti();
    emit?.(roomEvent(room("1", ["2"])));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));
    mediaMock.state.track = track("1");

    mocks.songsByIds.mockResolvedValue([track("2"), track("1")]);
    mocks.playFrom.mockClear();
    mocks.playAtIndex.mockClear();
    emit?.(roomEvent(room("2", ["1"])));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));

    expect(queue.queue.value[0]?.id).toBe("2");
    expect(loadedIndex()).toBe(0);
  });

  it("只有用户自己切歌才回报，跟随房间换曲不回传", () => {
    // 跟随产生的那首不能回报，否则两端互相切歌
    expect(mods.shouldReportLocalSong(true, "1", "1")).toBe(false);
    expect(mods.shouldReportLocalSong(true, "9", "1")).toBe(true);
    // 不在房间 / 没有曲目都不该上报
    expect(mods.shouldReportLocalSong(false, "9", "1")).toBe(false);
    expect(mods.shouldReportLocalSong(true, "", "1")).toBe(false);
  });
});
