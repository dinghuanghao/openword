import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeRequestError } from './controllerBridge';

const MIME_TO_EXTENSION: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
};

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/;

const sanitizeGameId = (gameId: string) => {
    const trimmed = gameId.trim();
    if (!trimmed) return '';
    return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const decodeDataUrl = (dataUrl: string) => {
    const trimmed = dataUrl.trim();
    const match = DATA_URL_PATTERN.exec(trimmed);
    if (!match) {
        throw new BridgeRequestError('IMAGE_NOT_AVAILABLE', 'Invalid scene image data URL.');
    }

    const mimeType = match[1];
    const base64Payload = match[2];
    const ext = MIME_TO_EXTENSION[mimeType];

    if (!ext) {
        throw new BridgeRequestError('IMAGE_NOT_AVAILABLE', `Unsupported scene image MIME type: ${mimeType}`);
    }

    try {
        const data = Buffer.from(base64Payload, 'base64');
        if (data.length === 0) {
            throw new Error('Empty image payload.');
        }
        return { ext, data };
    } catch {
        throw new BridgeRequestError('IMAGE_NOT_AVAILABLE', 'Failed to decode scene image payload.');
    }
};

export const writeLatestSceneImage = async (repoRoot: string, gameId: string, imageDataUrl: string) => {
    const safeGameId = sanitizeGameId(gameId);
    if (!safeGameId) {
        throw new BridgeRequestError('INVALID_INPUT', 'Invalid game_id.');
    }

    const { ext, data } = decodeDataUrl(imageDataUrl);
    const gameDir = path.resolve(repoRoot, '.openword', safeGameId);
    const outputPath = path.resolve(gameDir, `latest_game_scene.${ext}`);
    const tempPath = path.resolve(gameDir, `latest_game_scene.${ext}.${randomUUID()}.tmp`);

    await mkdir(gameDir, { recursive: true });
    await writeFile(tempPath, data);
    await rename(tempPath, outputPath);

    return outputPath;
};
