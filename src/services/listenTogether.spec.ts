import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playFrom: vi.fn(() => Promise.resolve()),
  play: vi.fn(() => Promise.resolve()),
  pause: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
  nextTrack: vi.fn(() => Promise.resolve()),
  songsByIds: vi.fn<(ids: Array<string | number>) => Promise<unknown[]>>(() => Promise.resolve([])),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/core/player", () => ({
  playFrom: mocks.playFrom,
  play: mocks.play,
  pause: mocks.pause,
  seek: mocks.seek,
  nextTrack: mocks.nextTrack,
  playAtIndex: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/apis/song/netease", () => ({ songsByIds: mocks.songsByIds }));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));

import type { TogetherSyncEvent } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

import type { PlaybackContext } from "@shared/types/player";
import type * as ServiceModule from "./listenTogether";

let useTogetherStore: typeof import("@/stores/together").useTogetherStore;
let useStatusStore: typeof import("@/stores/status").useStatusStore;
let queue: {
  setQueue: (items: readonly Track[], context?: PlaybackContext) => void;
  queue: { value: Track[] };
};
let mods: typeof ServiceModule;

const track = (id: string): Track =>
  ({ id, source: "netease", title: id, artists: [], duration: 1000 }) as Track;

let emit: ((event: TogetherSyncEvent) => void) | null = null;

const sessionEvent = (roomId = "R1"): TogetherSyncEvent => ({
  type: "session",
  session: { roomId, userId: "7" },
  room: { roomId, creatorId: "7", members: [{ userId: "7", nickname: "我", avatarUrl: "" }] },
});

describe("一起听渲染端服务", () => {
  beforeEach(async () => {
    vi.resetModules();
    setActivePinia(createPinia());
    emit = null;
    ({ useTogetherStore } = await import("@/stores/together"));
    ({ useStatusStore } = await import("@/stores/status"));
    queue = await import("@/stores/queue");
    mods = await import("./listenTogether");

    for (const fn of Object.values(mocks)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
    (
      window as unknown as {
        api: { together: Record<string, unknown> };
      }
    ).api = {
      together: {
        getSession: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({})),
        join: vi.fn(() => Promise.resolve({})),
        restore: vi.fn(() => Promise.resolve(null)),
        leave: vi.fn(() => Promise.resolve()),
        sync: vi.fn(),
        invite: vi.fn(() => Promise.resolve()),
        friends: vi.fn(() => Promise.resolve([])),
        pendingInvites: vi.fn(() => Promise.resolve([])),
        resolveLink: vi.fn((url: string) => Promise.resolve(url)),
        onEvent: vi.fn((cb: (event: TogetherSyncEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        }),
      },
    };
    mods.setTogetherCounting(false);
  });

  it("未进房间时不上报状态", () => {
    mods.initTogether();
    const sync = (window as unknown as { api: { together: { sync: ReturnType<typeof vi.fn> } } })
      .api.together.sync;
    expect(sync).not.toHaveBeenCalled();
    expect(mods.isTogetherActive()).toBe(false);
  });

  it("会话建立后进入房间状态", () => {
    mods.initTogether();
    emit?.(sessionEvent());
    expect(mods.isTogetherActive()).toBe(true);
  });

  it("会话结束后退出房间状态并提示", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({ type: "session-end", reason: "server" });
    expect(mods.isTogetherActive()).toBe(false);
    await vi.waitFor(() => expect(mocks.toast.warning).toHaveBeenCalled());
  });

  it("自己退出房间不弹已结束提示", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.toast.warning.mockClear();
    emit?.({ type: "session-end", reason: "left" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("推进权轮到自己时播放下一首", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "advance",
      session: { roomId: "R1", userId: "7" },
    });
    await vi.waitFor(() => expect(mocks.nextTrack).toHaveBeenCalled());
  });

  it("纯队列变化时保留当前曲目，不打断播放", async () => {
    const status = useStatusStore();
    const initial: Track[] = [track("100"), track("200")];
    queue.setQueue(initial);
    status.playIndex = 0;
    mocks.songsByIds.mockResolvedValue([track("100"), track("200"), track("300")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7" },
      command: null,
      songIds: ["100", "200", "300"],
      playMode: "",
      initial: false,
    });

    await vi.waitFor(() => expect(queue.queue.value).toHaveLength(3));
    expect(mocks.playFrom).not.toHaveBeenCalled();
  });

  it("对端切歌时按目标曲目播放", async () => {
    const initial: Track[] = [track("100"), track("200")];
    queue.setQueue(initial);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7" },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "",
        targetSongId: "200",
        progressMs: 0,
        playing: true,
        serverSeq: 2,
      },
      songIds: [],
      playMode: "",
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const args = mocks.playFrom.mock.calls[0];
    expect((args as unknown[])[1]).toBe(1);
  });

  it("纯进度命令不改变播放态", async () => {
    const only: Track[] = [track("100")];
    queue.setQueue(only);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.play.mockClear();
    mocks.pause.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7" },
      command: {
        userId: "8",
        type: "PROGRESS",
        formerSongId: "100",
        targetSongId: "100",
        progressMs: 5000,
        playing: false,
        serverSeq: 3,
      },
      songIds: [],
      playMode: "",
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("对端切换随机模式时本机跟随", async () => {
    const status = useStatusStore();
    status.shuffleMode = "off";
    status.repeatMode = "list";

    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7" },
      command: null,
      songIds: [],
      playMode: "RANDOM",
      initial: false,
    });

    await vi.waitFor(() => expect(status.shuffleMode).toBe("on"));
    expect(status.repeatMode).toBe("list");
  });

  it("对端切换单曲循环时本机跟随", async () => {
    const status = useStatusStore();
    status.repeatMode = "list";
    status.shuffleMode = "on";

    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7" },
      command: null,
      songIds: [],
      playMode: "SINGLE_LOOP",
      initial: false,
    });

    await vi.waitFor(() => expect(status.repeatMode).toBe("one"));
    expect(status.shuffleMode).toBe("off");
  });

  it("接受邀请后进入房间", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    const store = useTogetherStore();
    const ok = await mods.acceptInvite(
      {
        roomId: "R9",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
      },
      "7",
    );
    expect(ok).toBe(true);
    expect(api.together.join).toHaveBeenCalledWith("R9", "8", "7");
    expect(store.busy).toBe(false);
  });

  it("接受邀请失败时不修改状态", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    api.together.join.mockRejectedValueOnce(new Error("房间已失效或无法加入"));
    const ok = await mods.acceptInvite(
      {
        roomId: "R9",
        inviterId: "8",
        inviterName: "",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
      },
      "7",
    );
    expect(ok).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("邀请好友成功后提示", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    const ok = await mods.inviteFriend({
      userId: "9",
      nickname: "丙",
      avatarUrl: "",
      joined: false,
    });
    expect(ok).toBe(true);
    expect(api.together.invite).toHaveBeenCalledWith("9");
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it("邀请好友失败时提示原因", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    api.together.invite.mockRejectedValueOnce(new Error("不在关注列表"));
    const ok = await mods.inviteFriend({ userId: "9", nickname: "", avatarUrl: "", joined: false });
    expect(ok).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });
});
