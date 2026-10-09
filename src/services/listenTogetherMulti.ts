import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { getCurrentTime } from "@/services/playback";
import { useTogetherStore } from "@/stores/together";
import { useUserStore } from "@/stores/user";
import { restoreRoom } from "@/services/listenTogether";
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import * as queue from "@/stores/queue";
import * as player from "@/core/player";
import { skipUnshareableCurrent } from "@/services/togetherPlayback";
import { setTogetherRoomActive } from "@/services/togetherRoomFlag";
import { songsByIds } from "@/apis/song/netease";
import { toast } from "@/composables/useToast";
import { buildMultiInvitation } from "@shared/utils/togetherInvitation";
import { isTogetherShareable } from "@shared/utils/togetherRoom";
import type { TogetherMultiRoom, TogetherRoomSong } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

const MULTI_CONTEXT = { originId: "listen-together-multi", originType: "page" as const };

let unsubscribe: (() => void) | null = null;

// 跟随房间换曲后不能再把这次变化回报给房间，否则两端互相切歌。
// 按「房间设的那首」逐值抑制，而不是开时间窗：时间窗会把用户随后的真实切歌一起吞掉
let roomQueueKey = "";

const resolveTracks = async (ids: string[]): Promise<Track[]> => {
  const known = new Map<string, Track>();
  for (const item of queue.queue.value) {
    if (item.source === "netease" && !known.has(item.id)) known.set(item.id, item);
  }
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    for (const track of await songsByIds(missing)) known.set(track.id, track);
  }
  return ids.map((id) => known.get(id)).filter((track): track is Track => track !== undefined);
};

/**
 * 房间队列取「当前曲 + 待播」这个窗口。
 * 曾经试过 room/songs/list，但它属于 VIP 礼物那套，songIds 实测恒为 null，
 * 而全量历史还会让"播完可重新加入"的判定卡死，因此不再使用。
 * 按签名去重，避免 8 秒心跳反复拉曲目详情
 */
const syncRoomQueue = async (room: TogetherMultiRoom): Promise<void> => {
  const ids = [
    ...(room.playSong ? [room.playSong.songId] : []),
    ...room.nextSongs.map((song) => song.songId),
  ].filter(Boolean);
  const signature = ids.join(",");
  if (signature === roomQueueKey) return;
  roomQueueKey = signature;
  const store = useTogetherMultiStore();
  store.queueTracks = await resolveTracks(ids);
};

/**
 * 跟随房间当前曲目。多人群房的队列只是「当前曲 + 接下来几首」的短窗口，
 * 拿它替换本地歌单会把用户的列表顶掉，所以只处理房间那一首：
 * 本地已有就地播放（不动列表顺序），没有才插进去
 */
/**
 * 与房间进度相差超过这个值就纠正。
 * 参考实现（Music Party / Folium）用 1.5s：3s 会让"快 1.5 秒"这种偏差
 * 永远落在死区内不被纠正
 */
const PROGRESS_AHEAD_TOLERANCE_MS = 1500;

/**
 * 房间当前曲应处的进度：采样值 + 从采样到现在经过的时间。
 *
 * 减去一个网络往返估计：playedTime 是服务端生成响应的时刻，而 sampledAt 是
 * 我们收到的时刻，两者之间差了半程延迟。不扣的话每次对齐都会比房间快一点
 * （实测约 1 秒），而这点偏差又落在容差内不会被纠正
 */
const NETWORK_ONE_WAY_MS = 400;

const roomPositionMs = (room: TogetherMultiRoom): number => {
  if (!room.playProgress && !room.sampledAt) return -1;
  const elapsed = Math.max(0, Date.now() - room.sampledAt - NETWORK_ONE_WAY_MS);
  const target = room.playProgress + elapsed;
  // 别越过曲尾：留 100ms 余量，避免刚好撞上结束事件
  return room.playDuration > 0 ? Math.min(target, Math.max(0, room.playDuration - 100)) : target;
};

