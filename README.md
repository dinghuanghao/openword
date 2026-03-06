🌐 Language：中文 | [English](./docs/README.en.md)

![OpenWord Banner](./images/banner.jpg)

一句话生成一个游戏世界，通过持续对话的方式展开无尽冒险。

[如何使用](#如何使用) · [如何游玩](#如何游玩) · [API DOC](#rest-api) · [技术交流群](#技术交流群)

## 特色功能
![Function Banner](./images/function.jpg)
- 通过 Multi-Agents 支持了剧情演绎，画面渲染，数值系统（装备，技能，百分比数值），AutoPlay 等功能。
- 支持 OpenClaw，Cursor 等本地 Agent 通过 API 接入游戏。
- 支持剧情的replay，checkpoint，多语言

## 如何使用

### 方法 1：Agent 安装

```bash
# 安装 OpenWord Skill
npx skills add https://github.com/dinghuanghao/openword

# 然后让 Agent 基于 Skill 自动完成安装
```

### 方法 2：手动安装

```bash
# 前置条件：Node.js、npm
git clone https://github.com/dinghuanghao/openword.git
cd openword
npm install

# 启动前先配置 GEMINI_API_KEY（环境变量或 .env）
# 例如：在 .env 中写入 GEMINI_API_KEY=your_key

npm run dev
```

### 方法 3：在线 Demo

访问 [https://agentlive.ai/demos/openword/](https://agentlive.ai/demos/openword/)

提醒：需要你自己输入 API-KEY （也可以加我们的技术交流群，会定期提供一些 Google Credit 用于体验各种新技术～）

### 首次配置

1. 打开 `http://127.0.0.1:30000`。
2. 如果自动/手动流程尚未完成 `GEMINI_API_KEY` 配置，网页打开后请在首次弹窗或设置页继续完成配置。

## 如何游玩

字游世界（OpenWord）支持三类角色在同一局游戏中自由切换与协同：
- **人类玩家**：在浏览器中沉浸式输入行动，推动剧情发展。
- **内置 AI（Auto Player）**：单击右上角的机器人图标，开启后由 AI 可接管游戏，自动思考并接管下一步行动。按 `ESC` 可退出机器人模式。
- **外部 Agent（如 OpenClaw、Cursor 等）**：通过 REST API 读取游戏状态并执行操作，与人类共享同一运行态。

## REST API

### 简介

外部 Agent 的最小接入条件：

- 前端页面在线：前端页面是游戏的运行时，API 负责把请求转发到前端页面
- 开关 BFF WS 链接：
  - 目前 REST API 先到 BFF 再通过 WS 到前端，BFF 只能和第一个 TAB 建立链接（否则无法判断转发目标）
  - 设置页点击 `Connect API Bridge` 可开关 WS 链接（若要和其他 TAB 建立链接，要先关闭已建立的链接，或直接关闭网页）
- API 默认地址：`http://127.0.0.1:30000`

推荐 workflow：

1. `create_game` 创建新局
2. `load_game`（可选）加载已有存档
3. `do_action` 推进回合
4. `get_current_game_state` 获取最新 `world_view` / `narrative` / `player_profile` / `last_scene_image_path`
5. `show_history_games` 查询历史游戏列表

### Schema

| Method | Path | Body | 返回核心字段 |
| --- | --- | --- | --- |
| `POST` | `/api/create_game` | `{ "description": string, "style": string, "image_path"?: string }` | `status`, `game_id` |
| `GET` | `/api/show_history_games` | - | `status`, `games` |
| `POST` | `/api/load_game` | `{ "game_id": string }` | `status` |
| `GET` | `/api/get_current_game_state` | - | `status`, `game_id`, `world_view`, `narrative`, `player_profile`, `last_scene_image_path` |
| `POST` | `/api/do_action` | `{ "description": string }` | `status`, `game_id`, `world_view`, `narrative`, `player_profile`, `last_scene_image_path` |

`create_game.image_path` 支持绝对路径；若传相对路径，会按仓库根目录解析。

`GET /api/get_current_game_state` 会把最新场景图写入：

`<repoRoot>/.openword/<game_id>/latest_game_scene.<ext>`

当未连接 Bridge 时，接口会返回 `NO_BRIDGE`。

### 示例

部分 API 会有十来秒的等待时间，具体取决于网速和世界复杂度。

```bash
# 1) 创建游戏
curl -X POST http://127.0.0.1:30000/api/create_game \
  -H "Content-Type: application/json" \
  -d '{"description":"我要玩上古卷轴 5","style":"Minecraft"}'

# 1.1) 创建游戏（可选：指定本地参考图路径）
curl -X POST http://127.0.0.1:30000/api/create_game \
  -H "Content-Type: application/json" \
  -d '{"description":" 我要玩博德之门 3","style":"Minecraft","image_path":"./images/init.png"}'

# 2) 推进一回合
curl -X POST http://127.0.0.1:30000/api/do_action \
  -H "Content-Type: application/json" \
  -d '{"description":" 趁守卫不注意，点燃马车"}'

# 3) 获取当前状态
curl http://127.0.0.1:30000/api/get_current_game_state
```


## 注意事项

- 默认会自动尝试连接 Bridge；同一时刻仅一个 tab 可占用连接，通常第一个连接成功的 tab 可用。
- 支持多语种切换：`zh-CN` / `en-US`。
- 数据默认保存在浏览器内置存储（优先 IndexedDB，降级 localStorage）。
- 支持单局存档 `import` / `export`（JSON）。
- 支持批量存档包 `批量导入` / `批量导出`（JSON，按 `game_id` 覆盖）。
- 端口说明：统一访问地址为 `http://127.0.0.1:30000`（开发模式下也是该端口，Vite 会将 `/api`、`/health`、`/ws` 代理到内部 BFF）；内部 BFF 默认端口为 `31000`。

## 技术交流群

![技术交流群二维码](./images/wechat.jpg)
