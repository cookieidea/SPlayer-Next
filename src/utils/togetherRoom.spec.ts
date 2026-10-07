import { describe, expect, it } from "vitest";
import { isMultiRoomType } from "@shared/utils/togetherRoom";

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
