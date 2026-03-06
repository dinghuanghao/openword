import {
    BRIDGE_COMMAND_TYPE,
    BRIDGE_REGISTER_TYPE,
    BRIDGE_RESULT_TYPE,
    BRIDGE_REJECT_TYPE,
    isBridgeCommand,
    isRecord,
    type BridgeCommand,
    type BridgeCommandPayloadMap,
    type BridgeCommandResultMap,
    type BridgeErrorCode,
    type BridgeErrorPayload,
    type ServerToClientBridgeMessage
} from '../../shared/protocol';

export type ApiBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'occupied' | 'error';

export interface ApiBridgeStatusEvent {
    status: ApiBridgeStatus;
    message?: string;
}

export class ApiBridgeClientError extends Error {
    readonly code: BridgeErrorCode;

    constructor(code: BridgeErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

type CommandHandler = (
    command: BridgeCommand,
    payload: BridgeCommandPayloadMap[BridgeCommand]
) => Promise<BridgeCommandResultMap[BridgeCommand]>;

type StatusListener = (event: ApiBridgeStatusEvent) => void;

const toBridgeCommandMessage = (value: unknown): Extract<ServerToClientBridgeMessage, { type: 'command' }> | null => {
    if (!isRecord(value) || value.type !== BRIDGE_COMMAND_TYPE) return null;
    if (typeof value.request_id !== 'string' || !value.request_id) return null;
    if (!isBridgeCommand(value.command)) return null;
    if (!isRecord(value.payload)) return null;

    return {
        type: BRIDGE_COMMAND_TYPE,
        request_id: value.request_id,
        command: value.command,
        payload: value.payload as BridgeCommandPayloadMap[typeof value.command]
    };
};

const toBridgeRejectMessage = (value: unknown): Extract<ServerToClientBridgeMessage, { type: 'reject' }> | null => {
    if (!isRecord(value) || value.type !== BRIDGE_REJECT_TYPE) return null;
    if (value.reason !== 'controller_exists' && value.reason !== 'invalid_message') return null;

    return {
        type: BRIDGE_REJECT_TYPE,
        reason: value.reason
    };
};

const toBridgeErrorPayload = (error: unknown): BridgeErrorPayload => {
    if (error instanceof ApiBridgeClientError) {
        return {
            code: error.code,
            message: error.message
        };
    }

    if (error instanceof Error) {
        const maybeCode = (error as { code?: unknown }).code;
        const code = typeof maybeCode === 'string' ? (maybeCode as BridgeErrorCode) : 'INTERNAL_ERROR';
        return {
            code,
            message: error.message || 'Bridge command failed.'
        };
    }

    return {
        code: 'INTERNAL_ERROR',
        message: 'Bridge command failed.'
    };
};

const parseMessage = (raw: string): ServerToClientBridgeMessage | null => {
    try {
        const parsed: unknown = JSON.parse(raw);
        return toBridgeCommandMessage(parsed) || toBridgeRejectMessage(parsed);
    } catch {
        return null;
    }
};

export class ApiBridgeClient {
    private socket: WebSocket | null = null;
    private commandHandler: CommandHandler | null = null;
    private statusListener: StatusListener | null = null;
    private currentStatus: ApiBridgeStatus = 'disconnected';

    setCommandHandler(handler: CommandHandler) {
        this.commandHandler = handler;
    }

    setStatusListener(listener: StatusListener) {
        this.statusListener = listener;
    }

    getStatus() {
        return this.currentStatus;
    }

    connect(url: string) {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.disconnect(false);

        const ws = new WebSocket(url);
        this.socket = ws;
        this.emitStatus({ status: 'connecting' });

        ws.onopen = () => {
            if (this.socket !== ws) return;
            ws.send(
                JSON.stringify({
                    type: BRIDGE_REGISTER_TYPE,
                    client: 'openword-web'
                })
            );
            this.emitStatus({ status: 'connected' });
        };

        ws.onmessage = event => {
            if (this.socket !== ws) return;
            const rawText = typeof event.data === 'string' ? event.data : String(event.data);
            const message = parseMessage(rawText);
            if (!message) {
                this.sendErrorResult(ws, '', {
                    code: 'INTERNAL_ERROR',
                    message: 'Received invalid bridge message.'
                });
                return;
            }

            if (message.type === BRIDGE_REJECT_TYPE) {
                const messageText =
                    message.reason === 'controller_exists'
                        ? 'Bridge occupied by another tab.'
                        : 'Bridge rejected due to invalid message.';
                this.emitStatus({
                    status: message.reason === 'controller_exists' ? 'occupied' : 'error',
                    message: messageText
                });
                ws.close();
                return;
            }

            void this.handleCommandMessage(ws, message);
        };

        ws.onerror = () => {
            if (this.socket !== ws) return;
            if (this.currentStatus !== 'occupied') {
                this.emitStatus({ status: 'error', message: 'Bridge connection error.' });
            }
        };

        ws.onclose = () => {
            if (this.socket !== ws) return;
            this.socket = null;
            if (this.currentStatus !== 'occupied') {
                this.emitStatus({ status: 'disconnected' });
            }
        };
    }

    disconnect(emitStatus = true) {
        if (!this.socket) {
            if (emitStatus) {
                this.emitStatus({ status: 'disconnected' });
            }
            return;
        }

        const socket = this.socket;
        this.socket = null;
        socket.close();

        if (emitStatus) {
            this.emitStatus({ status: 'disconnected' });
        }
    }

    private async handleCommandMessage(
        ws: WebSocket,
        message: Extract<ServerToClientBridgeMessage, { type: 'command' }>
    ) {
        if (!this.commandHandler) {
            this.sendErrorResult(ws, message.request_id, {
                code: 'INTERNAL_ERROR',
                message: 'Bridge command handler is not ready.'
            });
            return;
        }

        try {
            const result = await this.commandHandler(message.command, message.payload as never);
            if (ws.readyState !== WebSocket.OPEN) return;

            ws.send(
                JSON.stringify({
                    type: BRIDGE_RESULT_TYPE,
                    request_id: message.request_id,
                    ok: true,
                    data: result
                })
            );
        } catch (error) {
            this.sendErrorResult(ws, message.request_id, toBridgeErrorPayload(error));
        }
    }

    private sendErrorResult(ws: WebSocket, requestId: string, error: BridgeErrorPayload) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
            JSON.stringify({
                type: BRIDGE_RESULT_TYPE,
                request_id: requestId,
                ok: false,
                error
            })
        );
    }

    private emitStatus(event: ApiBridgeStatusEvent) {
        this.currentStatus = event.status;
        this.statusListener?.(event);
    }
}
