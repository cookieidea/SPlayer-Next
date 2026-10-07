import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSongMatchStart: NeteaseModule = (query, request) => {
  const data: Record<string, unknown> = {
    matchType:
      typeof query.matchType === "string" && query.matchType ? query.matchType : "match_start",
  };
  if (typeof query.userMatchIntention === "string") {
    data.userMatchIntention = query.userMatchIntention;
  }
  return request("/api/listen/together/song/match/start", data, createOption(query, "eapi"));
};

export default listenTogetherSongMatchStart;