/** 已接受过的房间版本：旧版本到达时直接丢弃，避免进度被乱序快照拉回去 */
let acceptedVersion = -1;
/** 上次接受版本所属的房间；换房必须复位门控 */
let acceptedRoomId = "";

const followRoom = async (room: TogetherMultiRoom): Promise<void> => {
  // 版本号只在单个房间内单调。跨房间比较会让新房间（version 从 1 开始）
  // 被上一间房的高版本永久判成"过期"，整个房间都不再跟随——按房间号复位
  if (room.roomId !== acceptedRoomId) {
    acceptedRoomId = room.roomId;
    acceptedVersion = -1;
  }
  // 版本门控：心跳与 IM 事件可能乱序到达，旧快照会把进度与歌曲拽回上一状态
  if (room.playVersion > 0 && room.playVersion < acceptedVersion) return;
  if (room.playVersion > 0) acceptedVersion = room.playVersion;
  // 房间内正播不可共享曲目时先跳走：同步锚是歌曲 id，本地播它没有意义
  await skipUnshareableCurrent();
  const roomSongId = room.playSong?.songId ?? "";
  if (!roomSongId) return;
  // 本轮是否刚加载了新曲：新曲从 0 开始播，进度必须无条件对齐到房间位置，
  // 否则"建房后进度没重置""被邀请进来进度不准"都是这个洞
  let justLoaded = false;
  if (String(useMediaStore().track?.id ?? "") !== roomSongId) {
    const [track] = await resolveTracks([roomSongId]);
    if (!track) return;
    let at = queue.findTrackIndex(roomSongId);
    if (at < 0) at = player.insertToQueue(track, undefined, MULTI_CONTEXT);
    if (at < 0) return;
    // playAtIndex 在同下标时只做恢复播放、不会重新加载，这种情况下强制走一次加载
    if (useStatusStore().playIndex === at) {
      await player.playFrom(queue.queue.value, at, MULTI_CONTEXT, true);
    } else {
      await player.playAtIndex(at);
    }
    justLoaded = true;
  }
  // 进度对齐：服务端在 roomPlaySongInfo 里给了 playedTime（已播毫秒）与
  // 采样时刻，心跳之间按「playedTime + 经过时间」推算真实位置。
  // 只向前对齐：房间进度靠后说明那是旧采样，硬拉回去会把正在播的歌倒带。
  // forceSync 是服务端的强制对齐标记（切歌/顶歌等破坏性操作后置位），
  // 此时双向对齐：服务端知道发生了什么，本地进度必须服从
  const target = roomPositionMs(room);
  if (target < 0) return;
  const drift = target - getCurrentTime();
  // 刚加载新曲：无论差多少都对齐（新曲从头播，不拉齐必然进度不准）。
  // 加载中 seek 会被引擎丢弃（trackLoading 守卫），所以重试到加载完成后再落
  if (justLoaded) {
    for (let i = 0; i < 20; i++) {
      if (!useStatusStore().trackLoading) {
        await player.seek(target);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return;
  }
  if (room.forceSync) {
    if (Math.abs(drift) > 500) await player.seek(target);
    return;
  }
  // 双向对齐：多人房的进度以服务端为准（房内也拦截了本地拖进度），
  // 没有"用户在本地改了进度不该被拉回"这回事。只向前对齐会让本地
  // 一直快着若干秒而不被纠正 —— 参考实现同样用双向（阈值 1.5s）
  if (Math.abs(drift) > PROGRESS_AHEAD_TOLERANCE_MS) await player.seek(target);
};

const handleEvent = (): void => {
  const store = useTogetherMultiStore();
  if (!unsubscribe) {
    unsubscribe = window.api.togetherMulti.onEvent((event) => {
      store.apply(event);
      if (event.type === "room") {
        void followRoom(event.room);
        void syncRoomQueue(event.room);
        notifyNewMembers(event.room);
      }
      if (event.type === "session") setTogetherRoomActive(true);
      if (event.type === "session-end") setTogetherRoomActive(false);
      if (event.type === "session-end" && event.reason !== "left") {
        // 自己退出不用提示；房间被服务端结束（过期/被移出）必须说一声，
        // 否则界面会"莫名其妙"退回普通状态
        toast.warning("一起听房间已结束");
      }
      if (event.type === "error") toast.error(event.message);
    });
  }
};

/** 已见过的成员，用于识别"新加入的人" */
let knownMemberIds: string[] = [];

/**
 * 有人进房时提示一次。
 * 多人房不像双人房那样一次只有一个人，得比对上一次的成员集合才能知道谁是新来的
 */
const notifyNewMembers = (room: TogetherMultiRoom): void => {
  const ids = room.members.map((member) => member.userId).filter(Boolean);
  // 首次观察（刚进房）不提示：那些人在我进来之前就在了
  if (knownMemberIds.length > 0) {
    const arrived = room.members.filter(
      (member) => member.userId && !knownMemberIds.includes(member.userId),
    );
    if (arrived.length > 0) {
      const names = arrived.map((member) => member.nickname || member.userId).join("、");
      toast.info(`一起听：${names} 加入了`);
    }
  }
  knownMemberIds = ids;
};

export const initTogetherMulti = (): void => {
  handleEvent();
  // 与双人房同理：断网后本地会话还在，网络恢复要自己重连一次
  if (!multiOnlineBound) {
    multiOnlineBound = true;
    window.addEventListener("online", () => void reconnectTogetherMulti());
  }
};

let multiOnlineBound = false;

/** 网络恢复后重新接上多人房。房间没了就安静退出，不弹错误 */
const reconnectTogetherMulti = async (): Promise<void> => {
  const store = useTogetherMultiStore();
  if (!store.session) return;
  const userId = String(store.session.userId ?? "");
  if (!userId) return;
  try {
    await window.api.togetherMulti.leave();
    await window.api.togetherMulti.restore(userId);
  } catch {
    void 0;
  }
};

const withBusy = async <T>(run: () => Promise<T>): Promise<T | null> => {
  const store = useTogetherMultiStore();
  store.busy = true;
  try {
    return await run();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    store.busy = false;
  }
};

/** 加入多人房后的共同收尾：清缓存、跟随房间、同步队列 */
const enterMultiRoom = async (room: TogetherMultiRoom): Promise<TogetherMultiRoom> => {
  knownMemberIds = [];
  roomQueueKey = "";
  await followRoom(room);
  await syncRoomQueue(room);
  return room;
};

/**
 * 按房间号加入多人房。
 * 邀请卡片本身就带 roomId 与邀请人，直接用它即可——绕成"拼链接再解析"
 * 会让加入流程依赖链接格式，改一处容易漏另一处
 */
export const joinMultiRoomById = (
  roomId: string,
  inviterUid: string,
  userId: string,
): Promise<unknown> =>
  withBusy(async () => {
    const room = await window.api.togetherMulti.join(roomId, inviterUid, userId);
    return enterMultiRoom(room);
  });

/**
 * 发起匹配前清掉残留房间。
 *
 * 双人侧：有会话就本地脱离（不发 end/v2，那是别人的房也不该由我们结束）
 * 多人侧：有会话就正常退出
 */
const leaveStaleRooms = async (): Promise<void> => {
  try {
    if (useTogetherStore().inRoom) await window.api.together.detach();
  } catch {
    void 0;
  }
  try {
    if (useTogetherMultiStore().inRoom) await window.api.togetherMulti.leave();
  } catch {
    void 0;
  }
};

/** 开始陌生人匹配。匹配成功后轮询 status/get 进房 */
const MATCH_POLL_MS = 3000;

let matchTimer: ReturnType<typeof setInterval> | null = null;

const stopMatchPoll = (): void => {
  if (matchTimer) clearInterval(matchTimer);
  matchTimer = null;
};

/**
 * 匹配结束（成功/超时/出错/取消）。
 *
 * 必须连界面状态一起复位：只停轮询的话界面会一直停在"取消匹配"，
 * 失败或超时后用户找不到重新匹配的入口
 */
const finishMatch = (): void => {
  stopMatchPoll();
  // 计数一并复位：否则下一次匹配会带着上一轮的失败次数，
  // 第一次抖动就直接触发"匹配暂时不可用"
  matchPollCount = 0;
  matchFailureStreak = 0;
  useTogetherMultiStore().matching = "";
};

/**
 * 匹配成功后服务端会把账号直接放进房间，本地要自己发现并跟上。
 * 匹配房（roomType=MATCH_SONG）走的是双人协议——实测它的 heartbeat/sync 都按双人那套，
 * 所以这里用双人的 restore，而不是多人那套
 */
const MATCH_POLL_MAX = 60;
/** 连续失败到这个次数就收尾：单次抖动不放弃，持续失败也没必要继续轮 */
const MATCH_FAILURE_LIMIT = 5;

let matchPollCount = 0;
let matchFailureStreak = 0;

const pollMatch = async (userId: string): Promise<void> => {
  try {
    // 匹配窗口最长 60 秒，超时后停止轮询，避免一直占用
    if (++matchPollCount > MATCH_POLL_MAX) {
      finishMatch();
      toast.warning("没有找到合适的听友，请稍后重试");
      return;
    }
    // 用 match/start 查询配对结果：官方就是这个路径——匹配成功时它返回
    // failedType=MULTI_MATCH_ALREADY_IN_ROOM 并带上 existedRoomId。
    // 走 status/get 的话服务端不一定把"刚配对上的房间"算作 inRoom，
    // 实测房间会短暂出现又消失，于是永远发现不了配对结果
    const result = await window.api.togetherMulti.pollMatch();
    if (!result) {
      if (matchPollCount === 1 || matchPollCount === 30) {
        console.info(`[一起听] 匹配中（第 ${matchPollCount} 轮）`);
      }
      return;
    }
    const room = await window.api.together.restore(userId, true);
    // match/start 已给出 roomId，但房间会话要靠 restore 建立；
    // 这一步失败说明服务端还没把账号放进房间，下一轮继续
    if (!room) return;
    // 配对成功后必须回一次 ack 才算真正进房。
    // 少了它服务端会按 ACK 等待超时把账号踢出去——表现就是"匹配到了，过一会自己退出"。
    // ack 请求偶发挂起（实测会卡死整个加入流程），20 秒兜底放行：
    // 界面先进房，ack 的后续由服务端 ACK 超时兜底
    await Promise.race([
      window.api.togetherMulti.ackMatch(room.roomId),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    // 匹配到就必须通知服务端结束匹配，否则账号会一直挂在匹配队列里
    finishMatch();
    toast.success("已找到听友");
    try {
      await window.api.togetherMulti.cancelMatch();
    } catch {
      void 0;
    }
    await restoreRoom(userId, true);
  } catch (error) {
    // 网络抖动是常态，单次失败不该终结匹配；但连续失败说明服务端在持续拒绝，
    // 再轮下去只是白刷请求，这时收尾并告诉用户
    matchFailureStreak += 1;
    console.info("[一起听] 匹配轮询失败", error);
    if (matchFailureStreak >= MATCH_FAILURE_LIMIT) {
      finishMatch();
      toast.warning("匹配暂时不可用，请稍后重试");
    }
  }
};

export const startStrangerMatch = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    finishMatch();
    // 残留会话会让 restore 直接返回旧房（if (session) return room），
    // 匹配成功后根本进不了新房——表现为"匹配到了但进不去"
    await leaveStaleRooms();
    useTogetherMultiStore().matching = "duo";
    const result = await window.api.togetherMulti.startMatch();
    toast.info("正在为你寻找听友…");
    // 计数复位统一交给 finishMatch：两处都写会让"是否复位"无法被测试锁定
    stopMatchPoll();
    matchTimer = setInterval(() => void pollMatch(userId), MATCH_POLL_MS);
    return result;
  }).then((value) => {
    // 请求失败时 withBusy 返回 null：不能把界面留在"匹配中"
    if (value === null) finishMatch();
    return value;
  });

/**
 * 多人匹配。30 秒窗口，匹配成功后服务端把账号放进房间；
 * 本地轮询 status/get（双人接口能看出是否已进房）来发现结果
 */
export const startMultiMatch = (songId: string): Promise<unknown> =>
  withBusy(async () => {
    finishMatch();
    // 同上：残留房间会让多人侧的 restore 返回旧房，匹配成功也进不去
    await leaveStaleRooms();
    useTogetherMultiStore().matching = "multi";
    const result = await window.api.togetherMulti.startMultiMatch(songId);
    toast.info("正在为你寻找听友…");
    // 同上：计数复位只在 finishMatch 里做
    stopMatchPoll();
    matchTimer = setInterval(() => void pollMultiMatch(), MATCH_POLL_MS);
    return result;
  }).then((value) => {
    if (value === null) finishMatch();
    return value;
  });

export const cancelMultiMatch = (): Promise<void> =>
  withBusy(async () => {
    finishMatch();
    await window.api.togetherMulti.cancelMultiMatch();
  }).then(() => undefined);

const pollMultiMatch = async (): Promise<void> => {
  try {
    if (++matchPollCount > MATCH_POLL_MAX) {
      finishMatch();
      toast.warning("没有找到合适的听友，请稍后重试");
      return;
    }
    // 必须走多人的通道：together.restore 是双人侧的，它发的 session 事件在
    // together:event 上，而多人的监听器只听 togetherMulti:event——
    // 用双人通道检测的话，匹配成功也不会更新 multiStore.room，界面不切视图
    const userId = String(useUserStore().profile?.userId ?? "");
    if (!userId) return;
    // 同双人：只看自己有没有被放进房间，绝不在轮询里再调 startMultiMatch
    const room = await window.api.togetherMulti.restore(userId);
    if (!room) {
      // 还没配到：只记日志，不打扰用户，也不终结匹配
      if (matchPollCount === 1 || matchPollCount === 30) {
        console.info(`[一起听] 多人匹配中（第 ${matchPollCount} 轮）`);
      }
      return;
    }
    // 必须回 ack 才算真正进房（MULTI_MATCH_WAIT_ACK_TIMEOUT 就是这条等待的超时）。
    // 多人要用多人自己的 ack 端点，双人那条加入不了多人房。
    // 同双人侧：ack 请求偶发挂起会卡死加入流程，20 秒兜底放行
    await Promise.race([
      window.api.togetherMulti.ackMultiMatch(room.roomId),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    finishMatch();
    toast.success("已找到听友");
    try {
      await window.api.togetherMulti.cancelMultiMatch();
    } catch {
      void 0;
    }
    // 会话刚由上面那次 restore 建立，这里只补跟随动作。
    // 不能再调 restoreTogetherMulti：它会再查一次，主进程那边 session 已存在，
    // enterMultiRoom 会先 stop("left") 发一条 session-end，界面白闪一下
    roomQueueKey = "";
    await followRoom(room);
    await syncRoomQueue(room);
  } catch (error) {
    // 与双人一致：网络抖动是常态；连续失败才收尾
    matchFailureStreak += 1;
    console.info("[一起听] 多人匹配轮询失败", error);
    if (matchFailureStreak >= MATCH_FAILURE_LIMIT) {
      finishMatch();
      toast.warning("匹配暂时不可用，请稍后重试");
    }
  }
};

export const cancelStrangerMatch = (): Promise<void> =>
  withBusy(async () => {
    finishMatch();
    await window.api.togetherMulti.cancelMatch();
  }).then(() => undefined);

/**
 * 本曲播完时立刻拉一次心跳：房间的下一首由服务端决定，
 * 不主动拉就要等 8 秒周期，中间是一段静音
 */
const refreshTogetherMulti = async (): Promise<void> => {
  if (!useTogetherMultiStore().inRoom) return;
  try {
    await window.api.togetherMulti.refresh();
  } catch {
    void 0;
  }
};

/**
 * 播完后重试的间隔与次数。
 *
 * 实测：服务端在真实曲终后 ~3 秒才推进队列（它按自己的 playedTime 判定），
 * 若本地进度略快，窗口起点会早于服务端推进时刻。窗口必须宽到覆盖
 * 「本地提前量 + 服务端判定延迟 + 一次网络往返」，5.6 秒会错过；
 * 取 18 秒（24 × 750ms）在体感上仍属于"立刻接上"
 */
const ADVANCE_INTERVAL_MS = 750;
const ADVANCE_RETRIES = 24;

/**
 * 播完一首后等房间的下一首。
 *
 * 心跳周期 8 秒，干等就是一段静音；这里短间隔主动拉几次，服务端一换曲就能立刻跟上。
 * 返回 true 表示房间已经推进（或已不在房内），false 表示重试完仍是同一首
 */
export const waitForRoomAdvance = async (): Promise<boolean> => {
  const store = useTogetherMultiStore();
  const before = store.room?.playSong?.songId ?? "";
  for (let i = 0; i < ADVANCE_RETRIES; i += 1) {
    // 先立刻拉一次再判断：播完就问，服务端已换曲的话这一下就能接上，没有空等
    await refreshTogetherMulti();
    if (!store.inRoom) return true;
    const now = store.room?.playSong?.songId ?? "";
    if (now && now !== before) return true;
    // 还没换就稍等再问
    await new Promise((resolve) => setTimeout(resolve, ADVANCE_INTERVAL_MS));
  }
  return false;
};

/** 账号对陌生人的可见性：开着才会被陌生人匹配到 */
export const getStrangerVisible = (): Promise<boolean> =>
  window.api.togetherMulti.getStrangerVisible().catch(() => false);

/** 写失败返回 false，让调用方把开关拨回去——这是账号级设置，显示与服务端不符最误导 */
export const setStrangerVisible = (visible: boolean): Promise<boolean> =>
  withBusy(async () => {
    await window.api.togetherMulti.setStrangerVisible(visible);
    toast.success(visible ? "已允许陌生人加入" : "已关闭陌生人加入");
    return true;
  }).then((value) => value === true);

/**
 * 创建多人房。接口只接受一个"起播歌"，队列不会被带进去
 * （实测 nextSongIds / playlistIds 都被忽略），因此建完房再把当前队列逐首加进去
 */
/**
 * 房间操作的结果提示。
 * 无消息且未被拒说明请求可能压根没发出去（会话已失效），此时不提示，
 * 免得弹出与事实相反的文案
 */
const reportOperate = (message: string, rejected: boolean, rejectFallback: string): void => {
  if (rejected) toast.warning(message || rejectFallback);
  else if (message) toast.success(message);
};

export const createMultiRoom = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const current = useStatusStore().currentTrack;
    if (!current) throw new Error("请先播放一首歌再创建多人房");
    // 云盘与本地音乐做不了房间的起播曲，对方放不出来
    if (!isTogetherShareable(current)) {
      throw new Error("当前是本地或云盘音乐，请先播放一首在线歌曲再创建多人房");
    }
    const songId = String(current.id);
    const room = await window.api.togetherMulti.createRoom(songId, userId);
    roomQueueKey = "";
    await followRoom(room);
    // 房间才是权威进度。创建请求要一个来回，这段时间本地已经播了出去，
    // 不按房间位置重新对齐，两端从一开始就差着这半个来回（实测约两秒）
    const target = roomPositionMs(room);
    if (target >= 0) await player.seek(target);
    // 建房后必须起播：多人一起听里播放态由房间决定，停在暂停态等同于"房间没声音"
    if (!useStatusStore().isPlaying) await player.play();
    await syncRoomQueue(room);
    return room;
  });

/** 多人房站内邀请好友 */
export const inviteMultiFriends = (uids: readonly string[]): Promise<boolean> =>
  withBusy(async () => {
    if (uids.length === 0) return false;
    try {
      await window.api.togetherMulti.inviteFriends([...uids]);
      toast.success(`已邀请 ${uids.length} 位好友`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }).then((value) => value === true);

export const leaveTogetherMulti = (): Promise<void> =>
  withBusy(async () => {
    roomQueueKey = "";
    knownMemberIds = [];
    await window.api.togetherMulti.leave();
  }).then(() => undefined);

export const restoreTogetherMulti = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const room = await window.api.togetherMulti.restore(userId);
    if (room) {
      roomQueueKey = "";
      await followRoom(room);
      await syncRoomQueue(room);
    }
    return room;
  });

export const addMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    // 单一入口处拦掉对方放不了的曲子：本地文件与云盘歌曲都不该进房间
    if (!isTogetherShareable(track)) {
      toast.warning("本地音乐和云盘歌曲对方拿不到，无法加入房间");
      return;
    }
    const { message, rejected } = await window.api.togetherMulti.addSong(track.id, 0);
    reportOperate(message, rejected, "这首歌暂时加不进房间");
  }).then(() => undefined);

