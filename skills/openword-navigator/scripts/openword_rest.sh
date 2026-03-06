#!/usr/bin/env bash
set -euo pipefail

# OpenWord REST helper that works with curl only (no Python required).
# BASE_URL can be overridden, default is local runtime proxy.
BASE_URL="${OPENWORD_BASE_URL:-http://127.0.0.1:30000}"

usage() {
  cat <<'EOF'
Usage:
  openword_rest.sh health
  openword_rest.sh show_history_games
  openword_rest.sh create_game "<description>" "<style>" [--image-path "<image_path>"] [--image-dir "<image_dir>"]
  openword_rest.sh load_game "<game_id>"
  openword_rest.sh get_current_game_state
  openword_rest.sh do_action "<description>"
  openword_rest.sh full_flow "<description>" "<style>" [--image-path "<image_path>"] [--image-dir "<image_dir>"] ["<action1>" "<action2>" ...]

Examples:
  ./skills/openword/scripts/openword_rest.sh health
  ./skills/openword/scripts/openword_rest.sh create_game "我想玩老滚5：参考《上古卷轴5》的北境奇幻冒险，从边境小镇开始" "3D Pixel Art"
  ./skills/openword/scripts/openword_rest.sh create_game "我想玩老滚5：参考《上古卷轴5》的北境奇幻冒险，从边境小镇开始" "3D Pixel Art" --image-dir "/absolute/path/to/reference-images"
  ./skills/openword/scripts/openword_rest.sh do_action "观察四周并确认附近可互动目标"
EOF
}

ensure_deps() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required but not found." >&2
    exit 1
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

pretty() {
  local payload="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$payload" | jq .
  else
    printf '%s\n' "$payload"
  fi
}

has_ok_status() {
  printf '%s' "$1" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'
}

hint_for_common_errors() {
  local payload="$1"
  if printf '%s' "$payload" | grep -Eq '"NO_BRIDGE"'; then
    echo "Hint: open browser http://127.0.0.1:30000 and click 'Connect API Bridge' in Settings." >&2
  fi
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"

  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$url" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -X "$method" "$url" \
      -H "Accept: application/json"
  fi
}

run_and_check() {
  local resp="$1"
  pretty "$resp"
  if ! has_ok_status "$resp"; then
    hint_for_common_errors "$resp"
    return 1
  fi
}

extract_game_id() {
  printf '%s' "$1" \
    | sed -n 's/.*"game_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1
}

