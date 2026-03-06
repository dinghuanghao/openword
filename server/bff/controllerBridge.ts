import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
    BRIDGE_COMMAND_TYPE,
    BRIDGE_REJECT_TYPE,
    BRIDGE_REGISTER_TYPE,
    BRIDGE_RESULT_TYPE,
    type BridgeCommand,
    type BridgeCommandMessage,
    type BridgeCommandPayloadMap,
    type BridgeCommandResultMap,
    type BridgeErrorCode,
    type BridgeErrorPayload,
    type BridgeResultMessage,
    isBridgeCommand,
    isRecord
} from '../../shared/protocol';

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

interface PendingCommand<T extends BridgeCommand = BridgeCommand> {
    command: T;
    resolve: (value: BridgeCommandResultMap[T]) => void;
    reject: (error: BridgeRequestError) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

export class BridgeRequestError extends Error {
    readonly code: BridgeErrorCode;

    constructor(code: BridgeErrorCode, message: string) {
        super(message);
        this.code = code;
    }

    toPayload(): BridgeErrorPayload {
        return {
            code: this.code,
            message: this.message
        };
    }
}

const parseIncomingMessage = (raw: string) => {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const toBridgeResultMessage = (value: unknown): BridgeResultMessage | null => {
    if (!isRecord(value)) return null;
    if (value.type !== BRIDGE_RESULT_TYPE) return null;
    if (typeof value.request_id !== 'string' || !value.request_id) return null;
    if (typeof value.ok !== 'boolean') return null;

    let errorPayload: BridgeErrorPayload | undefined;
    if (!value.ok) {
        if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
            return null;
        }
        errorPayload = {
            code: value.error.code as BridgeErrorCode,
            message: value.error.message
        };
    }

    return {
        type: BRIDGE_RESULT_TYPE,
        request_id: value.request_id,
        ok: value.ok,
        ...(value.data !== undefined ? { data: value.data as any } : {}),
        ...(errorPayload ? { error: errorPayload } : {})
    };
};

const toRegisterMessage = (value: unknown) => {
    if (!isRecord(value)) return null;
    if (value.type !== BRIDGE_REGISTER_TYPE) return null;
    if (value.client !== 'openword-web') return null;
    return {
        type: BRIDGE_REGISTER_TYPE,
        client: 'openword-web' as const
    };
};

const safeSend = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
};

export class ControllerBridge {
    private controllerSocket: WebSocket | null = null;
    private readonly pending = new Map<string, PendingCommand>();
    private readonly onControllerStatusChanged: () => void;

    constructor(onControllerStatusChanged: () => void = () => undefined) {
        this.onControllerStatusChanged = onControllerStatusChanged;
    }

    hasController() {
        return this.controllerSocket !== null && this.controllerSocket.readyState === this.controllerSocket.OPEN;
    }

    attachSocket(socket: WebSocket) {
        socket.on('message', raw => {
            const rawText = typeof raw === 'string' ? raw : raw.toString();
            const parsed = parseIncomingMessage(rawText);
            if (!parsed) {
                safeSend(socket, {
                    type: BRIDGE_REJECT_TYPE,
                    reason: 'invalid_message'
                });
                socket.close();
                return;
            }

            const registerPayload = toRegisterMessage(parsed);
            if (registerPayload) {
                this.registerControllerSocket(socket);
                return;
            }

            const resultPayload = toBridgeResultMessage(parsed);
            if (resultPayload) {
                this.resolvePending(resultPayload);
                return;
            }

            safeSend(socket, {
                type: BRIDGE_REJECT_TYPE,
                reason: 'invalid_message'
            });
            socket.close();
        });
    }

    registerControllerSocket(socket: WebSocket) {
        if (this.hasController() && this.controllerSocket !== socket) {
            safeSend(socket, {
                type: BRIDGE_REJECT_TYPE,
                reason: 'controller_exists'
            });
            socket.close();
            return;
        }

        this.controllerSocket = socket;
        this.onControllerStatusChanged();

        socket.on('close', () => {
            if (this.controllerSocket === socket) {
                this.controllerSocket = null;
                this.rejectAllPending(new BridgeRequestError('NO_BRIDGE', 'No active bridge connection.'));
                this.onControllerStatusChanged();
            }
        });

        socket.on('error', () => {
            if (this.controllerSocket === socket) {
                this.controllerSocket = null;
                this.rejectAllPending(new BridgeRequestError('NO_BRIDGE', 'Bridge connection interrupted.'));
                this.onControllerStatusChanged();
            }
        });
    }

    async sendCommand<T extends BridgeCommand>(
        command: T,
        payload: BridgeCommandPayloadMap[T],
        timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
    ): Promise<BridgeCommandResultMap[T]> {
        if (!isBridgeCommand(command)) {
            throw new BridgeRequestError('INVALID_INPUT', `Unsupported command: ${String(command)}`);
        }

        const socket = this.controllerSocket;
        if (!socket || socket.readyState !== socket.OPEN) {
            throw new BridgeRequestError('NO_BRIDGE', 'No active bridge connection.');
        }

        const requestId = randomUUID();

        const resultPromise = new Promise<BridgeCommandResultMap[T]>((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new BridgeRequestError('TIMEOUT', `Command timed out: ${command}`));
            }, timeoutMs);

            this.pending.set(requestId, {
                command,
                resolve: resolve as PendingCommand<T>['resolve'],
                reject,
                timeoutHandle
            });
        });

        const commandMessage: BridgeCommandMessage<T> = {
            type: BRIDGE_COMMAND_TYPE,
            request_id: requestId,
            command,
            payload
        };

        safeSend(socket, commandMessage);
        return await resultPromise;
    }

    private resolvePending(message: BridgeResultMessage) {
        const entry = this.pending.get(message.request_id);
        if (!entry) return;

        this.pending.delete(message.request_id);
        clearTimeout(entry.timeoutHandle);

        if (!message.ok) {
            const code = message.error?.code ?? 'INTERNAL_ERROR';
            const messageText = message.error?.message || 'Bridge command failed.';
            entry.reject(new BridgeRequestError(code, messageText));
            return;
        }

        entry.resolve((message.data ?? {}) as never);
    }

    private rejectAllPending(error: BridgeRequestError) {
        for (const [requestId, pendingEntry] of this.pending.entries()) {
            clearTimeout(pendingEntry.timeoutHandle);
            pendingEntry.reject(error);
            this.pending.delete(requestId);
        }
    }
}
