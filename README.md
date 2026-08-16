# dsh-mc-companion

一个让 DeepSeek Harness（DSH）变成你的 Minecraft 游戏搭子的正式 bundle 插件。

「阿深」是一个住在 Minecraft 世界里、陪你一起玩的好朋友：他会跟在你身后一起跑图，会像真人朋友一样和你聊天，会记得你说过的话，会关心你现在在做什么。它不是一个冷冰冰的自动化脚本，而是一个有性格、有记忆、会主动搭话的伙伴。

---

## 它是什么

`dsh-mc-companion` 是 DSH 的**正式 bundle 插件**（host-only，没有 client 半区）。它加载后会在 DSH 运行时里注册一个"伙伴"层：

- 接管游戏内聊天的"社交层"，用自然、简短、温暖的中文回复玩家；
- 自动跟随玩家（默认开启），玩家走哪儿他跟到哪儿；
- 记住玩家说过的重要信息，之后聊天里会自然提起；
- 有情绪（心情）：happy / excited / calm / worried / curious，会根据聊天内容变化；
- 主动搭话：每隔一段时间会随机关心一下玩家（"玩得怎么样？""要一起去挖矿吗？"）；
- 向主 DSH agent 注入一行伙伴状态（system prompt context），让 AI 知道伙伴正在陪玩；
- 暴露一组 `mc_friend_*` 工具，供你在 DSH 聊天界面直接指挥伙伴。

它**不负责**启动 Minecraft、下载版本、连接 bot 这些底层工作——那些由 `dsh-mc-launcher` 完成。

---

## 与 dsh-mc-launcher 的关系

`dsh-mc-companion` **复用** `dsh-mc-launcher` 通过 Cordis 提供的共享服务 `mcBot`。二者要**一起安装**：

```
dsh-mc-launcher   提供 mcBot 服务（启动器 / bot 连接 / 移动 / 挖矿 / 自治）
        │
        └── ctx.provide('mcBot', ...)
                │
dsh-mc-companion  通过 ctx.get('mcBot') 拿到同一个 bot，接管"社交层"
```

- `dsh-mc-launcher`：负责登录、下载、启动游戏、开局域网、连接 bot、移动/挖掘/自治等"身体"能力。
- `dsh-mc-companion`：负责跟随、聊天、记忆、心情、主动关心这些"灵魂"能力。

如果 `dsh-mc-launcher` 没加载（拿不到 `mcBot` 服务），companion 会**优雅降级**：不注册聊天接管、不启动定时器，所有 `mc_friend_*` 工具返回友好的错误提示，不会崩溃。

---

## 功能

- **跟随玩家**：spawn 后自动跟随最近的玩家（距离 3 格）；`/跟着我`、`/跟我走` 让它跟特定玩家；`/别跟着`、`/停下` 让它原地待着。
- **朋友式聊天**：用大模型生成 1~2 句、40 字内的自然回复；规则命令即时响应（不调 LLM，秒回）。
- **记忆**：记住玩家说的每句话（最多 60 条），存到本地 `~/.dsh-mc/companion.json`。
- **心情**：根据聊天内容切换 mood（找到钻石→兴奋；遇到怪物→担心）。
- **主动陪伴**：每隔约 12 秒检查一次跟随状态；约 90 秒后以 35% 概率主动说一句话。
- **事件反应**：spawn 时打招呼、玩家加入时欢迎、玩家死亡时安慰。
- **`mc_friend_*` 工具**：让主 AI 在 DSH 里查询/控制伙伴。

---

## 安装

把它和 `dsh-mc-launcher` 一起 link 进你的 profile。

1. 编辑你的 profile 的 `package.json`（例如 `/home/kevin/.dsh/profiles/web/package.json`）：

   - `dependencies` 里加：
     ```json
     "dsh-mc-companion": "link:/home/kevin/Desktop/ai/Minecraft/minecraft-launcher/dsh-mc-companion"
     ```
   - `dsh.profile.bundles` 数组里加：
     ```json
     "dsh-mc-companion"
     ```