pick_first_image_from_dir() {
  local image_dir="$1"
  if [[ ! -d "$image_dir" ]]; then
    echo "image_dir does not exist or is not a directory: $image_dir" >&2
    return 1
  fi

  local had_nullglob=0
  local had_nocaseglob=0
  if shopt -q nullglob; then
    had_nullglob=1
  fi
  if shopt -q nocaseglob; then
    had_nocaseglob=1
  fi

  shopt -s nullglob nocaseglob
  local image_files=(
    "$image_dir"/*.png
    "$image_dir"/*.jpg
    "$image_dir"/*.jpeg
    "$image_dir"/*.webp
    "$image_dir"/*.bmp
    "$image_dir"/*.gif
  )

  if [[ $had_nullglob -eq 0 ]]; then
    shopt -u nullglob
  fi
  if [[ $had_nocaseglob -eq 0 ]]; then
    shopt -u nocaseglob
  fi

  if [[ ${#image_files[@]} -eq 0 ]]; then
    echo "No image files found in image_dir: $image_dir" >&2
    return 1
  fi

  printf '%s' "${image_files[0]}"
}

resolve_image_path() {
  local image_path="${1:-}"
  local image_dir="${2:-}"

  if [[ -n "$image_path" ]]; then
    printf '%s' "$image_path"
    return 0
  fi

  if [[ -z "$image_dir" ]]; then
    printf '%s' ""
    return 0
  fi

  pick_first_image_from_dir "$image_dir"
}

main() {
  ensure_deps
  local cmd="${1:-}"
  if [[ -z "$cmd" ]]; then
    usage
    exit 1
  fi
  shift

  case "$cmd" in
    help|-h|--help)
      usage
      ;;
    health)
      run_and_check "$(request GET /health)"
      ;;
    show_history_games)
      run_and_check "$(request GET /api/show_history_games)"
      ;;
    create_game)
      local description="${1:-}"
      local style="${2:-}"
      if [[ -z "$description" || -z "$style" ]]; then
        echo "create_game requires <description> <style>." >&2
        exit 1
      fi
      shift 2
      local image_path=""
      local image_dir=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --image-path)
            if [[ $# -lt 2 ]]; then
              echo "--image-path requires a value." >&2
              exit 1
            fi
            image_path="$2"
            shift 2
            ;;
          --image-dir)
            if [[ $# -lt 2 ]]; then
              echo "--image-dir requires a value." >&2
              exit 1
            fi
            image_dir="$2"
            shift 2
            ;;
          *)
            echo "Unknown create_game argument: $1" >&2
            exit 1
            ;;
        esac
      done

      local resolved_image_path payload
      resolved_image_path="$(resolve_image_path "$image_path" "$image_dir")"
      payload="{\"description\":\"$(json_escape "$description")\",\"style\":\"$(json_escape "$style")\""
      if [[ -n "$resolved_image_path" ]]; then
        payload="${payload},\"image_path\":\"$(json_escape "$resolved_image_path")\""
      fi
      payload="${payload}}"
      run_and_check "$(request POST /api/create_game "$payload")"
      ;;
    load_game)
      local game_id="${1:-}"
      if [[ -z "$game_id" ]]; then
        echo "load_game requires <game_id>." >&2
        exit 1
      fi
      local payload
      payload="{\"game_id\":\"$(json_escape "$game_id")\"}"
      run_and_check "$(request POST /api/load_game "$payload")"
      ;;
    get_current_game_state)
      run_and_check "$(request GET /api/get_current_game_state)"
      ;;
    do_action)
      local action="${1:-}"
      if [[ -z "$action" ]]; then
        echo "do_action requires <description>." >&2
        exit 1
      fi
      local payload
      payload="{\"description\":\"$(json_escape "$action")\"}"
      run_and_check "$(request POST /api/do_action "$payload")"
      ;;
    full_flow)
      local description="${1:-}"
      local style="${2:-}"
      if [[ -z "$description" || -z "$style" ]]; then
        echo "full_flow requires <description> <style> [--image-path <image_path>] [--image-dir <image_dir>] [actions...]." >&2
        exit 1
      fi
      shift 2

      local image_path=""
      local image_dir=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --image-path)
            if [[ $# -lt 2 ]]; then
              echo "--image-path requires a value." >&2
              exit 1
            fi
            image_path="$2"
            shift 2
            ;;
          --image-dir)
            if [[ $# -lt 2 ]]; then
              echo "--image-dir requires a value." >&2
              exit 1
            fi
            image_dir="$2"
            shift 2
            ;;
          --)
            shift
            break
            ;;
          *)
            break
            ;;
        esac
      done

      local actions=("$@")
      if [[ ${#actions[@]} -eq 0 ]]; then
        actions=("观察四周并确认附近可互动目标" "向最近的可疑声源移动并保持警戒")
      fi

      echo "[1] create_game"
      local resolved_image_path create_payload create_resp game_id
      resolved_image_path="$(resolve_image_path "$image_path" "$image_dir")"
      create_payload="{\"description\":\"$(json_escape "$description")\",\"style\":\"$(json_escape "$style")\""
      if [[ -n "$resolved_image_path" ]]; then
        create_payload="${create_payload},\"image_path\":\"$(json_escape "$resolved_image_path")\""
      fi
      create_payload="${create_payload}}"
      create_resp="$(request POST /api/create_game "$create_payload")"
      run_and_check "$create_resp"
      game_id="$(extract_game_id "$create_resp")"
      if [[ -z "$game_id" ]]; then
        echo "Unable to parse game_id from create_game response." >&2
        exit 1
      fi

      echo "[2] load_game ${game_id}"
      run_and_check "$(request POST /api/load_game "{\"game_id\":\"$(json_escape "$game_id")\"}")"

      echo "[3] get_current_game_state"
      run_and_check "$(request GET /api/get_current_game_state)"

      local i
      for (( i=0; i<${#actions[@]}; i++ )); do
        local next_action="${actions[$i]}"
        echo "[4.$((i+1))] do_action: ${next_action}"
        run_and_check "$(request POST /api/do_action "{\"description\":\"$(json_escape "$next_action")\"}")"
        echo "[4.$((i+1))] get_current_game_state"
        run_and_check "$(request GET /api/get_current_game_state)"
      done
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
