import { createPinia, setActivePinia } from "pinia";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
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
  playProgress: 0,
  sampledAt: 0,
  playDuration: 0,
  forceSync: false,
  playVersion: 0,
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
        refresh: vi.fn(() => Promise.resolve()),
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

  // —— 房间内云盘/本地音乐自动跳过 ——
  it("双人房正播云盘歌时自动切到下一首可共享的", async () => {
    const cloud = { ...track("cloud1"), source: "netease", cloud: true } as Track;
    const online = track("200");
    queue.setQueue([cloud, online]);
    // 直接写 playIndex 指向 cloud：currentTrack 由它推导出云盘曲目
    const { useStatusStore } = await import("@/stores/status");
    const statusStore = useStatusStore();
    statusStore.playIndex = 0;
    mediaMock.state.track = cloud;
    mocks.getCurrentTime.mockReturnValue(0);
    mods.initTogetherMulti();

    // 先建立会话（inRoom=true），skipUnshareableCurrent 才会工作
    emit?.({
      type: "session",
      session: { roomId: "room1", userId: "88", generation: 1 },
      room: room("room1", []),
    });
    await Promise.resolve();
    emit?.(roomEvent({ ...room("room1", []), playProgress: 0, sampledAt: Date.now() }));
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    expect(useTogetherMultiStore().inRoom).toBe(true);
    // 直调跳过函数：隔离 followRoom 链路差异
    const tp = await import("@/services/togetherPlayback");
    await tp.skipUnshareableCurrent();
    await vi.waitFor(() => {
      // 应已跳到 online：playFrom 被以包含 200 的列表调用
      expect(mocks.playFrom).toHaveBeenCalled();
    });
    // playFrom 可能被进房跟随先调用过一次：找跳过那一次（目标是 200）
    // playFrom 签名是 (items, startIndex, context, autoPlay)
    const skipCall = mocks.playFrom.mock.calls.some((call: unknown[]) => {
      const items = call[0] as Track[] | undefined;
      const startIndex = call[1] as number | undefined;
      return items?.[Number(startIndex)]?.id === "200";
    });
    expect(skipCall).toBe(true);
  });

  it("多人房落后房间进度时会追上", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    // 房间已播 30 秒，本地才 0.5 秒：应当 seek 到房间位置。
    // 进度由 playedTime（已播毫秒）+ 采样后经过时间推算，服务端确实下发这个字段
    const roomAhead: TogetherMultiRoom = {
      ...room("room1", []),
      playProgress: 30000,
      sampledAt: Date.now(),
      playDuration: 200000,
      forceSync: false,
    };
    mocks.getCurrentTime.mockReturnValue(500);
    mods.initTogetherMulti();

    emit?.(roomEvent(roomAhead));
    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());

    const target = (mocks.seek.mock.calls[0] as unknown[])[0] as number;
    expect(target).toBeGreaterThanOrEqual(30000);
    expect(target).toBeLessThan(31000);
  });

  it("换房间后版本门控必须复位，否则新房间不再跟随", async () => {
    queue.setQueue([track("mine1")]);
    mocks.songsByIds.mockResolvedValue([track("room2")]);
    mods.initTogetherMulti();

    // 上一间房：本地就在播它的曲子，且它已经走到 version=9
    mediaMock.state.track = track("room1");
    emit?.(roomEvent({ ...room("room1", []), playVersion: 9 }));
    await Promise.resolve();

    // 新房（roomId 不同、version 从 1 开始、曲子也不同）：版本号跨房间不可比。
    // 拿旧房的 version=9 当门槛会把这条更新判成过期，新房间永远不跟随
    emit?.(roomEvent({ ...room("room2", []), roomId: "R_2", playVersion: 1 }));
    await vi.waitFor(() => expect(loadCount()).toBeGreaterThan(0));

    expect(queue.queue.value.map((item) => item.id)).toContain("room2");
  });

  it("多人房本地超前时会被拉回（双向对齐，服务端为准）", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    // 本地已播 60 秒，房间才 30 秒：本地超前必须纠正，
    // 否则会一直快着若干秒 —— 房内不允许本地拖进度，没有"用户操作"要保护，
    // 乱序的旧快照由版本门控挡掉，不靠"只向前"来防倒带
    const roomBehind: TogetherMultiRoom = {
      ...room("room1", []),
      playProgress: 30000,
      sampledAt: Date.now(),
      playDuration: 200000,
      forceSync: false,
    };
    mocks.getCurrentTime.mockReturnValue(60000);
    mods.initTogetherMulti();

    emit?.(roomEvent(roomBehind));
    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());

    const target = (mocks.seek.mock.calls[0] as unknown[])[0] as number;
    expect(target).toBeGreaterThanOrEqual(30000);
    expect(target).toBeLessThan(31000);
  });

  it("进度接近时不做 seek，避免反复抖动", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    mocks.getCurrentTime.mockReturnValue(29800);
    mods.initTogetherMulti();

    emit?.(roomEvent({ ...room("room1", []), playProgress: 30000, sampledAt: Date.now() }));
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

  it("加入多人房不把自己的歌带进房间", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const multi = api.togetherMulti as Record<string, unknown>;
    const addSong = vi.fn(() => Promise.resolve({ room: null, message: "", rejected: false }));
    multi.addSong = addSong;
    multi.join = vi.fn(() => Promise.resolve(room("R_1", [])));
    api.together = { restore: vi.fn(() => Promise.resolve(null)) };

    mods.initTogetherMulti();
    await mods.joinMultiRoomById("R_1", "8", "77");
    await vi.advanceTimersByTimeAsync(1000);

    // 加入只该跟随房间，不该往房间里塞自己的歌
    expect(addSong).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("发起匹配前先退出残留房间，否则匹配成功也进不去", async () => {
    vi.useFakeTimers();
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const detach = vi.fn(() => Promise.resolve());
    api.together = { restore: vi.fn(() => Promise.resolve(null)), detach };
    (api.togetherMulti as Record<string, unknown>).startMatch = vi.fn(() =>
      Promise.resolve({ success: true, waiting: true }),
    );
    (api.togetherMulti as Record<string, unknown>).leave = vi.fn(() => Promise.resolve());

    // 残留的双人房会话：restore 会因 if (session) return room 直接返回旧房
    // inRoom 是 computed，要造残留会话必须直接给 session 赋值
    const { useTogetherStore } = await import("@/stores/together");
    useTogetherStore().session = { roomId: "OLD", userId: "88", generation: 1 };

    mods.initTogetherMulti();
    await mods.startStrangerMatch("88");

    expect(detach).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("匹配进房按加入语义：跟随对方的播放态与进度", async () => {
    // 直接测 restoreRoom：它在 listenTogether 服务里独立导出。
    // 轮询里的 restore 也传 true，所以必须从源头验证，否则测不出差异
    const lt = await import("@/services/listenTogether");
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const calls: unknown[][] = [];
    api.together = {
      restore: vi.fn((...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ roomId: "NEW", userId: "88" });
      }),
    };
    const { useTogetherStore } = await import("@/stores/together");
    useTogetherStore().session = null;

    await lt.restoreRoom("88", true);
    // entering 必须透传：false 会走"重启恢复"，进来停在暂停、进度不跟
    expect(calls[0]).toEqual(["88", true]);
  });

  it("播完等房间推进时会重试，不是只拉一次", async () => {
    vi.useFakeTimers();
    const store = useTogetherMultiStore();
    store.session = { roomId: "R1", userId: "77", generation: 1 };
    store.room = { ...room("old", []), roomId: "R1" };

    const multi = (window as unknown as { api: Record<string, unknown> }).api
      .togetherMulti as Record<string, ReturnType<typeof vi.fn>>;
    let calls = 0;
    multi.refresh = vi.fn(() => {
      calls += 1;
      // 第二次才推进到新曲
      if (calls >= 2) store.room = { ...room("new", []), roomId: "R1" };
      return Promise.resolve();
    });

    const promise = mods.waitForRoomAdvance();
    // 推进定时器的等待，让重试跑起来
    await vi.advanceTimersByTimeAsync(6000);
    const advanced = await promise;

    expect(advanced).toBe(true);
    expect(calls).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it("播完立刻拉：第一次就换曲时不等待", async () => {
    const store = useTogetherMultiStore();
    store.session = { roomId: "R1", userId: "77", generation: 1 };
    store.room = { ...room("old", []), roomId: "R1" };

    const multi = (window as unknown as { api: Record<string, unknown> }).api
      .togetherMulti as Record<string, ReturnType<typeof vi.fn>>;
    // 第一次 refresh 就把曲换了
    multi.refresh = vi.fn(() => {
      store.room = { ...room("new", []), roomId: "R1" };
      return Promise.resolve();
    });

    const started = Date.now();
    const advanced = await mods.waitForRoomAdvance();
    const elapsed = Date.now() - started;

    expect(advanced).toBe(true);
    // 立刻返回，不该先睡一个间隔
    expect(elapsed).toBeLessThan(500);
    expect(multi.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("多人房 forceSync 对齐", () => {
  it("forceSync 时无视容差双向对齐（服务端切歌后的强制同步）", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    // 本地进度反而比房间靠前（服务端刚切歌重置了进度）：
    // 普通路径只向前不倒带，forceSync 必须倒回去
    mocks.getCurrentTime.mockReturnValue(120000);
    mods.initTogetherMulti();

    emit?.(
      roomEvent({
        ...room("room1", []),
        playProgress: 30000,
        sampledAt: Date.now(),
        forceSync: true,
      }),
    );
    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());

    const target = (mocks.seek.mock.calls[0] as unknown[])[0] as number;
    expect(target).toBeGreaterThanOrEqual(30000);
    expect(target).toBeLessThan(31000);
  });

  it("forceSync 且进度接近时不 seek（<500ms 视为无漂移）", async () => {
    queue.setQueue([track("room1")]);
    mediaMock.state.track = track("room1");
    mocks.getCurrentTime.mockReturnValue(30200);
    mods.initTogetherMulti();

    emit?.(
      roomEvent({
        ...room("room1", []),
        playProgress: 30000,
        sampledAt: Date.now(),
        forceSync: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.seek).not.toHaveBeenCalled();
  });
});
