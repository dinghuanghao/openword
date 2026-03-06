export const BRIDGE_REGISTER_TYPE = 'register_controller' as const;
export const BRIDGE_COMMAND_TYPE = 'command' as const;
export const BRIDGE_RESULT_TYPE = 'result' as const;
export const BRIDGE_REJECT_TYPE = 'reject' as const;

export const BRIDGE_WS_PATH = '/ws' as const;
export const DEFAULT_BFF_PORT = 31000;

export type BridgeCommand =
    | 'create_game'
    | 'show_history_games'
    | 'load_game'
    | 'get_current_game_state'
    | 'do_action';

export type BridgeErrorCode =
    | 'NO_BRIDGE'
    | 'BRIDGE_OCCUPIED'
    | 'GAME_NOT_LOADED'
    | 'BUSY'
    | 'IMAGE_NOT_AVAILABLE'
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';

export interface BridgeErrorPayload {
    code: BridgeErrorCode;
    message: string;
}

export interface CreateGamePayload {
    description: string;
    style: string;
    init_image_base64?: string;
}

export interface ShowHistoryGamesPayload {
    // No fields.
}

export interface LoadGamePayload {
    game_id: string;
}

export interface GetCurrentGameStatePayload {
    // No fields.
}

export interface DoActionPayload {
    description: string;
}

export interface CreateGameResult {
    game_id: string;
}

export interface ShowHistoryGamesResult {
    games: Record<string, string>;
}

export interface LoadGameResult {
    // No fields.
}

export interface GetCurrentGameStateResult {
    game_id: string;
    world_view: string;
    narrative: string;
    player_profile: Record<string, unknown>;
    last_scene_image_data_url: string;
}

export interface DoActionResult {
    game_id: string;
    world_view: string;
    narrative: string;
    player_profile: Record<string, unknown>;
    last_scene_image_data_url: string;
}

export interface BridgeCommandPayloadMap {
    create_game: CreateGamePayload;
    show_history_games: ShowHistoryGamesPayload;
    load_game: LoadGamePayload;
    get_current_game_state: GetCurrentGameStatePayload;
    do_action: DoActionPayload;
}

export interface BridgeCommandResultMap {
    create_game: CreateGameResult;
    show_history_games: ShowHistoryGamesResult;
    load_game: LoadGameResult;
    get_current_game_state: GetCurrentGameStateResult;
    do_action: DoActionResult;
}

export interface RegisterControllerMessage {
    type: typeof BRIDGE_REGISTER_TYPE;
    client: 'openword-web';
}

export interface RejectMessage {
    type: typeof BRIDGE_REJECT_TYPE;
    reason: 'controller_exists' | 'invalid_message';
}

export interface BridgeCommandMessage<T extends BridgeCommand = BridgeCommand> {
    type: typeof BRIDGE_COMMAND_TYPE;
    request_id: string;
    command: T;
    payload: BridgeCommandPayloadMap[T];
}

export interface BridgeResultMessage<T extends BridgeCommand = BridgeCommand> {
    type: typeof BRIDGE_RESULT_TYPE;
    request_id: string;
    ok: boolean;
    data?: BridgeCommandResultMap[T];
    error?: BridgeErrorPayload;
}

export type ClientToServerBridgeMessage = RegisterControllerMessage | BridgeResultMessage;
export type ServerToClientBridgeMessage = RejectMessage | BridgeCommandMessage;

export const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const isBridgeCommand = (value: unknown): value is BridgeCommand => {
    return (
        value === 'create_game'
        || value === 'show_history_games'
        || value === 'load_game'
        || value === 'get_current_game_state'
        || value === 'do_action'
    );
};