/** 投票切歌：人数够时服务端直接切走，不够时记一票 */
export const voteSkipMultiSong = (): Promise<void> =>
  withBusy(async () => {
    const room = useTogetherMultiStore().room;
    const song = room?.playSong;
    if (!song) {
      toast.warning("房间里还没有歌曲");
      return;
    }
    // 投票可能是「直接切走」也可能是「记了一票」，必须把服务端文案透出来，
    // 否则用户点了 ⏭ 毫无反馈，不知道这一票有没有生效
    const { message, rejected } = await window.api.togetherMulti.voteSkip(
      song.songId,
      song.songBizId,
    );
    // 被拒时用警告色：用户需要知道"这一票没生效"以及为什么
    if (rejected) toast.warning(message || "投票切歌失败");
    else if (message) toast.info(message);
  }).then(() => undefined);

/** 在房间队列里按 songId 找那一条：置顶与删除都需要它的 songBizId */
const findRoomSong = (songId: string): TogetherRoomSong | undefined => {
  const room = useTogetherMultiStore().room;
  const songs = [...(room?.playSong ? [room.playSong] : []), ...(room?.nextSongs ?? [])];
  return songs.find((item) => item.songId === songId);
};

export const removeMultiSong = (songId: string): Promise<void> =>
  withBusy(async () => {
    // 删除要带房间里的 songBizId：实测它是服务端定位歌曲的凭据，
    // 曲目菜单只拿得到 songId，所以在这里从房间歌曲里查
    const song = findRoomSong(songId);
    // 查不到就不能发请求：服务端在 bizId 缺失时回的是"只能删除自己添加的歌曲"，
    // 而歌明明是用户自己加的——那句文案会把原因指错方向
    if (!song) {
      toast.warning("这首歌已不在房间队列里");
      return;
    }
    const { message, rejected } = await window.api.togetherMulti.removeSong(songId, song.songBizId);
    reportOperate(message, rejected, "这首歌删不掉");
  }).then(() => undefined);

export const topMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    // 置顶同样要房间里的 songBizId：实测传 0 会被服务端拒（它靠这个定位队列里的那一条）
    const song = findRoomSong(track.id);
    if (!song) {
      toast.warning("这首歌已不在房间队列里");
      return;
    }
    const { message, rejected } = await window.api.togetherMulti.topSong(
      song.songId,
      song.songBizId,
    );
    reportOperate(message, rejected, "置顶失败");
  }).then(() => undefined);

export const shareMultiInvitation = (roomId: string, inviterUid: string): string =>
  buildMultiInvitation(roomId, inviterUid);