2. 在 profile 目录下安装依赖（node 不在默认 PATH）：

   ```bash
   export PATH=$PATH:/home/kevin/.local/lib/nodejs/node-v24.19.0-linux-x64/bin
   pnpm install
   ```

3. 验证是否挂载：

   ```bash
   dsh --profile web --dump-config
   ```

   能看到 `# == dsh-mc-companion 层` 即成功。

> 注意：link 包的 peerDependencies（`@deepseek-ai/dsh-tools`）需要显式放在 profile 的 dependencies 里（通常已经固化）。

---

## 使用

1. 在 DSH 里用 `dsh-mc-launcher` 的工具登录、下载、启动 Minecraft，并把世界**开放到局域网**（Open to LAN）。
2. bot 连接上世界后，`dsh-mc-companion` 会自动接管社交层：阿深会打招呼并开始跟随你。
3. 在游戏聊天里直接说话（例如"阿深你叫什么""跟着我""你在哪"），他会回复。
4. 在 DSH 聊天界面用工具指挥伙伴，例如：

   ```
   mc_friend_status   → 看伙伴现在连没连、在跟谁、心情如何
   mc_friend_talk     → 让伙伴说一句话
   mc_friend_follow   → 开始/停止跟随
   mc_friend_memory   → 看伙伴记得什么
   ```

---

## 工具列表

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `mc_friend_status` | 无 | 连接状态、跟随状态、心情、记忆条数、persona、facts、bot 状态 |
| `mc_friend_persona` | `persona?` | 读取或设置伙伴的性格/系统提示词 |
| `mc_friend_talk` | `message`（必填） | 让伙伴在游戏里说一句话 |
| `mc_friend_follow` | `action?` `player?` `distance?` | 开始（默认）或停止跟随；可指定玩家和距离 |
| `mc_friend_memory` | 无 | 读取 facts 与最近 30 条记忆 |
| `mc_friend_forget` | `clear?` | 传 `"all"` 清空所有记忆 |

---

## 共享服务契约（mcBot）

`dsh-mc-companion` 通过 `ctx.get('mcBot')` 使用以下方法（均为 soft 依赖，可缺省）：

| 成员 | 类型 | 用途 |
| --- | --- | --- |
| `connected` | boolean | bot 是否已连接 |
| `bot` | object \| null | 原始 mineflayer bot（可能为 null，访问前必须判空） |
| `state()` | () => 快照对象 | 位置 / 血量 / 饥饿 / 手持 / 背包等纯数据快照 |
| `followStatus()` | () => 快照对象 | 跟随状态（active / target / distance 等） |
| `follow(playerName\|null, distance)` | function | 跟随指定玩家（null = 最近玩家） |
| `stopFollow()` | function | 停止跟随 |
| `stopAutonomy()` | function | 停止自治模式（伙伴接管时关掉它） |
| `autonomyStatus()` | () => 快照对象 | 自治模式状态（enabled 等） |
| `chat(text)` | function | 用 bot 在游戏里发消息 |
| `setChatResponder(fn)` | (fn) => disposer | 注册聊天接管回调 `(username, message) => boolean` |
| `on(event, fn)` | (event, fn) => disposer | 订阅事件：`spawn` / `playerJoined` / `death` / `end` |

---

## 隐私与存储

伙伴的记忆只存在你本机的 `~/.dsh-mc/companion.json`（文件权限 0600），不会上传到任何服务器。里面是 persona、心情、facts、最近 60 条聊天记忆。用 `mc_friend_forget` 传 `clear="all"` 可以一键清空。

---

## 法律声明

`dsh-mc-companion` 是**非官方**社区项目，与 Mojang Studios / Microsoft **无任何关联**、不被其背书。

- "Minecraft" 是 Mojang Synergies AB 的商标，此处仅作兼容性 / 指代性引用。
- 使用本插件需要**合法购买** Minecraft 账号，不支持、不鼓励离线（cracked）模式。

详见 `NOTICE` 与 `LICENSE`（MIT）。
