import { describe, expect, it } from "vitest";
import { isMultiRoomType } from "@shared/utils/togetherRoom";
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

  describe("曲目菜单的房间操作", () => {
    it("不在房间时没有任何房间操作", () => {
      expect(togetherSongAction(false, "1", ["1"])).toBe("none");
      expect(togetherSongAction(false, "1", [])).toBe("none");
    });

    it("没有歌曲 id 时不操作", () => {
      expect(togetherSongAction(true, "", ["1"])).toBe("none");
    });

    it("已在房间队列 → 置顶/移除；不在 → 只能加入", () => {
      expect(togetherSongAction(true, "1", ["1", "2"])).toBe("top");
      expect(togetherSongAction(true, "3", ["1", "2"])).toBe("add");
      expect(togetherSongAction(true, "1", [])).toBe("add");
    });
  });
});
