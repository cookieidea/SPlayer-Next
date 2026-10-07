/** 房型判定集中在共享层：主进程与渲染端都要用同一套规则 */
export const isMultiRoomType = (roomType: string): boolean =>
  (roomType ?? "").toUpperCase().startsWith("MULTI");
