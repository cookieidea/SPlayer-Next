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

  it("多人匹配轮询走多人通道，否则界面收不到房间", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const together = api.together as Record<string, ReturnType<typeof vi.fn>>;
    const multi = api.togetherMulti as Record<string, ReturnType<typeof vi.fn>>;
    // 发起匹配要成功，否则轮询根本不会开始
    multi.startMultiMatch = vi.fn(() => Promise.resolve({ success: true, waiting: true }));
    // 轮询只查"有没有被放进房间"：restore 返回非 null 即视为配到
    multi.cancelMultiMatch = vi.fn(() => Promise.resolve());
    multi.ackMultiMatch = vi.fn(() => Promise.resolve());
    multi.restore = vi.fn(() => Promise.resolve(room("R_M", [])));

    mods.initTogetherMulti();
    await mods.startMultiMatch("123");
    await vi.advanceTimersByTimeAsync(3100);

    // 多人必须走多人通道：together.restore 是双人侧的，
    // 它发的事件在 together:event 上，而多人的监听器只听 togetherMulti:event
    expect(multi.ackMultiMatch).toHaveBeenCalledWith("R_1");
    expect(multi.restore).toHaveBeenCalled();
    expect(together.restore).not.toHaveBeenCalled();
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

  it("有人进房时提示，首次观察不提示", async () => {
    const one = room("room1", []);
    const two: TogetherMultiRoom = {
      ...one,
      members: [
        { userId: "77", nickname: "A", avatarUrl: "" },
        { userId: "99", nickname: "新来的", avatarUrl: "" },
      ],
    };
    queue.setQueue([track("room1")]);
    mods.initTogetherMulti();

    // 首次观察：这些人本来就在房里，不该弹提示
    emit?.(roomEvent(one));
    expect(mocks.toast.info).not.toHaveBeenCalled();

    emit?.(roomEvent(two));

    // 多人房不像双人房那样一次只进一个人，靠比对成员集合才能认出新来的
    expect(mocks.toast.info).toHaveBeenCalledWith(expect.stringContaining("新来的"));
  });

  it("匹配轮询单次失败不终结，连续失败才收尾", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    (api.togetherMulti as Record<string, unknown>).startMatch = vi.fn(() =>
      Promise.resolve({ success: true, roomId: "" }),
    );
    (api.togetherMulti as Record<string, unknown>).cancelMatch = vi.fn(() => Promise.resolve());
    api.together = { restore: vi.fn(() => Promise.resolve(null)) };
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    const store = useTogetherMultiStore();
    mods.initTogetherMulti();
    await mods.startStrangerMatch("88");

    // 第一次失败：网络抖动是常态，不该放弃。
    // 轮询现在只查 restore（不再重复发起匹配），失败要落在它身上
    api.together = { restore: vi.fn(() => Promise.reject(new Error("网络错误"))) };
    await vi.advanceTimersByTimeAsync(3100);
    expect(store.matching).toBe("duo");

    // 连续失败到上限才收尾
    await vi.advanceTimersByTimeAsync(3100 * 6);
    expect(store.matching).toBe("");
    vi.useRealTimers();
  });

  it("失败计数在收尾时复位，不会累积到下一轮", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const multi = api.togetherMulti as Record<string, unknown>;
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    const store = useTogetherMultiStore();
    mods.initTogetherMulti();
    api.together = { restore: vi.fn(() => Promise.resolve(null)) };
    multi.cancelMatch = vi.fn(() => Promise.resolve());

    // 第一轮：发起成功，但每次轮询都失败 —— 失败 4 次（未到上限 5）
    multi.startMatch = vi.fn(() => Promise.resolve({ success: true, roomId: "" }));
    await mods.startStrangerMatch("88");
    multi.startMatch = vi.fn(() => Promise.reject(new Error("网络错误")));
    await vi.advanceTimersByTimeAsync(3100 * 4);
    await mods.cancelStrangerMatch();

    // 第二轮：发起成功，轮询失败 1 次仍应继续等。
    // 计数若没随收尾复位，这里会是 4+1=5 直接触发上限而收尾
    multi.startMatch = vi.fn(() => Promise.resolve({ success: true, roomId: "" }));
    await mods.startStrangerMatch("88");
    multi.startMatch = vi.fn(() => Promise.reject(new Error("网络错误")));
    await vi.advanceTimersByTimeAsync(3100);
    expect(store.matching).toBe("duo");

    // 累计 4 次仍不该收尾
    await vi.advanceTimersByTimeAsync(3100 * 3);
    expect(store.matching).toBe("duo");
    vi.useRealTimers();
  });

  it("置顶带房间里的 songBizId，不是 0", async () => {
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    // 直接写 store：走事件的话会被 generation 校验挡掉（那套校验另有测试覆盖）
    useTogetherMultiStore().room = {
      ...room("room1", []),
      nextSongs: [{ songId: "room2", songBizId: 777, songRcmdUid: "88" }],
    };
    queue.setQueue([track("room1")]);
    mods.initTogetherMulti();

    const calls: Array<[string, number]> = [];
    (window.api.togetherMulti as unknown as Record<string, unknown>).topSong = vi.fn(
      (songId: string, songBizId: number) => {
        calls.push([songId, songBizId]);
        return Promise.resolve({ room: null, message: "", rejected: false });
      },
    );

    await mods.topMultiSong(track("room2"));

    // 实测传 0 会被拒（"歌曲已经不在待播列表中啦"），必须带队列里那一条的 bizId
    expect(calls[0]).toEqual(["room2", 777]);
  });

  it("歌不在房间队列时不发请求", async () => {
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    useTogetherMultiStore().room = { ...room("room1", []), nextSongs: [] };
    queue.setQueue([track("room1")]);
    mods.initTogetherMulti();

    const topSong = vi.fn(() => Promise.resolve({ room: null, message: "", rejected: false }));
    (window.api.togetherMulti as unknown as Record<string, unknown>).topSong = topSong;

    await mods.topMultiSong(track("not-in-room"));

    // 服务端对缺失 bizId 的回应是"只能删除自己添加的歌曲"，会把原因指错方向
    expect(topSong).not.toHaveBeenCalled();
  });

  it("按房间号加入时直接传参数，不绕链接", async () => {
    const join = vi.fn(() => Promise.resolve(room("room1", [])));
    (window.api.togetherMulti as unknown as Record<string, unknown>).join = join;
    queue.setQueue([track("room1")]);
    mods.initTogetherMulti();

    await mods.joinMultiRoomById("R_X", "88", "77");

    // 卡片本身就带这两个值，绕成"拼链接再解析"会让这条路径依赖链接格式
    expect(join).toHaveBeenCalledWith("R_X", "88", "77");
  });

  it("轮询不得重复发起匹配：那会不断重置匹配窗口", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const multi = api.togetherMulti as Record<string, unknown>;
    const startMatch = vi.fn(() => Promise.resolve({ success: true, waiting: true }));
    multi.startMatch = startMatch;
    multi.cancelMatch = vi.fn(() => Promise.resolve());
    multi.restore = vi.fn(() => Promise.resolve(null));
    api.together = { restore: vi.fn(() => Promise.resolve(null)) };

    mods.initTogetherMulti();
    await mods.startStrangerMatch("88");
    const afterStart = startMatch.mock.calls.length;

    // 轮询 5 轮：startMatch 一次都不该再被调用
    await vi.advanceTimersByTimeAsync(3100 * 5);
    expect(startMatch.mock.calls.length).toBe(afterStart);
    vi.useRealTimers();
  });
});
