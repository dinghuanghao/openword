# OpenWord Session Runbook

Use this runbook when a new session starts and the user wants either guided human play or AI REST autoplay.

## 1. Environment Checklist

- Node.js and npm installed.
- OpenWord game process running.
- Browser tab open at `http://127.0.0.1:<PORT>` (default `30000`).
- `GEMINI_API_KEY` load order: shell env -> repo `.env` -> UI modal/Settings.
- `curl` installed (required for `scripts/openword_rest.sh`).

## 2. Download, Install, Start

If repository is not present:

```bash
git clone https://github.com/dinghuanghao/openword.git
cd openword
npm install
npm run dev
```

If repository is already present:

```bash
cd <repo-root>
npm install
npm run dev
```

`PORT` is optional (default `30000`), then open browser at `http://127.0.0.1:<PORT>`.

Prompt user:

`请先确认 GEMINI_API_KEY 按“环境变量 > .env > 网页设置”完成配置，完成后告诉我。`

## 3. Mode Selection

Always ask first:

`这局你想怎么进行：你自己玩（我引导）还是我用 REST API 代玩？`

Mode A: Human plays in browser, agent guides choices.  
Mode B: Agent plays by calling REST API and reports progress.
Creative directive: be bold and imaginative; try seemingly impossible actions when they can produce a truly unique story.

## 4. Human-Guided Flow

1. Ask for world setup idea and style (`Minecraft`, `2D Pixel Art`, `3D Pixel Art`, `Vanilla`, `Claymation`).
2. Help refine opening prompt to include:
- scene location,
- immediate objective,
- tension or conflict.
3. For each turn, output:
- 1-2 line recap,
- 3 candidate actions (safe, balanced, high-risk),
- recommendation + reason.
4. Ask user to choose or rewrite action text, then continue.

## 5. AI REST Flow

### 5.1 Bridge Preconditions

- Keep one active browser tab open.
- In Settings, click `Connect API Bridge`.
- If bridge says occupied, disconnect the other tab first.
- If `PORT != 30000`, export:
  `OPENWORD_BASE_URL="http://127.0.0.1:<PORT>"`.

### 5.2 API Schema

| Method | Path | Body | Success fields |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `status`, `bridge_online` |
| `POST` | `/api/create_game` | `{ "description": string, "style": string, "image_path"?: string }` | `status`, `game_id` |
| `GET` | `/api/show_history_games` | none | `status`, `games` |
| `POST` | `/api/load_game` | `{ "game_id": string }` | `status` |
| `GET` | `/api/get_current_game_state` | none | `status`, `game_id`, `world_view`, `narrative`, `player_profile`, `last_scene_image_path` |
| `POST` | `/api/do_action` | `{ "description": string }` | `status`, `game_id`, `world_view`, `narrative`, `player_profile`, `last_scene_image_path` |

Recommended style keywords for REST `create_game`: `3D Pixel Art` (voxel) and `Claymation` (clay).
Default policy: if the player provides a reference image, include it via `image_path`; otherwise do not send `image_path`.
If `image_path` is used, prefer an absolute path.

### 5.3 Preferred Command Runner (Shell)

Use skill script first:

```bash
./skills/openword-navigator/scripts/openword_rest.sh health
./skills/openword-navigator/scripts/openword_rest.sh show_history_games
./skills/openword-navigator/scripts/openword_rest.sh create_game "我想玩《上古卷轴5》" "3D Pixel Art"
./skills/openword-navigator/scripts/openword_rest.sh do_action " 趁守卫不注意，跳下车去"
./skills/openword-navigator/scripts/openword_rest.sh get_current_game_state
```

With reference image directory (script picks first image file in that directory):

```bash
./skills/openword-navigator/scripts/openword_rest.sh create_game "我想玩《博德之门 3》" "3D Pixel Art" --image-dir "/absolute/path/to/reference-images"
```

### 5.4 Cross-Platform Python Runner

`openword_rest.py` has the same command/argument shape as `openword_rest.sh`:

```bash
python3 ./skills/openword-navigator/scripts/openword_rest.py health
python3 ./skills/openword-navigator/scripts/openword_rest.py create_game "我想玩《宝可梦》" "3D Pixel Art"
python3 ./skills/openword-navigator/scripts/openword_rest.py show_history_games
python3 ./skills/openword-navigator/scripts/openword_rest.py do_action "趁大木博士不注意，把三个球都带走"
python3 ./skills/openword-navigator/scripts/openword_rest.py get_current_game_state
```

### 5.5 Basic Endpoint Checks (Pure curl)

```bash
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"
curl "${BASE_URL}/health"
curl "${BASE_URL}/api/show_history_games"
```

### 5.6 Create and Play (Pure curl)

Create new game:

```bash
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"

curl -X POST "${BASE_URL}/api/create_game" \
  -H "Content-Type: application/json" \
  -d '{"description":"我想玩《刺客信条》","style":"3D Pixel Art"}'
```

Create new game with reference image (when player provides one, use absolute path):

```bash
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"

curl -X POST "${BASE_URL}/api/create_game" \
  -H "Content-Type: application/json" \
  -d '{"description":"我想玩《巫师3》","style":"3D Pixel Art","image_path":"/absolute/path/to/init.png"}'
```

Do one action:

```bash
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"

curl -X POST "${BASE_URL}/api/do_action" \
  -H "Content-Type: application/json" \
  -d '{"description":"趁山贼都睡着了，一把火点燃房屋"}'
```

Get current state:

```bash
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"

curl "${BASE_URL}/api/get_current_game_state"
```

### 5.7 Loop Policy for Autonomous Play

For each turn:

1. Read state (`world_view`, `narrative`, `player_profile`, `last_scene_image_path`).
2. Pick one executable action sentence.
3. Call `do_action`.
4. Retrieve updated state.
5. After every turn, show updated `narrative`, current scene image, and key `player_profile` changes (for example HP loss, new equipment) to the user as a natural short update (do not output rigid prefixes like `last_scene_image_path:`, `narrative:`, `player_profile:`), then continue.

Pause and ask the user before proceeding at major forks:

- irreversible choices,
- high-risk combat/infiltration,
- alliance/betrayal decisions,
- rare rewards or hidden-route opportunities.

## 6. Image and Interaction Rules

`GET /api/get_current_game_state` writes scene image to:

`<repoRoot>/.openword/<game_id>/latest_game_scene.<ext>`

After each turn, when image exists:

- mention what changed in the scene,
- include image in response if client supports local image rendering.
- include key `player_profile` changes, especially HP/status drops and newly obtained equipment.

Example markdown:

```md
![latest scene](/absolute/path/to/.openword/<game_id>/latest_game_scene.jpeg)
```

Do not go silent for long runs. Send one update after every turn.

## 7. Troubleshooting

- `NO_BRIDGE`: API bridge is not connected from browser tab.
- `occupied`: another tab already holds bridge ownership.
- key modal keeps appearing: `GEMINI_API_KEY` is empty/invalid in env and `.env`, and UI key is also missing/invalid.
- REST seems stalled: avoid parallel turn calls; increase timeout (e.g. `--timeout 240`). Some APIs may return `BUSY`; wait patiently and do not overlap retries, and note that blocked services can take several minutes to recover.
