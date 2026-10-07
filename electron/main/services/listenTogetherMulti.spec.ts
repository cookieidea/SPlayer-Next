import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MULTI_HEARTBEAT_MS,
  addMultiSong,
  exitMultiRoom,
  getMultiRoom,
  getMultiSession,
  joinMultiRoom,
  onMultiEnd,
  onMultiError,
  onMultiRoom,
  topMultiSong,
} from "./listenTogetherMulti";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@main/apis/netease", () => ({ callNetease: mocks.call }));

const multiBody = (
  roomId = "R_1",
  playSong: string | null = "123",
  nextSongs: string[] = ["456"],
  extra: Record<string, unknown> = {},
) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      success: true,
      multiLtRoomSnapshot: {
        roomId,
        multiRoomInfoDTO: { roomId, creatorId: 77, chatRoomId: "chat1" },
        multiLtRoomUserAgg: {
          onlineUserInfos: [
            { userId: 77, nickname: "A", avatarUrl: "http://a" },
            { userId: 88, nickname: "B", avatarUrl: "http://b" },
          ],
        },
        roomPlaySongInfo: playSong
          ? {
              playSong: { songId: Number(playSong), songBizId: 5 },
              nextSongs: nextSongs.map((id) => ({ songId: Number(id), songBizId: 0 })),
            }
          : null,
        ...extra,
      },
    },
  },
});

const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(MULTI_HEARTBEAT_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  exitMultiRoom();
  vi.clearAllMocks();
});

describe("多人一起听", () => {
  it("加入时 ack 带上 inviterUid 并推出房间", async () => {
    const seen: unknown[] = [];
    onMultiRoom((room) => seen.push(room));
    mocks.call.mockResolvedValue(multiBody());

    await joinMultiRoom("R_1", "77", "88", "dev-1");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_ack", {
      roomId: "R_1",
      inviterUid: "77",
      deviceId: "dev-1",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      roomId: "R_1",
      creatorId: "77",
      chatRoomId: "chat1",
      playSong: { songId: "123", songBizId: 5 },
      nextSongs: [{ songId: "456", songBizId: 0 }],
    });
    expect(getMultiSession()?.roomId).toBe("R_1");
  });

  it("服务端说加入失败时透出它的文案", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { success: false, failedMessage: "人数已满" } },
    });
    await expect(joinMultiRoom("R_1", "77", "88", "d")).rejects.toThrow("人数已满");
    expect(getMultiSession()).toBeNull();
  });

  it("心跳是拉取：房间当前歌曲由心跳响应决定", async () => {
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456"]));
    await joinMultiRoom("R_1", "77", "88", "d");

    const pushed: unknown[] = [];
    onMultiRoom((room) => pushed.push(room));

    // 对端切歌：心跳响应里换成了另一首
    mocks.call.mockResolvedValue(multiBody("R_1", "999", ["777"]));
    await tick();

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_heartbeat", { roomId: "R_1" });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ playSong: { songId: "999" } });
    expect(getMultiRoom()?.playSong?.songId).toBe("999");
  });

  it("房间队列没变时不重复推送", async () => {
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456"]));
    await joinMultiRoom("R_1", "77", "88", "d");

    const pushed: unknown[] = [];
    onMultiRoom((room) => pushed.push(room));
    await tick();
    await tick();

    expect(pushed).toHaveLength(0);
  });

  it("心跳报 488 时结束会话并停掉定时器", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const reasons: string[] = [];
    onMultiEnd((reason) => reasons.push(reason));
    mocks.call.mockRejectedValue(Object.assign(new Error("房间已失效"), { body: { code: 488 } }));
    await tick();

    expect(reasons).toEqual(["server"]);
    expect(getMultiSession()).toBeNull();
    mocks.call.mockClear();
    await tick();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("加歌走 song/operate 的 ADD", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456", "789"]));

    await addMultiSong("789", 3);

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "789",
      bizId: 3,
      operate: 1,
    });
  });

  it("置顶走 song/operate 的 TOP", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["789"]));

    await topMultiSong("789");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "789",
      bizId: 0,
      operate: 2,
    });
  });

  it("服务端否决操作时透出 failedMsg", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { result: false, failedMsg: "该歌曲不可加入" } },
    });

    await expect(addMultiSong("789")).rejects.toThrow("该歌曲不可加入");
  });

  it("退出走 multi/match/exit 并清空状态", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const reasons: string[] = [];
    onMultiEnd((reason) => reasons.push(reason));
    mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });
    await exitMultiRoom();

    expect(reasons).toEqual(["left"]);
    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_exit", { roomId: "R_1" });
    expect(getMultiSession()).toBeNull();
    expect(getMultiRoom()).toBeNull();
  });

  it("心跳失败只报错不结束会话", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const errors: string[] = [];
    onMultiError((message) => errors.push(message));
    mocks.call.mockRejectedValue(new Error("网络错误"));
    await tick();

    expect(errors).toEqual(["网络错误"]);
    expect(getMultiSession()).not.toBeNull();
  });
});
