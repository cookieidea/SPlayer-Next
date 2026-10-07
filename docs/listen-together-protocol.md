# 网易云「一起听」协议逆向（来自官方 Android APK 9.6.05）

来源：`NeteaseCloudMusic_Music_official_9.6.05.260923162310_3264.apk`
方法：自写 DEX 解析器（`/tmp/opcodes.py`、`/tmp/allapi.py`、`/tmp/dexscan.py`）提取
「方法引用的字符串常量」，从而还原每个接口的参数名。

标注说明：

- **实测** = 用真实账号打过真实服务端，看到过响应
- **仅字节码** = 参数名来自反编译，未逐个验证
- 带 ✅ 的是本项目已实现

## 一、端点与参数全表

### 双人房

| 端点                       | 参数                                                                   | 状态                                                     |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `room/create`              | `refer`, `extJson`, `robotUid`                                         | ✅ 实测                                                  |
| `room/check`               | `roomId`                                                               | ✅ 实测（返回 `joinable`/`type`/`copywriting`/`status`） |
| `play/invitation/accept`   | `roomId`, `inviterId`, `refer`                                         | ✅                                                       |
| `invitation/reject`        | `roomId`                                                               | ✅ 实测可用                                              |
| `invitation-info/get`      | `invitationVersion`                                                    | 实测 200                                                 |
| `status/get`               | 无参                                                                   | ✅ 实测                                                  |
| `heartbeat`                | `roomId`, `songId`, `playStatus`, `progress`, `playlistVersion`        | ✅ 实测                                                  |
| `play/command/report`      | `roomId`, `commandInfo`                                                | ✅ 实测                                                  |
| `sync/list/command/report` | `roomId`, `playlistParam`, `clientSeq`                                 | ✅ 实测                                                  |
| `sync/playlist/get`        | `roomId`, `playlistParam`, `listenTogetherRandomList`                  | ✅ 实测                                                  |
| `end/v2`                   | `roomId`, `exitType`, `exitReason`, `scene`, `needRecord`, `shareInfo` | ✅ 实测                                                  |
| `end/check`                | `roomId`                                                               | 实测 200，比靠 488 判断更直接                            |
| `sync/notice`              | `roomId`                                                               | 实测会校验房间，非长轮询                                 |
| `invite/message/send`      | `roomId`, `acceptorId`, **`ltType`**                                   | ✅ 实测（多人房返回 488）                                |

> `invite/message/send` 多出一个 `ltType`。本项目只传了 `roomId`/`acceptorId`，
> 未验证 `ltType` 是否决定双人/多人，**这是一个可能被忽略的关键参数**。

### 多人房

| 端点                              | 参数                                                  | 状态                                              |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `multi/room/create`               | `type`(整数, `1` 可用) + `songId`(真实可播)           | ✅ **实测建房成功**                               |
| `multi/invite`                    | `roomId`, `inviteUids`, `groupIds`                    | ✅ 实测 200                                       |
| `multi/match`                     | `songId`, `checkToken`（须传字符串 `"null"`）         | ✅ 实测                                           |
| `multi/match/ack`                 | `roomId`, `agree`, **`checkToken`**, **`inviterUid`** | 未实测                                            |
| `multi/match/cancel`              | 无参                                                  | ✅ 实测                                           |
| `multi/match/exit`                | `roomId`, `exitType`                                  | ✅ 实测：带与不带响应相同（都含结果页 `orpheus`） |
| `multi/match/heartbeat`           | `roomId`                                              | ✅ 实测（房间状态来自响应）                       |
| `multi/match/status/get`          | 无参                                                  | ✅ 实测                                           |
| `multi/match/song/operate`        | `roomId`, `songId`, `bizId`, `operate`                | ✅ **实测 0/2/4/7**                               |
| `multi/special/song/operate`      | 同 `song/operate`                                     | 未实测                                            |
| `multi/match/msg/history`         | `roomId`                                              | 未实测                                            |
| `multi/special/msg/history`       | `roomId`                                              | 未实测                                            |
| `multi/match/msg/translate/retry` | `roomId`, `msgId`                                     | 未实测                                            |
| `multi/start/msg`                 | `roomId`                                              | 实测 200                                          |
| `multi/match`（无子路径）         | `checkToken`, `songId`                                | 见上                                              |

### 陌生人匹配（song/match 族）

