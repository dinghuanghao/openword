#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("OPENWORD_BASE_URL", "http://127.0.0.1:30000").rstrip("/")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
DEFAULT_ACTIONS = ["观察四周并确认附近可互动目标", "向最近的可疑声源移动并保持警戒"]


def request_json(method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    data: Optional[bytes] = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = Request(url=url, data=data, headers=headers, method=method)

    try:
        with urlopen(req, timeout=240) as resp:
            raw = resp.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
    except URLError as exc:
        return {
            "status": "error",
            "error": {"code": "NETWORK_ERROR", "message": str(exc)},
        }

    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": "error", "error": {"code": "INVALID_JSON", "message": raw}}

    if isinstance(parsed, dict):
        return parsed
    return {"status": "error", "error": {"code": "INVALID_PAYLOAD", "message": parsed}}


def pretty_print(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def run_and_check(payload: Dict[str, Any]) -> bool:
    pretty_print(payload)
    is_ok = payload.get("status") == "ok"
    if not is_ok:
        serialized = json.dumps(payload, ensure_ascii=False)
        if "NO_BRIDGE" in serialized:
            print(
                "Hint: open browser http://127.0.0.1:30000 and click 'Connect API Bridge' in Settings.",
                file=sys.stderr,
            )
    return is_ok


def resolve_image_path(image_path: str, image_dir: str) -> str:
    if image_path.strip():
        return image_path.strip()

    if not image_dir.strip():
        return ""

    directory = Path(image_dir).expanduser()
    if not directory.is_dir():
        raise ValueError(f"image_dir does not exist or is not a directory: {image_dir}")

    image_files = sorted(
        [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS],
        key=lambda item: item.name.lower(),
    )
    if not image_files:
        raise ValueError(f"No image files found in image_dir: {image_dir}")
    return str(image_files[0])


def build_create_payload(description: str, style: str, image_path: str, image_dir: str) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"description": description, "style": style}
    resolved_image_path = resolve_image_path(image_path, image_dir)
    if resolved_image_path:
        payload["image_path"] = resolved_image_path
    return payload


def do_full_flow(description: str, style: str, image_path: str, image_dir: str, actions: List[str]) -> int:
    create_payload = build_create_payload(description, style, image_path, image_dir)

    print("[1] create_game")
    create_resp = request_json("POST", "/api/create_game", create_payload)
    if not run_and_check(create_resp):
        return 1

    game_id = create_resp.get("game_id")
    if not isinstance(game_id, str) or not game_id:
        print("Unable to parse game_id from create_game response.", file=sys.stderr)
        return 1

    print(f"[2] load_game {game_id}")
    if not run_and_check(request_json("POST", "/api/load_game", {"game_id": game_id})):
        return 1

    print("[3] get_current_game_state")
    if not run_and_check(request_json("GET", "/api/get_current_game_state")):
        return 1

    chosen_actions = actions if actions else DEFAULT_ACTIONS
    for idx, action in enumerate(chosen_actions, start=1):
        print(f"[4.{idx}] do_action: {action}")
        if not run_and_check(request_json("POST", "/api/do_action", {"description": action})):
            return 1
        print(f"[4.{idx}] get_current_game_state")
        if not run_and_check(request_json("GET", "/api/get_current_game_state")):
            return 1

    return 0


def parse_args() -> Tuple[argparse.ArgumentParser, argparse.Namespace]:
    parser = argparse.ArgumentParser(
        description="OpenWord REST helper (cross-platform Python version with sh-compatible commands)."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("help")
    subparsers.add_parser("health")
    subparsers.add_parser("show_history_games")

    create_parser = subparsers.add_parser("create_game")
    create_parser.add_argument("description")
    create_parser.add_argument("style")
    create_parser.add_argument("--image-path", default="")
    create_parser.add_argument("--image-dir", default="")

    load_parser = subparsers.add_parser("load_game")
    load_parser.add_argument("game_id")

    subparsers.add_parser("get_current_game_state")

    action_parser = subparsers.add_parser("do_action")
    action_parser.add_argument("description")

    full_flow_parser = subparsers.add_parser("full_flow")
    full_flow_parser.add_argument("description")
    full_flow_parser.add_argument("style")
    full_flow_parser.add_argument("--image-path", default="")
    full_flow_parser.add_argument("--image-dir", default="")
    full_flow_parser.add_argument("actions", nargs="*")

    return parser, parser.parse_args()


def main() -> int:
    parser, args = parse_args()
    try:
        if args.command == "help":
            parser.print_help()
            return 0

        if args.command == "health":
            return 0 if run_and_check(request_json("GET", "/health")) else 1

        if args.command == "show_history_games":
            return 0 if run_and_check(request_json("GET", "/api/show_history_games")) else 1

        if args.command == "create_game":
            payload = build_create_payload(args.description, args.style, args.image_path, args.image_dir)
            return 0 if run_and_check(request_json("POST", "/api/create_game", payload)) else 1

        if args.command == "load_game":
            payload = {"game_id": args.game_id}
            return 0 if run_and_check(request_json("POST", "/api/load_game", payload)) else 1

        if args.command == "get_current_game_state":
            return 0 if run_and_check(request_json("GET", "/api/get_current_game_state")) else 1

        if args.command == "do_action":
            payload = {"description": args.description}
            return 0 if run_and_check(request_json("POST", "/api/do_action", payload)) else 1

        if args.command == "full_flow":
            return do_full_flow(args.description, args.style, args.image_path, args.image_dir, args.actions)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Unknown command: {args.command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
