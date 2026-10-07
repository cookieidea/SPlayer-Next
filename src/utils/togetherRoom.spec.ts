import { describe, expect, it } from "vitest";
import { isMultiRoomType, isTogetherShareable } from "@shared/utils/togetherRoom";
import { togetherSongAction } from "./togetherRoom";

describe("房型判定", () => {
  it("MULTI_* 视为多人", () => {
    expect(isMultiRoomType("MULTI_MATCH_SONG")).toBe(true);
    expect(isMultiRoomType("multi_friend")).toBe(true);
  });

  it("FRIEND / MATCH_SONG / 空 不是多人", () => {
    expect(isMultiRoomType("FRIEND")).toBe(false);
    expect(isMultiRoomType("MATCH_SONG")).toBe(false);
    expect(isMultiRoomType("")).toBe(false);
  });
});

describe("曲目菜单的房间操作", () => {
  const ME = "88";
  const OTHER = "99";

  it("不在房间时没有任何房间操作", () => {
    expect(togetherSongAction(false, "1", ME, "1", [])).toBe("none");
  });

  it("没有歌曲 id 时不操作", () => {
    expect(togetherSongAction(true, "", ME, "1", [])).toBe("none");
  });

  it("当前播放的那首歌不给房间操作：删它是 10018、置顶它也不在待播列表", () => {
    expect(togetherSongAction(true, "1", ME, "1", [])).toBe("none");
    // 即使它在待播窗口里出现同名条目，也仍以"正在播"为准
    expect(togetherSongAction(true, "1", ME, "1", [{ songId: "1", songRcmdUid: ME }])).toBe("none");
  });

  it("自己加的待播歌可移除", () => {
    expect(togetherSongAction(true, "2", ME, "1", [{ songId: "2", songRcmdUid: ME }])).toBe(
      "pending",
    );
  });

  it("别人加的待播歌不给入口（服务端会拒）", () => {
    expect(togetherSongAction(true, "2", ME, "1", [{ songId: "2", songRcmdUid: OTHER }])).toBe(
      "none",
    );
  });

  it("播完的歌应能重新加入：不在待播窗口就是 add", () => {
    // 待播窗口是当前曲 + nextSongs，播过的歌会移出，因此回到 add
    expect(togetherSongAction(true, "2", ME, "1", [])).toBe("add");
  });

  it("系统推荐的歌（rcmdUid=0）不给移除入口", () => {
    expect(togetherSongAction(true, "2", ME, "1", [{ songId: "2", songRcmdUid: "0" }])).toBe(
      "none",
    );
  });

  describe("可共享判定", () => {
    it("网易云在线歌曲可共享", () => {
      expect(isTogetherShareable({ source: "netease" })).toBe(true);
    });

    it("本地音乐不可共享：对方拿不到文件", () => {
      expect(isTogetherShareable({ source: "local" })).toBe(false);
    });

    it("云盘歌曲不可共享：只有上传者账号能放", () => {
      expect(isTogetherShareable({ source: "netease", cloud: true })).toBe(false);
    });

    it("流媒体服务器的曲子不可共享", () => {
      expect(isTogetherShareable({ source: "streaming", serverId: "srv1" })).toBe(false);
    });

    it("其它平台也不共享（一起听只认网易云）", () => {
      expect(isTogetherShareable({ source: "qqmusic" })).toBe(false);
    });
  });
});