| 端点                         | 参数                                                                                  | 状态                      |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `song/match/start`           | `matchType`(`match_start`/`rematch`/`restart`), `userMatchIntention`, `MASKED_REVEAL` | ✅ 实测                   |
| `song/match/ack`             | `roomId`, `agree`                                                                     | 未实测                    |
| `song/match/cancel`          | 无参                                                                                  | ✅ 实测                   |
| `song/match/info/list`       | `roomId`                                                                              | ✅ 实测（用户音乐偏好等） |
| `song/match/read/report`     | `roomId`, `type`                                                                      | 未实测                    |
| `song/match/identity/unlock` | 参数未提取到（日志里有「揭面失败」）                                                  | 未实测                    |

### 房间 / 歌曲

| 端点                       | 参数                             | 状态                              |
| -------------------------- | -------------------------------- | --------------------------------- |
| `room/songs/list`          | `roomId`                         | ⚠️ 实测有时返回 `songIds: null`   |
| `common/liked/song/report` | `roomId`, `songId`, `actionType` | 未实测                            |
| `heart/rcmd/change`        | `roomId`, `status`               | 未实测                            |
| `change-multi/check`       | 仅 `roomId`（方法只引用路径）    | ✅ 实测（房内有移动端成员才通过） |

### 账号与社交

| 端点                                  | 参数                                                            | 状态                                                 |
| ------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `listening/privacy/get`               | 无参                                                            | ✅ 实测                                              |
| `listening/privacy/update`            | `privacyKey`, `value`（另见 `streak_user_switch`）              | ✅ **实测：key 只能是 `listening_entrance`，值 0/1** |
| `listening/invite/remind/today/close` | 无参                                                            | 未实测                                               |
| `user/state/get`                      | `anotherUserId`                                                 | 实测 200                                             |
| `user/state/set`                      | `state`                                                         | 未实测                                               |
| `user/state/config`                   | 无参                                                            | 未实测                                               |
| `user/gps/report`                     | `longitude`, `ssid`, `opened`, `privacy`                        | 未实测                                               |
| `mutual/follows/get`                  | 无参                                                            | 实测 200                                             |
| `mutual/follows/get/v2`               | `roomId`, `songId`                                              | 未实测                                               |
| `distance/get`                        | `roomId`, `otherUserId`                                         | 未实测                                               |
| `privilege/get`                       | `roomId`, `songIds`, `onMusicStart`, `otherUserId`, `playScene` | 实测 400（条件未知）                                 |
| `privilege/change/report`             | 未提取到                                                        | 未实测                                               |
| `notice/popup`                        | `roomId`, `acceptorId`                                          | 未实测                                               |
| `vip/gift/report`                     | `roomId`, `receiver`, `sku`                                     | 未实测                                               |
| `ask/for/vip`                         | `roomId`, `type`                                                | 未实测                                               |
| `device/reconnect/notice`             | `roomId`                                                        | 实测 `{result:false}`                                |
| `restore/reconnect/info`              | 无参                                                            | 实测 `{}`                                            |
| `query/exit/info`                     | 无参                                                            | 实测 `{}`                                            |
| `streak/info` / `streak/checkin`      | 未提取到                                                        | 400                                                  |
| `avatar/pendant/batch/get`            | `userIds`                                                       | 未实测                                               |
| `avatar/pendant/show/get`             | 无参                                                            | 未实测                                               |
| `avatar/pendant/show/set`             | `show`                                                          | 未实测                                               |

### 实时通信与表情

| 端点                 | 参数                                     | 说明                          |
| -------------------- | ---------------------------------------- | ----------------------------- |
| `yunxin/token/get`   | 无参                                     | 网易云信 IM token（推流通道） |
| `agora/token/get`    | 无参                                     | Agora RTC token（语音）       |
| `emoticon/get`       | `scenes`（取值 `FRIEND` / `MATCH_SONG`） | 表情包                        |
| `emoticon/report`    | `roomId`, `emoticonType`                 | 表情上报                      |
| `float/activity/get` | `type`（取值 `FLOAT_ACTIVITY_MOBILE`）   | 浮窗活动                      |

## 二、关键结构（真实响应）

### 多人房快照

