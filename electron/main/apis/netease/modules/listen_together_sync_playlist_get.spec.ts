import { describe, expect, it, vi } from "vitest";
import listenTogetherSyncPlaylistGet from "./listen_together_sync_playlist_get";

/**
 * 拉取只需要 roomId。
 *
 * 曾误以为必须附带 playlistParam（当时它返回 data={}），实测证明那是
 * "房间还没上报过队列"所致：只要队列已落地，只传 roomId 同样拿到完整快照。
 * 两份公开实现（qplayer / YesPlayMusic）也都只传 roomId
 */
describe("一起听歌单拉取", () => {
  it("只传 roomId", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherSyncPlaylistGet({ roomId: "R1" }, request as never);

    expect(request).toHaveBeenCalledTimes(1);
    const [path, payload] = request.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/api/listen/together/sync/playlist/get");
    expect(payload).toEqual({ roomId: "R1" });
  });
});
