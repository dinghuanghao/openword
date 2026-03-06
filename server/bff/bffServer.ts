import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
    BRIDGE_WS_PATH,
    DEFAULT_BFF_PORT,
    isRecord,
    type BridgeCommandPayloadMap,
    type BridgeCommandResultMap
} from '../../shared/protocol';
import { BridgeRequestError, ControllerBridge } from './controllerBridge';
import { writeLatestSceneImage } from './fileSceneWriter';

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ server, path: BRIDGE_WS_PATH });
const controllerBridge = new ControllerBridge(() => {
    const online = controllerBridge.hasController();
    console.log(`[BFF] controller status changed: ${online ? 'online' : 'offline'}`);
});

app.use(express.json({ limit: '1mb' }));

const toPort = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getErrorPayload = (error: unknown) => {
    if (error instanceof BridgeRequestError) {
        return error.toPayload();
    }

    if (error instanceof Error) {
        return {
            code: 'INTERNAL_ERROR' as const,
            message: error.message || 'Internal error.'
        };
    }

    return {
        code: 'INTERNAL_ERROR' as const,
        message: 'Internal error.'
    };
};

const parseBodyString = (value: unknown, fieldName: string) => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BridgeRequestError('INVALID_INPUT', `Field '${fieldName}' must be a non-empty string.`);
    }
    return value.trim();
};

const parseOptionalBodyString = (value: unknown, fieldName: string) => {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value !== 'string' || !value.trim()) {
        throw new BridgeRequestError('INVALID_INPUT', `Field '${fieldName}' must be a non-empty string when provided.`);
    }
    return value.trim();
};

const resolveInputPath = (inputPath: string) => {
    if (inputPath.startsWith('~/') && process.env.HOME) {
        return path.resolve(process.env.HOME, inputPath.slice(2));
    }

    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    return path.resolve(process.cwd(), inputPath);
};

const readImageFileAsBase64 = async (inputPath: string) => {
    const resolvedPath = resolveInputPath(inputPath);

    let fileStat;
    try {
        fileStat = await stat(resolvedPath);
    } catch {
        throw new BridgeRequestError('INVALID_INPUT', `Field 'image_path' does not exist: ${resolvedPath}`);
    }

    if (!fileStat.isFile()) {
        throw new BridgeRequestError('INVALID_INPUT', `Field 'image_path' must point to a file: ${resolvedPath}`);
    }

    const fileBuffer = await readFile(resolvedPath);
    if (fileBuffer.length === 0) {
        throw new BridgeRequestError('INVALID_INPUT', `Field 'image_path' points to an empty file: ${resolvedPath}`);
    }

    return fileBuffer.toString('base64');
};

const sendBridgeCommand = async <T extends keyof BridgeCommandPayloadMap>(
    command: T,
    payload: BridgeCommandPayloadMap[T]
): Promise<BridgeCommandResultMap[T]> => {
    return await controllerBridge.sendCommand(command, payload);
};

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        bridge_online: controllerBridge.hasController()
    });
});

app.post('/api/create_game', async (req, res) => {
    try {
        if (!isRecord(req.body)) {
            throw new BridgeRequestError('INVALID_INPUT', 'Request body must be a JSON object.');
        }

        const description = parseBodyString(req.body.description, 'description');
        const style = parseBodyString(req.body.style, 'style');
        const imagePath = parseOptionalBodyString(req.body.image_path, 'image_path');
        const initImageBase64 = imagePath ? await readImageFileAsBase64(imagePath) : null;
        const data = await sendBridgeCommand('create_game', {
            description,
            style,
            ...(initImageBase64 ? { init_image_base64: initImageBase64 } : {})
        });
        res.json({ status: 'ok', game_id: data.game_id });
    } catch (error) {
        const payload = getErrorPayload(error);
        res.status(400).json({ status: 'error', error: payload });
    }
});

app.get('/api/show_history_games', async (_req, res) => {
    try {
        const data = await sendBridgeCommand('show_history_games', {});
        res.json({ status: 'ok', games: data.games });
    } catch (error) {
        const payload = getErrorPayload(error);
        res.status(400).json({ status: 'error', error: payload });
    }
});

app.post('/api/load_game', async (req, res) => {
    try {
        if (!isRecord(req.body)) {
            throw new BridgeRequestError('INVALID_INPUT', 'Request body must be a JSON object.');
        }

        const gameId = parseBodyString(req.body.game_id, 'game_id');
        await sendBridgeCommand('load_game', { game_id: gameId });
        res.json({ status: 'ok' });
    } catch (error) {
        const payload = getErrorPayload(error);
        res.status(400).json({ status: 'error', error: payload });
    }
});

app.get('/api/get_current_game_state', async (_req, res) => {
    try {
        const data = await sendBridgeCommand('get_current_game_state', {});
        const repoRoot = process.cwd();
        const lastSceneImagePath = await writeLatestSceneImage(repoRoot, data.game_id, data.last_scene_image_data_url);

        res.json({
            status: 'ok',
            world_view: data.world_view,
            narrative: data.narrative,
            player_profile: data.player_profile,
            last_scene_image_path: lastSceneImagePath
        });
    } catch (error) {
        const payload = getErrorPayload(error);
        res.status(400).json({ status: 'error', error: payload });
    }
});

app.post('/api/do_action', async (req, res) => {
    try {
        if (!isRecord(req.body)) {
            throw new BridgeRequestError('INVALID_INPUT', 'Request body must be a JSON object.');
        }

        const description = parseBodyString(req.body.description, 'description');
        const data = await sendBridgeCommand('do_action', { description });
        const repoRoot = process.cwd();
        const lastSceneImagePath = await writeLatestSceneImage(repoRoot, data.game_id, data.last_scene_image_data_url);
        res.json({
            status: 'ok',
            world_view: data.world_view,
            narrative: data.narrative,
            player_profile: data.player_profile,
            last_scene_image_path: lastSceneImagePath
        });
    } catch (error) {
        const payload = getErrorPayload(error);
        res.status(400).json({ status: 'error', error: payload });
    }
});

const shouldServeStatic = process.env.NODE_ENV === 'production';
if (shouldServeStatic) {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
        app.use(express.static(distDir));
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api') || req.path === '/health') {
                next();
                return;
            }

            res.sendFile(indexHtmlPath, error => {
                if (error) {
                    next(error);
                }
            });
        });
        console.log(`[BFF] static hosting enabled from ${distDir}`);
    } else {
        console.warn(`[BFF] static hosting skipped: ${indexHtmlPath} not found.`);
    }
}

wsServer.on('connection', socket => {
    controllerBridge.attachSocket(socket);
});

const port = toPort(process.env.BFF_PORT ?? process.env.PORT, DEFAULT_BFF_PORT);
const host = process.env.BFF_HOST || '127.0.0.1';

server.listen(port, host, () => {
    const rootPath = path.resolve(process.cwd());
    console.log(`[BFF] listening on http://${host}:${port}`);
    console.log(`[BFF] ws endpoint ws://${host}:${port}${BRIDGE_WS_PATH}`);
    console.log(`[BFF] repo root ${rootPath}`);
});