```
multiLtRoomSnapshot
├── multiRoomInfoDTO
│   ├── roomId            "32位hex_13位时间戳"
│   ├── creatorId / firstUserId
│   ├── chatRoomId        云信聊天室
│   ├── roomType          MULTI_MATCH_SONG（多人）/ FRIEND（双人）/ MATCH_SONG（双人匹配）
│   ├── roomBizType       1
│   ├── roomStatus / roomClosed / roomCreateTime
│   └── roomEndOrpheus    结果页链接
├── multiLtRoomUserAgg            ← 在 snapshot 顶层，不在 DTO 里
│   ├── onlineNums
│   ├── onlineUserInfos[]        { uid, avatar, nickname }   ← 字段名是 uid/avatar
│   ├── version / currentSongBizId / nextSongBizId / nextText
│   └── playingSongRcmd { uid, avatar, nickname }
├── roomPlaySongInfo
│   ├── playSong   { songId, songBizId, songRcmdUid, rcmdType, songRelationId, alg }
│   ├── nextSongs[]  同上结构
│   ├── startTime / playedTime / songDuration
│   ├── waitSongCount        待播歌曲数（不是票数）
│   └── firstNextSong
└── roomTagList
```

### `song/operate` 枚举（实测，服务端文案逐条印证）

| operate | 含义                   | 服务端文案                                         |
| ------- | ---------------------- | -------------------------------------------------- |
| `0`     | 加歌                   | "找到小伙伴啦，已将你带来的歌曲推荐给大家"         |
| `1`     | 加歌被拒（该歌刚播过） | "你推荐的歌曲刚刚被播放过啦，你可以重新推荐一首歌" |
| `2`     | 顶歌                   | "你顶了一下歌曲 X"                                 |
| `3`     | 点赞                   | "你觉得这首歌很好听！"                             |
| `4`     | 投票切歌               | 够数时直接切："有足够多的人不想听，切歌成功！"     |
| `5`     | 红心                   | "你红心了歌曲 X"                                   |
| `6`     | 收藏                   | "你收藏了歌曲 X"                                   |
| `7`     | 删歌                   | 只能删自己的："抱歉，只能删除自己添加的歌曲哦～"   |
| `8`     | 无副作用               | —                                                  |
| `9+`    | 不支持                 | "暂不支持操作"                                     |

> 参考实现 `MiaoSIKI/YesPlayMusic-listen-together-support` 把加歌标为 `1`，**实际是 `0`**。

### 房型与转换

- `change-multi/check` → `{checkResult, checkFailNotice}`
- 房内有**支持多人的客户端**（移动端）时通过；只有 PC 端时报
  「你的听友版本过低，不支持转化为多人一起听」
- 客户端埋点 `InviteMonitor_had_auto_change_multi` 说明：
  **「第二个人加入」时服务端自动把双人房转成多人房**，客户端只负责发现并跟随

### 可见性开关

```
listening/privacy/update { privacyKey: "listening_entrance", value: 0|1 }
  → get 读回 visibleStatus / entranceStatus
     value=0 → visibleStatus 0, entranceStatus 0（隐藏）
     value=1 → visibleStatus 2, entranceStatus 1（公开）
```

**账号级**设置（不带 roomId 也生效），双人房与多人房共用。

## 三、本项目实现以外的能力（可做的下一步）

1. **表情/互动**：`emoticon/get|report`、`common/liked/song/report`
2. **语音与实时消息**：`yunxin/token/get`、`agora/token/get`（需接 IM/RTC SDK）
3. **距离/地理**：`distance/get`、`user/gps/report`
4. **用户状态**：`user/state/get|set|config`（「听歌状态」图标）
5. **连续打卡**：`streak/info`、`streak/checkin`
6. **房间歌曲完整列表**：`room/songs/list`（实测不可靠，需再验证参数）
7. **头像挂件**：`avatar/pendant/*`
8. **VIP 礼物**：`vip/gift/report`、`ask/for/vip`

## 四、已知不确定项（不要当成结论）

- `multi/match/ack` 的 `checkToken`/`inviterUid` 是否需要、取什么值
- `privilege/get` 的生效条件（实测恒 400）
- `room/songs/list` 为什么有时返回 `songIds: null`
- `song/match/identity/unlock` 的参数
- `common/liked/song/report` 的 `actionType` 值域
- `multi/match/msg/history` / `multi/special/msg/history` 为何 400

已排除的疑问（实测确认）：

- `invite/message/send` 的 `ltType` **不改变**"多人房 488"的结果，它只是类型校验
- `multi/match/song/operate` 的 `checkToken` **可选**，不带也能加歌/删歌
- `multi/special/song/operate` 与普通版**行为一致**，不是另一套语义
- `emoticon/get` 的 `scenes` 要 JSON 数组字符串，不是裸值
