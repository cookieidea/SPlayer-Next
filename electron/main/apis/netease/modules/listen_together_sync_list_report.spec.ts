import { describe, expect, it, vi } from "vitest";
import listenTogetherSyncListReport from "./listen_together_sync_list_report";

/**
 * displayList/randomList 必须是纯数组。
 *
 * 实测：改成对象形态 { changed, result, rcmdSongIds } 后服务端整条拒收
 * （result=false，队列不落地），表现为"进房后歌单/进度/模式全都不再同步"。
 * 服务端返回时给的是对象形态，但上报必须用数组——两边不对称
 */
describe("一起听队列上报", () => {
  it("displayList 与 randomList 都是纯数组", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherSyncListReport(
      { roomId: "R1", userId: 88, version: 1, songIds: ["1", "2"] },
      request as never,
    );

    const [, payload] = request.mock.calls[0] as unknown as [string, Record<string, string>];
    const playlist = JSON.parse(payload.playlistParam) as Record<string, unknown>;

    expect(playlist.displayList).toEqual(["1", "2"]);
    expect(playlist.randomList).toEqual(["1", "2"]);
    expect(Array.isArray(playlist.displayList)).toBe(true);
    expect(Array.isArray(playlist.randomList)).toBe(true);
  });

  it("随机列表存在时优先用它", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherSyncListReport(
      { roomId: "R1", userId: 88, version: 1, songIds: ["1", "2"], randomSongIds: ["2", "1"] },
      request as never,
    );

    const [, payload] = request.mock.calls[0] as unknown as [string, Record<string, string>];
    const playlist = JSON.parse(payload.playlistParam) as Record<string, unknown>;

    expect(playlist.randomList).toEqual(["2", "1"]);
  });

  it("带上 playMode 让对端能跟随播放模式", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherSyncListReport(
      { roomId: "R1", userId: 88, version: 1, songIds: ["1"], playMode: "RANDOM" },
      request as never,
    );

    const [, payload] = request.mock.calls[0] as unknown as [string, Record<string, string>];
    const playlist = JSON.parse(payload.playlistParam) as Record<string, unknown>;

    expect(playlist.playMode).toBe("RANDOM");
  });
});
