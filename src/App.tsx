import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, Key, Image as ImageIcon, X, Menu, Bug, Download, Upload, Settings2, User, ChevronDown, ArrowLeft, ChevronLeft, ChevronRight, Trash2, Bot, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    initGame,
    processAction,
    generateAutoPlayerAction,
    restoreToCheckpoint,
    exportRuntimeState,
    importRuntimeState,
    setStyleState,
    setPlayerProfileState,
    setTaskState,
    GameRuntimeState,
    TaskGuideItem
} from './services/gameService';
import { deleteSavedGame, listSavedGames, loadSavedGamePayload, SavedGameSummary, saveLatestAutosavePayload, upsertSavedGame } from './services/adventureAutosaveStore';
import { DebugInfo, DebugRequestBlock } from './types';
import { PlayerProfile, sanitizePlayerProfile } from './domain/playerProfile';
import { resolveAppLanguage, type AppLanguage } from './i18n/types';
import {
    applyReplayUiPatch,
    cloneReplayCheckpoints,
    createReplayViewState,
    ReplayCheckpointSnapshot,
    ReplayStopReason,
    ReplayViewState,
    runStoryReplay
} from './replay/storyReplayOrchestrator';
import { ApiBridgeClient, ApiBridgeClientError, type ApiBridgeStatus } from './services/apiBridgeClient';
import {
    BRIDGE_WS_PATH,
    type BridgeCommand,
    type BridgeCommandPayloadMap,
    type BridgeCommandResultMap,
    type BridgeErrorCode
} from '../shared/protocol';

interface StoryCheckpoint {
    id: number;
    userInput: string;
    narrative: string;
    playerProfile?: PlayerProfile;
    tasks?: TaskGuideItem[];
    nextChoices?: string[];
    imageSrc?: string;
    debugInfo?: DebugInfo;
    isStreaming?: boolean;
}

type ProcessingPhase = 'world' | 'dm' | 'render';
type StorySaveVersion = 1;
type ViewMode = 'home' | 'game';
type AutoPlayerStatus = 'idle' | 'thinking' | 'typing';

interface StorySaveFile {
    version: StorySaveVersion;
    savedAt: string;
    appState: {
        isInit: boolean;
        quality: string;
        style: string;
        agentBehaviorMode: string;
        creationInput: string;
        currentImage: string | null;
        tasks: TaskGuideItem[];
        nextChoices: string[];
        story: StoryCheckpoint[];
        debugInfo: DebugInfo | null;
        checkpointId: number;
    };
    runtimeState: GameRuntimeState;
}

interface ReplayUiSnapshot {
    isLogOpen: boolean;
    isStoryHoverOpen: boolean;
    isStoryHoverClosable: boolean;
}

interface SubmitActionOptions {
    forceInit?: boolean;
    styleOverride?: string;
    presetGameId?: string | null;
    throwOnError?: boolean;
}

interface SubmitActionResult {
    narrative: string;
    playerProfile: PlayerProfile;
    imageDataUrl: string;
}

const SAVE_FILE_VERSION: StorySaveVersion = 1;
const BATCH_SAVE_FILE_VERSION = 1 as const;
const STORY_EDGE_TRIGGER_WIDTH = 12;
const LIVE_NARRATIVE_CHARS_PER_SECOND = 6;
const LIVE_NARRATIVE_TICK_MS = 1000 / LIVE_NARRATIVE_CHARS_PER_SECOND;
const AUTO_PLAYER_TYPING_CHARS_PER_SECOND = 12;
const AUTO_PLAYER_TYPING_TICK_MS = 1000 / AUTO_PLAYER_TYPING_CHARS_PER_SECOND;
const AUTO_PLAYER_CONFIRM_DELAY_MS = 2000;
const NEXT_CHOICE_COUNT = 3;
const NEXT_CHOICE_MAX_CHARS = 25;
const MAX_MAIN_TASKS = 1;
const MAX_SIDE_TASKS = 2;
const AUTOSAVE_DEBOUNCE_MS = 800;
const HOME_LIBRARY_SCROLL_RATIO = 0.9;
const CUSTOM_MODEL_OPTION_VALUE = '__custom__';
const LLM_MODEL_STORAGE_KEY = 'OPENWORD_LLM_MODEL';
const IMAGE_MODEL_STORAGE_KEY = 'OPENWORD_IMAGE_MODEL';
const STYLE_STORAGE_KEY = 'OPENWORD_STYLE';
const DEFAULT_STYLE = 'Claymation';
const DEFAULT_LLM_MODEL = 'gemini-3.1-flash-lite-preview';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_AGENT_BEHAVIOR_MODE = '你是一个天马行空的极客，优先选择高风险、非常规但可执行的激进行动，必要时打破常规流程，但你本身是善良的，不会做出非常邪恶的事。';
const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; labelKey: string }> = [
    { value: 'zh-CN', labelKey: 'common.simplifiedChinese' },
    { value: 'en-US', labelKey: 'common.english' }
];
const LLM_MODEL_OPTIONS = ['gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'];
const IMAGE_MODEL_OPTIONS = ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'];
const STYLE_OPTIONS: Array<{ labelKey: string; value: string }> = [
    { labelKey: 'styles.claymation', value: 'Claymation' },
    { labelKey: 'styles.minecraft', value: 'Minecraft' },
    { labelKey: 'styles.pixelArt', value: 'Pixel Art' },
    { labelKey: 'styles.pixelArt3d', value: '3D Pixel Art' },
    { labelKey: 'styles.realistic', value: 'Realistic' }
];
const DEFAULT_PLAYER_PROFILE: PlayerProfile = {
    playerName: 'Unknown Adventurer',
    statuses: [{ name: 'Health', color: '#ef4444', percent: 100 }],
    skills: [],
    items: []
};
const APP_NAME_SEPARATOR_PATTERN = /[｜|]/;
const WORLD_COVER_SWITCH_MS = 6000;
const HOME_BACKGROUND_IMAGES_BY_STYLE: Partial<Record<string, string>> = {
    Claymation: new URL('../images/background/claymation.jpeg', import.meta.url).href,
    Minecraft: new URL('../images/background/minecraft.jpeg', import.meta.url).href,
    'Pixel Art': new URL('../images/background/pixel.jpeg', import.meta.url).href,
    '3D Pixel Art': new URL('../images/background/voxel.jpeg', import.meta.url).href
};
const WORLD_COVER_IMAGE_MODULES = import.meta.glob(
    '../images/transitions/*.{png,jpg,jpeg,webp,avif,gif,PNG,JPG,JPEG,WEBP,AVIF,GIF}',
    { eager: true, import: 'default' }
) as Record<string, string>;
const WORLD_COVER_IMAGES = Object.values(WORLD_COVER_IMAGE_MODULES);

const pickRandomIndex = (size: number, currentIndex: number | null = null) => {
    if (size <= 1) return 0;

    let nextIndex = Math.floor(Math.random() * size);
    if (currentIndex === null || nextIndex !== currentIndex) {
        return nextIndex;
    }

    nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (size - 1))) % size;
    return nextIndex;
};

const getConfiguredGeminiApiKey = () => localStorage.getItem('CUSTOM_GEMINI_API_KEY') || process.env.GEMINI_API_KEY || '';
const getApiBridgeWsUrl = () => {
    if (typeof window === 'undefined') {
        return `ws://127.0.0.1:30000${BRIDGE_WS_PATH}`;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}${BRIDGE_WS_PATH}`;
};

const splitAppName = (value: string) => {
    const parts = value.split(APP_NAME_SEPARATOR_PATTERN).map(item => item.trim()).filter(Boolean);
    if (parts.length < 2) {
        return {
            primary: value,
            secondary: ''
        };
    }
    return {
        primary: parts[0],
        secondary: parts.slice(1).join(' ')
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const isDebugRequestBlockLike = (value: unknown): value is DebugRequestBlock => {
    if (!isRecord(value)) return false;
    const hasBaseFields = typeof value.key === 'string'
        && typeof value.title === 'string'
        && typeof value.promptText === 'string';
    if (!hasBaseFields) return false;
    return value.imageDataUrl === undefined || typeof value.imageDataUrl === 'string';
};

const isAgentDebugInfoLike = (value: unknown) => {
    if (!isRecord(value)) return false;
    if (!Array.isArray(value.requestBlocks) || !value.requestBlocks.every(isDebugRequestBlockLike)) return false;
    if (value.outputAction !== undefined && typeof value.outputAction !== 'string') return false;
    if (value.rawModelText !== undefined && typeof value.rawModelText !== 'string') return false;
    return true;
};

const isDebugInfoLike = (value: unknown): value is DebugInfo => {
    if (!isRecord(value) || !isRecord(value.dm) || !isRecord(value.image)) return false;

    const isBaseValid = Array.isArray(value.dm.requestBlocks)
        && value.dm.requestBlocks.every(isDebugRequestBlockLike)
        && Object.prototype.hasOwnProperty.call(value.dm, 'dmOutput')
        && Array.isArray(value.image.requestBlocks)
        && value.image.requestBlocks.every(isDebugRequestBlockLike);
    if (!isBaseValid) return false;

    const agentValue = value.agent;
    if (agentValue === undefined || agentValue === null) return true;
    return isAgentDebugInfoLike(agentValue);
};

const toNonEmptyString = (value: unknown, fallback = '') => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed ? value : fallback;
};

const toPositiveInteger = (value: unknown, fallback = 1) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
};

const toTaskType = (value: unknown): 'main' | 'side' => {
    return value === 'side' ? 'side' : 'main';
};

const TASK_MAIN_PREFIX_PATTERN = /^(?:【\s*主线任务\s*】|\[\s*main\s*(?:quest|task)\s*]|\s*(?:主线任务|main\s*(?:quest|task))\s*[:：-])\s*/i;
const TASK_SIDE_PREFIX_PATTERN = /^(?:【\s*支线任务\s*】|\[\s*side\s*(?:quest|task)\s*]|\s*(?:支线任务|side\s*(?:quest|task))\s*[:：-])\s*/i;

const inferTaskTypeFromText = (value: string): 'main' | 'side' | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (TASK_SIDE_PREFIX_PATTERN.test(trimmed)) return 'side';
    if (TASK_MAIN_PREFIX_PATTERN.test(trimmed)) return 'main';
    return null;
};

const stripTaskPrefixFromName = (value: string) => {
    return value
        .trim()
        .replace(TASK_SIDE_PREFIX_PATTERN, '')
        .replace(TASK_MAIN_PREFIX_PATTERN, '')
        .trim();
};

const normalizeTaskIdentityText = (value: string) => {
    return value
        .toLowerCase()
        .replace(/第?[0-9一二三四五六七八九十百]+(阶段|步)/g, '')
        .replace(/\b(?:phase|step)\s*[0-9]+\b/g, '')
        .replace(/[【】\[\]（）(){}:：\-_,，。.!?？、\s]/g, '')
        .trim();
};

const truncateByChars = (value: string, maxChars: number) => {
    return Array.from(value).slice(0, maxChars).join('');
};

const getCharLength = (value: string) => {
    return Array.from(value).length;
};

const resolveModelName = (value: string, fallback: string) => {
    const trimmed = value.trim();
    return trimmed || fallback;
};

const resolveInitialStyle = () => {
    if (typeof window === 'undefined') return DEFAULT_STYLE;
    return toNonEmptyString(localStorage.getItem(STYLE_STORAGE_KEY), DEFAULT_STYLE);
};

const createGameId = () => {
    return `game-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const sortSavedGames = (games: SavedGameSummary[]) => {
    return [...games].sort((left, right) => (
        new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime()
    ));
};

const formatSavedAt = (savedAt: string, locale: AppLanguage) => {
    const date = new Date(savedAt);
    if (Number.isNaN(date.getTime())) return savedAt;
    return date.toLocaleString(locale);
};

const triggerJsonDownload = (payload: unknown, fileNamePrefix: string, timestamp: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `${fileNamePrefix}-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
};

const triggerJsonPartsDownload = (parts: BlobPart[], fileNamePrefix: string, timestamp: string) => {
    const blob = new Blob(parts, { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `${fileNamePrefix}-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
};

const isLikelySameTaskGoal = (left: TaskGuideItem, right: TaskGuideItem) => {
    const leftName = normalizeTaskIdentityText(left.name);
    const rightName = normalizeTaskIdentityText(right.name);
    if (leftName && rightName && leftName === rightName) return true;

    const leftGoal = normalizeTaskIdentityText(`${left.name}${left.content}`);
    const rightGoal = normalizeTaskIdentityText(`${right.name}${right.content}`);
    if (!leftGoal || !rightGoal) return false;
    if (leftGoal === rightGoal) return true;

    const shorter = leftGoal.length <= rightGoal.length ? leftGoal : rightGoal;
    const longer = leftGoal.length > rightGoal.length ? leftGoal : rightGoal;
    return shorter.length >= 8 && longer.includes(shorter);
};

const normalizeTaskList = (value: unknown): TaskGuideItem[] => {
    if (!Array.isArray(value)) return [];

    const merged: TaskGuideItem[] = [];
    const seenExact = new Set<string>();

    for (const rawTask of value) {
        if (!isRecord(rawTask)) continue;
        const rawName = toNonEmptyString(rawTask.name);
        const content = toNonEmptyString(rawTask.content);
        if (!rawName || !content) continue;
        const name = stripTaskPrefixFromName(rawName);
        if (!name) continue;
        const inferredType = inferTaskTypeFromText(rawName) ?? inferTaskTypeFromText(content);
        const type = inferredType ?? toTaskType(rawTask.type);
        const exactKey = `${type}:${name.toLowerCase()}:${content.toLowerCase()}`;
        if (seenExact.has(exactKey)) continue;
        seenExact.add(exactKey);

        const normalizedTask: TaskGuideItem = { name, content, type };
        const existingIndex = merged.findIndex(
            existing => existing.type === type && isLikelySameTaskGoal(existing, normalizedTask)
        );
        if (existingIndex >= 0) {
            merged[existingIndex] = normalizedTask;
            continue;
        }

        merged.push(normalizedTask);
    }

    const limited: TaskGuideItem[] = [];
    let mainCount = 0;
    let sideCount = 0;
    for (const task of merged) {
        if (task.type === 'side') {
            if (sideCount >= MAX_SIDE_TASKS) continue;
            sideCount += 1;
            limited.push(task);
            continue;
        }

        if (mainCount >= MAX_MAIN_TASKS) continue;
        mainCount += 1;
        limited.push({ ...task, type: 'main' });
    }

    return limited;
};

const normalizeChoiceList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const text = truncateByChars(toNonEmptyString(item).trim(), NEXT_CHOICE_MAX_CHARS);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(text);
    }
    return deduped.slice(0, NEXT_CHOICE_COUNT);
};

const parsePlayerProfileStrict = (value: unknown, fieldPath: string): PlayerProfile => {
    const parsed = sanitizePlayerProfile(value);
    if (!parsed) {
        throw new Error(`存档格式错误：${fieldPath} 无效。`);
    }
    return parsed;
};

const clonePlayerProfileValue = (value: PlayerProfile): PlayerProfile => {
    return {
        playerName: value.playerName,
        statuses: value.statuses.map(status => ({ ...status })),
        skills: value.skills.map(skill => ({ ...skill })),
        items: value.items.map(item => ({ ...item }))
    };
};

const cloneDebugInfoValue = (value: DebugInfo | null | undefined): DebugInfo | null => {
    if (!value) return null;
    return JSON.parse(JSON.stringify(value)) as DebugInfo;
};

const toReplayCheckpointSnapshot = (checkpoint: StoryCheckpoint): ReplayCheckpointSnapshot | null => {
    if (!checkpoint.imageSrc || checkpoint.isStreaming) return null;

    const safeProfile = sanitizePlayerProfile(checkpoint.playerProfile) || clonePlayerProfileValue(DEFAULT_PLAYER_PROFILE);
    return {
        id: checkpoint.id,
        userInput: checkpoint.userInput,
        narrative: checkpoint.narrative,
        playerProfile: clonePlayerProfileValue(safeProfile),
        tasks: (checkpoint.tasks || []).map(task => ({ ...task })),
        nextChoices: normalizeChoiceList(checkpoint.nextChoices),
        imageSrc: checkpoint.imageSrc,
        debugInfo: cloneDebugInfoValue(checkpoint.debugInfo)
    };
};

const parseRuntimeHistoryStrict = (value: unknown): GameRuntimeState['history'] => {
    if (!Array.isArray(value)) {
        throw new Error('存档格式错误：runtimeState.history 必须是数组。');
    }

    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new Error(`存档格式错误：runtimeState.history[${index}] 不是对象。`);
        }
        if (entry.role !== 'user' && entry.role !== 'model') {
            throw new Error(`存档格式错误：runtimeState.history[${index}].role 无效。`);
        }
        if (typeof entry.text !== 'string') {
            throw new Error(`存档格式错误：runtimeState.history[${index}].text 无效。`);
        }

        return {
            role: entry.role,
            text: entry.text
        };
    });
};

const extractBase64FromDataUrl = (dataUrl: string | null) => {
    if (!dataUrl) return null;
    const separatorIndex = dataUrl.indexOf(',');
    if (separatorIndex < 0) return null;
    const payload = dataUrl.slice(separatorIndex + 1).trim();
    return payload || null;
};

interface HistoryConversationRoundBlock {
    roundNumber: number;
    messageEntries: string[];
}

interface ParsedHistoryConversationBlock {
    opening: string;
    rounds: HistoryConversationRoundBlock[];
    closing: string;
}

const parseHistoryConversationBlock = (promptText: string): ParsedHistoryConversationBlock | null => {
    const messagePattern = /<message index="(\d+)" role="(?:USER|MODEL)">[\s\S]*?<\/message>/g;
    const matches = Array.from(promptText.matchAll(messagePattern));
    if (matches.length === 0) return null;

    const firstMatchIndex = matches[0].index;
    if (typeof firstMatchIndex !== 'number') return null;
    const lastMatch = matches[matches.length - 1];
    const lastMatchIndex = lastMatch.index;
    if (typeof lastMatchIndex !== 'number') return null;

    const opening = promptText.slice(0, firstMatchIndex);
    const closing = promptText.slice(lastMatchIndex + lastMatch[0].length);
    const rounds: HistoryConversationRoundBlock[] = [];

    for (const match of matches) {
        const messageIndex = Number(match[1]);
        if (!Number.isFinite(messageIndex) || messageIndex <= 0) {
            return null;
        }

        const roundNumber = Math.ceil(messageIndex / 2);
        const round = rounds[rounds.length - 1];
        if (!round || round.roundNumber !== roundNumber) {
            rounds.push({ roundNumber, messageEntries: [match[0]] });
            continue;
        }
        round.messageEntries.push(match[0]);
    }

    return {
        opening,
        rounds,
        closing
    };
};

const parseCheckpointStrict = (value: unknown, fallbackId: number): StoryCheckpoint => {
    if (!isRecord(value)) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}] 不是对象。`);
    }

    const userInput = toNonEmptyString(value.userInput);
    const narrative = toNonEmptyString(value.narrative);
    if (!userInput || !narrative) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}] 缺少必要字段。`);
    }
    const playerProfile = parsePlayerProfileStrict(value.playerProfile, `story[${fallbackId - 1}].playerProfile`);

    const imageSrc = toNonEmptyString(value.imageSrc);
    if (!imageSrc) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}].imageSrc 不能为空。`);
    }

    if (!Array.isArray(value.tasks)) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}].tasks 必须是数组。`);
    }
    if (!Array.isArray(value.nextChoices)) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}].nextChoices 必须是数组。`);
    }

    const debugInfo =
        value.debugInfo === undefined || value.debugInfo === null
            ? undefined
            : isDebugInfoLike(value.debugInfo)
                ? value.debugInfo
                : null;
    if (debugInfo === null) {
        throw new Error(`存档格式错误：story[${fallbackId - 1}].debugInfo 无效。`);
    }

    return {
        id: toPositiveInteger(value.id, fallbackId),
        userInput,
        narrative,
        playerProfile,
        tasks: normalizeTaskList(value.tasks),
        nextChoices: normalizeChoiceList(value.nextChoices),
        imageSrc,
        debugInfo,
        isStreaming: false
    };
};

const parseSaveFile = (rawText: string): StorySaveFile => {
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        throw new Error('存档文件不是有效的 JSON。');
    }

    if (!isRecord(parsed)) {
        throw new Error('存档格式错误：缺少顶层对象。');
    }
    if (!isRecord(parsed.appState)) {
        throw new Error('存档格式错误：缺少 appState。');
    }
    if (!isRecord(parsed.runtimeState)) {
        throw new Error('存档格式错误：缺少 runtimeState。');
    }
    if (typeof parsed.savedAt !== 'string' || !parsed.savedAt) {
        throw new Error('存档格式错误：savedAt 无效。');
    }

    const appState = parsed.appState;
    const runtimeState = parsed.runtimeState;

    if (!Array.isArray(appState.story)) {
        throw new Error('存档格式错误：appState.story 必须是数组。');
    }
    if (!Array.isArray(appState.tasks)) {
        throw new Error('存档格式错误：appState.tasks 必须是数组。');
    }
    if (!Array.isArray(appState.nextChoices)) {
        throw new Error('存档格式错误：appState.nextChoices 必须是数组。');
    }
    if (typeof appState.isInit !== 'boolean') {
        throw new Error('存档格式错误：appState.isInit 必须是布尔值。');
    }
    if (typeof appState.quality !== 'string' || !appState.quality.trim()) {
        throw new Error('存档格式错误：appState.quality 无效。');
    }
    if (typeof appState.style !== 'string' || !appState.style.trim()) {
        throw new Error('存档格式错误：appState.style 无效。');
    }
    if (typeof appState.creationInput !== 'string' || !appState.creationInput.trim()) {
        throw new Error('存档格式错误：appState.creationInput 无效。');
    }
    if (appState.currentImage !== null && typeof appState.currentImage !== 'string') {
        throw new Error('存档格式错误：appState.currentImage 无效。');
    }
    if (appState.agentBehaviorMode !== undefined && typeof appState.agentBehaviorMode !== 'string') {
        throw new Error('存档格式错误：appState.agentBehaviorMode 无效。');
    }
    if (typeof appState.checkpointId !== 'number' || !Number.isFinite(appState.checkpointId)) {
        throw new Error('存档格式错误：appState.checkpointId 无效。');
    }
    if (appState.debugInfo !== null && !isDebugInfoLike(appState.debugInfo)) {
        throw new Error('存档格式错误：appState.debugInfo 无效。');
    }

    if (!Array.isArray(runtimeState.activeTasks)) {
        throw new Error('存档格式错误：runtimeState.activeTasks 必须是数组。');
    }
    if (typeof runtimeState.globalAnchor !== 'string') {
        throw new Error('存档格式错误：runtimeState.globalAnchor 无效。');
    }
    const runtimePlayerProfile = parsePlayerProfileStrict(runtimeState.playerProfile, 'runtimeState.playerProfile');
    if (typeof runtimeState.currentQuality !== 'string' || !runtimeState.currentQuality.trim()) {
        throw new Error('存档格式错误：runtimeState.currentQuality 无效。');
    }
    if (typeof runtimeState.currentStyle !== 'string' || !runtimeState.currentStyle.trim()) {
        throw new Error('存档格式错误：runtimeState.currentStyle 无效。');
    }
    if (typeof runtimeState.currentAspectRatio !== 'string' || !runtimeState.currentAspectRatio.trim()) {
        throw new Error('存档格式错误：runtimeState.currentAspectRatio 无效。');
    }
    const runtimeReferenceWorkRaw =
        runtimeState.currentReferenceWork !== undefined
            ? runtimeState.currentReferenceWork
            : runtimeState.currentReferenceGame;
    if (
        runtimeReferenceWorkRaw !== undefined
        && runtimeReferenceWorkRaw !== null
        && typeof runtimeReferenceWorkRaw !== 'string'
    ) {
        throw new Error('存档格式错误：runtimeState.currentReferenceWork 无效。');
    }

    const story = appState.story.map((item, index) => parseCheckpointStrict(item, index + 1));
    const quality = appState.quality as string;
    const style = appState.style as string;
    const agentBehaviorMode = toNonEmptyString(appState.agentBehaviorMode, DEFAULT_AGENT_BEHAVIOR_MODE);
    const creationInput = appState.creationInput as string;
    const currentImage = appState.currentImage as string | null;
    const debugInfo = appState.debugInfo as DebugInfo | null;
    const runtimeHistory = parseRuntimeHistoryStrict(runtimeState.history);
    const highestCheckpointId = story.reduce((maxId, checkpoint) => Math.max(maxId, checkpoint.id), 0);
    const minCheckpointId = highestCheckpointId + 1;
    // Backward compatibility: auto-heal old saves where checkpointId is stale.
    const checkpointId = Math.max(toPositiveInteger(appState.checkpointId, minCheckpointId), minCheckpointId);

    return {
        version: SAVE_FILE_VERSION,
        savedAt: parsed.savedAt,
        appState: {
            isInit: appState.isInit,
            quality,
            style,
            agentBehaviorMode,
            creationInput,
            currentImage,
            tasks: normalizeTaskList(appState.tasks),
            nextChoices: normalizeChoiceList(appState.nextChoices),
            story,
            debugInfo,
            checkpointId
        },
        runtimeState: {
            history: runtimeHistory,
            globalAnchor: runtimeState.globalAnchor,
            playerProfile: runtimePlayerProfile,
            currentQuality: runtimeState.currentQuality,
            currentStyle: runtimeState.currentStyle,
            currentAspectRatio: runtimeState.currentAspectRatio,
            currentReferenceWork: toNonEmptyString(runtimeReferenceWorkRaw, ''),
            activeTasks: normalizeTaskList(runtimeState.activeTasks)
        }
    };
};

const parseSaveFileUnchecked = (rawText: string): StorySaveFile => {
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error('存档文件不是有效的 JSON。');
    }
    return parsed as StorySaveFile;
};

const isBatchSavePackage = (value: unknown): value is { version: number; saves: unknown[] } => {
    return isRecord(value) && value.version === BATCH_SAVE_FILE_VERSION && Array.isArray(value.saves);
};

const toBridgeError = (code: BridgeErrorCode, message: string) => {
    return new ApiBridgeClientError(code, message);
};

export default function App() {
    const { t, i18n } = useTranslation();
    const currentLanguage = resolveAppLanguage(i18n.resolvedLanguage || i18n.language);
    const appName = splitAppName(t('common.appName'));
    const [hasKey, setHasKey] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('home');
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const [nextImage, setNextImage] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingPhase, setProcessingPhase] = useState<ProcessingPhase>('dm');
    const [inputValue, setInputValue] = useState('');
    const [processingInputSnapshot, setProcessingInputSnapshot] = useState('');
    const [isInit, setIsInit] = useState(true);
    const [quality, setQuality] = useState('1K');
    const [style, setStyle] = useState(resolveInitialStyle);
    const [agentBehaviorMode, setAgentBehaviorMode] = useState(DEFAULT_AGENT_BEHAVIOR_MODE);
    const [llmModel, setLlmModel] = useState(() => {
        const stored = localStorage.getItem(LLM_MODEL_STORAGE_KEY) || '';
        return stored.trim() || DEFAULT_LLM_MODEL;
    });
    const [imageModel, setImageModel] = useState(() => {
        const stored = localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) || '';
        return stored.trim() || DEFAULT_IMAGE_MODEL;
    });
    const [creationInput, setCreationInput] = useState('');
    const [activeGameId, setActiveGameId] = useState<string | null>(null);
    const [savedGames, setSavedGames] = useState<SavedGameSummary[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [initImageRef, setInitImageRef] = useState<string | null>(null);
    const [initImagePreview, setInitImagePreview] = useState<string | null>(null);
    const [displayedNarrative, setDisplayedNarrative] = useState(''); // current_story
    const [story, setStory] = useState<StoryCheckpoint[]>([]);
    const [playerProfile, setPlayerProfile] = useState<PlayerProfile>(clonePlayerProfileValue(DEFAULT_PLAYER_PROFILE));
    const [tasks, setTasks] = useState<TaskGuideItem[]>([]);
    const [nextChoices, setNextChoices] = useState<string[]>([]);
    const [isAutoPlayerEnabled, setIsAutoPlayerEnabled] = useState(false);
    const [autoPlayerStatus, setAutoPlayerStatus] = useState<AutoPlayerStatus>('idle');
    const [liveActionText, setLiveActionText] = useState('');
    const [liveActionSource, setLiveActionSource] = useState<'player' | 'agent' | null>(null);
    const [isBottomUiVisible, setIsBottomUiVisible] = useState(true);
    const [isLogOpen, setIsLogOpen] = useState(false); // full_story
    const [isStoryHoverOpen, setIsStoryHoverOpen] = useState(false);
    const [isStoryHoverClosable, setIsStoryHoverClosable] = useState(false);
    const [isDebugOpen, setIsDebugOpen] = useState(false);
    const [activeDebugTab, setActiveDebugTab] = useState<'dm' | 'visualdm' | 'world' | 'agent'>('dm');
    const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
    const [expandedHistoryConversationRounds, setExpandedHistoryConversationRounds] = useState<number[]>([]);
    const [isPlayerProfileOpen, setIsPlayerProfileOpen] = useState(false);
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
    const [isReplayActive, setIsReplayActive] = useState(false);
    const [replayViewState, setReplayViewState] = useState<ReplayViewState | null>(null);
    const [isStorageHydrated, setIsStorageHydrated] = useState(false);
    const [isGameplayLayoutTransitionReady, setIsGameplayLayoutTransitionReady] = useState(false);
    const [isLibraryScrollAtStart, setIsLibraryScrollAtStart] = useState(true);
    const [isLibraryScrollAtEnd, setIsLibraryScrollAtEnd] = useState(true);
    const [customKeyInput, setCustomKeyInput] = useState(localStorage.getItem('CUSTOM_GEMINI_API_KEY') || '');
    const [isApiBridgeEnabled, setIsApiBridgeEnabled] = useState(true);
    const [apiBridgeStatus, setApiBridgeStatus] = useState<ApiBridgeStatus>('disconnected');
    const [apiBridgeStatusMessage, setApiBridgeStatusMessage] = useState<string | null>(null);
    const [worldCoverImageIndex, setWorldCoverImageIndex] = useState(0);
    const checkpointIdRef = useRef(1);
    const submitEpochRef = useRef(0);
    const autoPlayerRunTokenRef = useRef(0);
    const autoPlayerTriggeredCheckpointIdRef = useRef<number | null>(null);
    const pendingAgentDebugRef = useRef<DebugInfo['agent'] | null>(null);
    const activeGameIdRef = useRef<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const saveFileInputRef = useRef<HTMLInputElement>(null);
    const gameplayInputRef = useRef<HTMLInputElement>(null);
    const logEndRef = useRef<HTMLDivElement>(null);
    const homeLibraryRef = useRef<HTMLDivElement>(null);
    const replayRunTokenRef = useRef(0);
    const replayUiSnapshotRef = useRef<ReplayUiSnapshot | null>(null);
    const apiBridgeClientRef = useRef<ApiBridgeClient | null>(null);
    const storyRef = useRef<StoryCheckpoint[]>([]);
    const isProcessingRef = useRef(false);
    const isReplayActiveRef = useRef(false);
    const isInitRef = useRef(true);
    const viewModeRef = useRef<ViewMode>('home');
    const currentImageRef = useRef<string | null>(null);
    const styleRef = useRef<string>(style);
    const currentLanguageRef = useRef<AppLanguage>(currentLanguage);
    const llmModelRef = useRef<string>(llmModel);
    const imageModelRef = useRef<string>(imageModel);
    const qualityRef = useRef<string>(quality);
    const initImageRefRef = useRef<string | null>(initImageRef);
    const isHomeView = viewMode === 'home';
    const isGameView = viewMode === 'game';
    const isAutoPlayerBusy = autoPlayerStatus !== 'idle';
    const activeStory = isReplayActive && replayViewState ? replayViewState.story : story;
    const latestStoryCheckpoint = activeStory.length > 0 ? activeStory[activeStory.length - 1] : null;
    const liveNarrative = isReplayActive && replayViewState
        ? replayViewState.liveNarrative
        : (latestStoryCheckpoint?.narrative || '');
    const displayedNarrativeValue = isReplayActive && replayViewState
        ? replayViewState.displayedNarrative
        : displayedNarrative;
    const liveNarrativeCharCount = getCharLength(liveNarrative);
    const activeCurrentImage = isReplayActive && replayViewState ? replayViewState.currentImage : currentImage;
    const activeNextImage = isReplayActive && replayViewState ? replayViewState.nextImage : nextImage;
    const activeTasks = isReplayActive && replayViewState ? replayViewState.tasks : tasks;
    const activeNextChoices = isReplayActive && replayViewState ? replayViewState.nextChoices : nextChoices;
    const activePlayerProfile = isReplayActive && replayViewState ? replayViewState.playerProfile : playerProfile;
    const activeDebugInfo = isReplayActive && replayViewState ? replayViewState.debugInfo : debugInfo;
    const activeInputValue = isReplayActive && replayViewState ? replayViewState.inputValue : inputValue;
    const activeLiveActionText = isReplayActive && replayViewState ? replayViewState.liveActionText : liveActionText;
    const activeLiveActionSource = isReplayActive && replayViewState ? replayViewState.liveActionSource : liveActionSource;
    const activeIsBottomUiVisible =
        isReplayActive && replayViewState ? replayViewState.isBottomUiVisible : isBottomUiVisible;
    const activeIsProcessing = isReplayActive && replayViewState ? replayViewState.isProcessing : isProcessing;
    const activeProcessingPhase = isReplayActive && replayViewState ? replayViewState.processingPhase : processingPhase;
    const isWorldCoverVisible = isInit && activeIsProcessing;
    const worldCoverImageSrc = WORLD_COVER_IMAGES.length > 0
        ? WORLD_COVER_IMAGES[worldCoverImageIndex % WORLD_COVER_IMAGES.length]
        : null;
    const isFullStoryOpen = isLogOpen;
    const shouldShowCurrentStory = isGameView && !isInit && Boolean(liveNarrative) && !activeIsBottomUiVisible;
    const isLatestNarrativeStreaming =
        !isReplayActive
        && Boolean((latestStoryCheckpoint as StoryCheckpoint | null)?.isStreaming);
    const gameplayHorizontalOffsetClass = isFullStoryOpen
        ? 'left-80 right-0 px-8 flex justify-center'
        : 'left-0 right-0 px-8 flex justify-center';
    const isLlmModelPreset = LLM_MODEL_OPTIONS.includes(llmModel);
    const isImageModelPreset = IMAGE_MODEL_OPTIONS.includes(imageModel);
    const llmModelSelectValue = isLlmModelPreset ? llmModel : CUSTOM_MODEL_OPTION_VALUE;
    const imageModelSelectValue = isImageModelPreset ? imageModel : CUSTOM_MODEL_OPTION_VALUE;
    const selectedStyleOption = STYLE_OPTIONS.find(option => option.value === style);
    const currentStyleLabel = selectedStyleOption ? t(selectedStyleOption.labelKey) : style;
    const homeBackgroundImageUrl = HOME_BACKGROUND_IMAGES_BY_STYLE[style] ?? null;
    const bridgeStatusLabelMap: Record<ApiBridgeStatus, string> = {
        disconnected: t('bridge.status.disconnected'),
        connecting: t('bridge.status.connecting'),
        connected: t('bridge.status.connected'),
        occupied: t('bridge.status.occupied'),
        error: t('bridge.status.error')
    };
    const apiBridgeStatusText = apiBridgeStatusMessage || bridgeStatusLabelMap[apiBridgeStatus];
    const isApiBridgeConnected = apiBridgeStatus === 'connected';
    const updateSavedGameSummary = (nextSummary: SavedGameSummary) => {
        setSavedGames(prev => sortSavedGames([
            nextSummary,
            ...prev.filter(item => item.id !== nextSummary.id)
        ]));
    };

    const getLatestStableCheckpoint = (value: StoryCheckpoint[]) => {
        for (let index = value.length - 1; index >= 0; index -= 1) {
            const checkpoint = value[index];
            if (checkpoint.isStreaming) continue;
            if (!checkpoint.imageSrc) continue;
            return { checkpoint, index };
        }
        return null;
    };

    const syncLibraryScrollState = () => {
        const container = homeLibraryRef.current;
        if (!container) {
            setIsLibraryScrollAtStart(true);
            setIsLibraryScrollAtEnd(true);
            return;
        }

        const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        setIsLibraryScrollAtStart(container.scrollLeft <= 1);
        setIsLibraryScrollAtEnd(container.scrollLeft >= maxScrollLeft - 1);
    };

    const scrollHomeLibraryByPage = (direction: 'left' | 'right') => {
        const container = homeLibraryRef.current;
        if (!container) return;
        const amount = Math.max(240, container.clientWidth * HOME_LIBRARY_SCROLL_RATIO);
        container.scrollBy({
            left: direction === 'left' ? -amount : amount,
            behavior: 'smooth'
        });
    };

    const cancelAutoPlayerRun = () => {
        autoPlayerRunTokenRef.current += 1;
        pendingAgentDebugRef.current = null;
        setAutoPlayerStatus('idle');
    };

    const updateAutoPlayerEnabled = (enabled: boolean) => {
        if (!enabled) {
            setIsAutoPlayerEnabled(false);
            cancelAutoPlayerRun();
            return;
        }

        autoPlayerTriggeredCheckpointIdRef.current = null;
        setIsAutoPlayerEnabled(true);
        setError(null);
    };

    const toggleAutoPlayer = () => {
        updateAutoPlayerEnabled(!isAutoPlayerEnabled);
    };

    const toggleApiBridgeEnabled = () => {
        setApiBridgeStatusMessage(null);
        const client = apiBridgeClientRef.current;
        if (!client) return;

        if (isApiBridgeConnected || apiBridgeStatus === 'connecting') {
            setIsApiBridgeEnabled(false);
            client.disconnect();
            return;
        }

        setIsApiBridgeEnabled(true);
        client.disconnect(false);
        client.connect(getApiBridgeWsUrl());
    };

    const stopReplay = (reason: ReplayStopReason = 'user') => {
        replayRunTokenRef.current += 1;
        setIsReplayActive(false);
        setReplayViewState(null);
        autoPlayerTriggeredCheckpointIdRef.current = null;

        const snapshot = replayUiSnapshotRef.current;
        replayUiSnapshotRef.current = null;
        if (snapshot) {
            setIsLogOpen(snapshot.isLogOpen);
            setIsStoryHoverOpen(snapshot.isStoryHoverOpen);
            setIsStoryHoverClosable(snapshot.isStoryHoverClosable);
        }

        if (reason === 'completed') {
            setIsLogOpen(false);
            setIsStoryHoverOpen(false);
            setIsStoryHoverClosable(false);
            const latestRealNarrative = story[story.length - 1]?.narrative || '';
            setDisplayedNarrative(latestRealNarrative);
        }
    };

    const startReplayFromCheckpoint = (checkpointIndex: number) => {
        if (isReplayActive || isProcessing) return;
        if (checkpointIndex < 0 || checkpointIndex >= story.length) return;

        const replayCheckpoints = cloneReplayCheckpoints(
            story
                .slice(checkpointIndex)
                .map(toReplayCheckpointSnapshot)
                .filter((item): item is ReplayCheckpointSnapshot => Boolean(item))
        );
        if (replayCheckpoints.length === 0) return;

        const initialReplayState = createReplayViewState(replayCheckpoints, playerProfile);
        if (!initialReplayState) return;

        replayUiSnapshotRef.current = {
            isLogOpen,
            isStoryHoverOpen,
            isStoryHoverClosable
        };

        setIsStoryHoverOpen(false);
        setIsStoryHoverClosable(false);
        setIsLogOpen(false);
        cancelAutoPlayerRun();
        autoPlayerTriggeredCheckpointIdRef.current = null;
        setError(null);

        const runToken = replayRunTokenRef.current + 1;
        replayRunTokenRef.current = runToken;
        setReplayViewState(initialReplayState);
        setIsReplayActive(true);

        void (async () => {
            const result = await runStoryReplay({
                checkpoints: replayCheckpoints,
                timings: {
                    startDelayMs: 2000,
                    narrativeTickMs: LIVE_NARRATIVE_TICK_MS,
                    postNarrativeDelayMs: 2000,
                    inputTypingTickMs: AUTO_PLAYER_TYPING_TICK_MS,
                    inputConfirmDelayMs: AUTO_PLAYER_CONFIRM_DELAY_MS,
                    renderDelayMs: 2000,
                    imageTransitionMs: 1500
                },
                onPatch: patch => {
                    if (replayRunTokenRef.current !== runToken) return;
                    setReplayViewState(prev => (prev ? applyReplayUiPatch(prev, patch) : prev));
                },
                shouldStop: () => replayRunTokenRef.current !== runToken
            });

            if (replayRunTokenRef.current !== runToken) return;
            stopReplay(result);
        })();
    };

    const resetToHomeView = () => {
        setViewMode('home');
        setIsInit(true);
        setCurrentImage(null);
        setNextImage(null);
        setStory([]);
        setTasks([]);
        setNextChoices([]);
        setPlayerProfile(clonePlayerProfileValue(DEFAULT_PLAYER_PROFILE));
        setDebugInfo(null);
        setDisplayedNarrative('');
        setInputValue('');
        setCreationInput('');
        setAgentBehaviorMode(DEFAULT_AGENT_BEHAVIOR_MODE);
        setActiveGameId(null);
        setIsBottomUiVisible(true);
        setIsLogOpen(false);
        setIsStoryHoverOpen(false);
        setIsStoryHoverClosable(false);
        setIsPlayerProfileOpen(false);
        setIsDebugOpen(false);
        setError(null);
        setIsProcessing(false);
        setProcessingPhase('dm');
        setInitImageRef(null);
        setInitImagePreview(null);
        setIsConfigOpen(false);
        setIsAutoPlayerEnabled(false);
        setAutoPlayerStatus('idle');
        setIsReplayActive(false);
        setReplayViewState(null);
        setLiveActionText('');
        setLiveActionSource(null);
        autoPlayerRunTokenRef.current += 1;
        replayRunTokenRef.current += 1;
        replayUiSnapshotRef.current = null;
        autoPlayerTriggeredCheckpointIdRef.current = null;
        pendingAgentDebugRef.current = null;
        checkpointIdRef.current = 1;
        activeGameIdRef.current = null;
        setPlayerProfileState(DEFAULT_PLAYER_PROFILE);
        setTaskState([]);
    };

    useEffect(() => {
        activeGameIdRef.current = activeGameId;
    }, [activeGameId]);

    useEffect(() => {
        storyRef.current = story;
    }, [story]);

    useEffect(() => {
        isProcessingRef.current = isProcessing;
    }, [isProcessing]);

    useEffect(() => {
        isReplayActiveRef.current = isReplayActive;
    }, [isReplayActive]);

    useEffect(() => {
        isInitRef.current = isInit;
    }, [isInit]);

    useEffect(() => {
        viewModeRef.current = viewMode;
    }, [viewMode]);

    useEffect(() => {
        currentImageRef.current = currentImage;
    }, [currentImage]);

    useEffect(() => {
        styleRef.current = style;
    }, [style]);

    useEffect(() => {
        currentLanguageRef.current = currentLanguage;
    }, [currentLanguage]);

    useEffect(() => {
        llmModelRef.current = llmModel;
    }, [llmModel]);

    useEffect(() => {
        imageModelRef.current = imageModel;
    }, [imageModel]);

    useEffect(() => {
        qualityRef.current = quality;
    }, [quality]);

    useEffect(() => {
        initImageRefRef.current = initImageRef;
    }, [initImageRef]);

    useEffect(() => {
        setStyleState(style);
    });

    useEffect(() => {
        localStorage.setItem(STYLE_STORAGE_KEY, toNonEmptyString(style, DEFAULT_STYLE));
    }, [style]);

    useEffect(() => {
        localStorage.setItem(LLM_MODEL_STORAGE_KEY, resolveModelName(llmModel, DEFAULT_LLM_MODEL));
    }, [llmModel]);

    useEffect(() => {
        localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, resolveModelName(imageModel, DEFAULT_IMAGE_MODEL));
    }, [imageModel]);

    useEffect(() => {
        const client = new ApiBridgeClient();
        apiBridgeClientRef.current = client;
        client.setStatusListener(event => {
            setApiBridgeStatus(event.status);
            setApiBridgeStatusMessage(event.status === 'error' ? (event.message ?? null) : null);
        });

        return () => {
            client.disconnect();
            apiBridgeClientRef.current = null;
        };
    }, []);

    useEffect(() => {
        const client = apiBridgeClientRef.current;
        if (!client) return;
        client.setCommandHandler((command, payload) => executeBridgeCommand(command, payload));
    }, [executeBridgeCommand]);

    useEffect(() => {
        const client = apiBridgeClientRef.current;
        if (!client) return;
        if (isApiBridgeEnabled) {
            client.connect(getApiBridgeWsUrl());
            return;
        }
        client.disconnect();
    }, [isApiBridgeEnabled]);

    useEffect(() => {
        syncLibraryScrollState();
    }, [savedGames]);

    useEffect(() => {
        if (!isHomeView) return;
        syncLibraryScrollState();
        const handleResize = () => syncLibraryScrollState();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [isHomeView]);

    useEffect(() => {
        if (!isHomeView || savedGames.length === 0) return;
        const container = homeLibraryRef.current;
        if (!container) return;

        const handleWheel = (event: WheelEvent) => {
            if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
            event.preventDefault();
            container.scrollBy({ left: event.deltaY, behavior: 'auto' });
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            container.removeEventListener('wheel', handleWheel);
        };
    }, [isHomeView, savedGames.length]);

    useEffect(() => {
        if (!isWorldCoverVisible) return;
        if (WORLD_COVER_IMAGES.length === 0) return;

        setWorldCoverImageIndex(prev => pickRandomIndex(WORLD_COVER_IMAGES.length, prev));
        const imageTimer = window.setInterval(() => {
            setWorldCoverImageIndex(prev => pickRandomIndex(WORLD_COVER_IMAGES.length, prev));
        }, WORLD_COVER_SWITCH_MS);

        return () => {
            window.clearInterval(imageTimer);
        };
    }, [isWorldCoverVisible]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const activeTagName = document.activeElement?.tagName;
            const isTextInputFocused = activeTagName === 'INPUT' || activeTagName === 'TEXTAREA';

            if (!isGameView) return;

            if (isReplayActive && (e.key === 'Escape' || e.code === 'Space' || e.key === ' ')) {
                e.preventDefault();
                stopReplay('user');
                return;
            }

            if (e.key.toLowerCase() === 'h' && !isTextInputFocused && !isInit) {
                setIsStoryHoverOpen(false);
                setIsStoryHoverClosable(false);
                setIsLogOpen(prev => !prev);
            }

            if (e.key === 'Escape' && isPlayerProfileOpen) {
                e.preventDefault();
                setIsPlayerProfileOpen(false);
                return;
            }

            if (isInit) return;

            if (e.key === 'Escape' && isBottomUiVisible) {
                e.preventDefault();
                setIsBottomUiVisible(false);
                gameplayInputRef.current?.blur();
                return;
            }

            if (isTextInputFocused) return;

            if ((e.code === 'Space' || e.key === ' ') && !isBottomUiVisible) {
                e.preventDefault();
                setIsBottomUiVisible(true);
                if (!isProcessing) {
                    requestAnimationFrame(() => {
                        gameplayInputRef.current?.focus();
                    });
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isBottomUiVisible, isGameView, isInit, isPlayerProfileOpen, isProcessing, isReplayActive]);

    useEffect(() => {
        if (isProcessing) return;
        setProcessingInputSnapshot('');
    }, [isProcessing]);

    useEffect(() => {
        if (!isGameView) return;
        if (isInit) return;
        if (isReplayActive) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (isLogOpen) return;
            if (e.clientX > STORY_EDGE_TRIGGER_WIDTH) return;

            setIsStoryHoverOpen(true);
            setIsStoryHoverClosable(false);
            setIsLogOpen(true);
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [isGameView, isInit, isLogOpen, isReplayActive]);

    useEffect(() => {
        if (!isGameView || isInit) {
            setIsGameplayLayoutTransitionReady(false);
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            setIsGameplayLayoutTransitionReady(true);
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [isGameView, isInit]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [story]);

    useEffect(() => {
        setExpandedHistoryConversationRounds([]);
    }, [debugInfo]);

    useEffect(() => {
        if (isReplayActive) return;
        if (!isGameView || isInit || !liveNarrative) {
            setDisplayedNarrative('');
            return;
        }

        if (!liveNarrative.startsWith(displayedNarrative)) {
            setDisplayedNarrative('');
        }
    }, [displayedNarrative, isGameView, isInit, isReplayActive, liveNarrative]);

    useEffect(() => {
        if (isReplayActive) return;
        if (!isGameView || isInit || !liveNarrative) return;
        if (displayedNarrative === liveNarrative) return;

        const timer = window.setTimeout(() => {
            setDisplayedNarrative(prev => {
                if (!liveNarrative.startsWith(prev)) return '';
                const nextLength = Math.min(getCharLength(prev) + 1, liveNarrativeCharCount);
                return truncateByChars(liveNarrative, nextLength);
            });
        }, LIVE_NARRATIVE_TICK_MS);

        return () => window.clearTimeout(timer);
    }, [displayedNarrative, isGameView, isInit, isReplayActive, liveNarrative, liveNarrativeCharCount]);

    useEffect(() => {
        const keyExists = Boolean(getConfiguredGeminiApiKey());
        setHasKey(keyExists);
        if (!keyExists) {
            setIsKeyModalOpen(true);
        }
    }, []);

    useEffect(() => {
        if (!isKeyModalOpen) return;
        setIsConfigOpen(false);
    }, [isKeyModalOpen]);

    const handleSaveCustomKey = () => {
        if (customKeyInput.trim()) {
            localStorage.setItem('CUSTOM_GEMINI_API_KEY', customKeyInput.trim());
            setHasKey(true);
            setIsKeyModalOpen(false);
        } else {
            localStorage.removeItem('CUSTOM_GEMINI_API_KEY');
            const keyExists = Boolean(getConfiguredGeminiApiKey());
            setHasKey(keyExists);
            setIsKeyModalOpen(!keyExists);
        }
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result as string;
                setInitImagePreview(base64);
                const base64Data = base64.split(',')[1];
                setInitImageRef(base64Data);
            };
            reader.readAsDataURL(file);
        }
    };

    const buildSavePayload = (overrides?: {
        isInit?: boolean;
        currentImage?: string | null;
        tasks?: TaskGuideItem[];
        nextChoices?: string[];
        story?: StoryCheckpoint[];
        debugInfo?: DebugInfo | null;
        checkpointId?: number;
        creationInput?: string;
    }): StorySaveFile => {
        setStyleState(style);
        const storySource = overrides?.story ?? story;
        return {
            version: SAVE_FILE_VERSION,
            savedAt: new Date().toISOString(),
            appState: {
                isInit: overrides?.isInit ?? isInit,
                quality,
                style,
                agentBehaviorMode,
                creationInput: toNonEmptyString(overrides?.creationInput ?? creationInput),
                currentImage: overrides?.currentImage ?? currentImage,
                tasks: overrides?.tasks ?? tasks,
                nextChoices: overrides?.nextChoices ?? nextChoices,
                story: storySource.map(checkpoint => ({
                    id: checkpoint.id,
                    userInput: checkpoint.userInput,
                    narrative: checkpoint.narrative,
                    playerProfile: checkpoint.playerProfile,
                    tasks: checkpoint.tasks,
                    nextChoices: checkpoint.nextChoices,
                    imageSrc: checkpoint.imageSrc,
                    debugInfo: checkpoint.debugInfo,
                    isStreaming: false
                })),
                debugInfo: overrides?.debugInfo ?? debugInfo,
                checkpointId: overrides?.checkpointId ?? checkpointIdRef.current
            },
            runtimeState: exportRuntimeState()
        };
    };

    const persistSavePayload = async (payload: StorySaveFile, forceGameId?: string) => {
        if (payload.appState.story.length === 0) return null;
        if (!payload.appState.creationInput.trim()) return null;
        const coverImage = payload.appState.story[0]?.imageSrc || payload.appState.currentImage;
        if (!coverImage) return null;

        const rawPayload = JSON.stringify(payload);
        await saveLatestAutosavePayload(rawPayload);
        const gameId = forceGameId || activeGameIdRef.current || createGameId();

        await upsertSavedGame({
            id: gameId,
            payload: rawPayload,
            savedAt: payload.savedAt,
            creationInput: payload.appState.creationInput,
            coverImage
        });

        activeGameIdRef.current = gameId;
        setActiveGameId(gameId);
        updateSavedGameSummary({
            id: gameId,
            savedAt: payload.savedAt,
            creationInput: payload.appState.creationInput,
            coverImage
        });

        return gameId;
    };

    const applySaveFile = (save: StorySaveFile) => {
        importRuntimeState(save.runtimeState);
        setStyleState(save.appState.style);
        const storyFromSave = save.appState.story.map(checkpoint => ({ ...checkpoint, isStreaming: false }));

        setStory(storyFromSave);
        setTasks(save.appState.tasks);
        setNextChoices(save.appState.nextChoices);
        checkpointIdRef.current = save.appState.checkpointId;
        setCurrentImage(save.appState.currentImage);
        setNextImage(null);
        setDebugInfo(save.appState.debugInfo);
        setQuality(save.appState.quality);
        setStyle(save.appState.style);
        setAgentBehaviorMode(save.appState.agentBehaviorMode);
        setCreationInput(save.appState.creationInput);
        setIsInit(save.appState.isInit);
        setIsBottomUiVisible(save.appState.isInit);
        setPlayerProfile(clonePlayerProfileValue(save.runtimeState.playerProfile));
        setIsPlayerProfileOpen(false);
        setIsStoryHoverOpen(false);
        setIsStoryHoverClosable(false);
        setIsLogOpen(false);
        setIsDebugOpen(false);
        setInitImageRef(null);
        setInitImagePreview(null);
        setError(null);
        setIsProcessing(false);
        setProcessingPhase('dm');
        setIsReplayActive(false);
        setReplayViewState(null);
        replayRunTokenRef.current += 1;
        replayUiSnapshotRef.current = null;
        setIsAutoPlayerEnabled(false);
        setAutoPlayerStatus('idle');
        setLiveActionText('');
        setLiveActionSource(null);
        autoPlayerRunTokenRef.current += 1;
        autoPlayerTriggeredCheckpointIdRef.current = null;
        pendingAgentDebugRef.current = null;
        setPlayerProfileState(save.runtimeState.playerProfile);
        setTaskState(save.appState.tasks);

        if (storyFromSave.length > 0) {
            restoreToCheckpoint(storyFromSave.length);
        }
    };

    const handleExportSave = () => {
        if (isProcessing || story.length === 0) return;
        if (!creationInput.trim()) return;
        const payload = buildSavePayload();
        const timestamp = payload.savedAt.replace(/[:.]/g, '-');
        triggerJsonDownload(payload, 'openword-save', timestamp);
    };

    const handleExportAllSaves = async () => {
        if (isProcessing || isReplayActive) return;
        if (savedGames.length === 0) return;

        try {
            const exportedAt = new Date().toISOString();
            const header = `{"version":${BATCH_SAVE_FILE_VERSION},"exportedAt":${JSON.stringify(exportedAt)},"saves":[`;
            const footer = ']}';
            const parts: BlobPart[] = [header];
            let appendedCount = 0;

            for (const summary of savedGames) {
                const rawPayload = await loadSavedGamePayload(summary.id);
                if (!rawPayload) continue;

                try {
                    // Validate save payload; skip broken saves but continue exporting others.
                    parseSaveFile(rawPayload);
                    const entry = `{"id":${JSON.stringify(summary.id)},"savedAt":${JSON.stringify(summary.savedAt)},"creationInput":${JSON.stringify(summary.creationInput)},"coverImage":${JSON.stringify(summary.coverImage)},"save":${rawPayload}}`;
                    const entryWithComma = appendedCount > 0 ? `,${entry}` : entry;
                    parts.push(entryWithComma);
                    appendedCount += 1;
                } catch (error) {
                    console.warn(`Skip invalid save payload: ${summary.id}`, error);
                }
            }

            if (appendedCount === 0) {
                setError(t('errors.exportBatchSaveFailed'));
                return;
            }
            parts.push(footer);
            const timestamp = exportedAt.replace(/[:.]/g, '-');
            triggerJsonPartsDownload(parts, 'openword-saves-batch', timestamp);
        } catch (error) {
            console.error(error);
            setError(t('errors.exportBatchSaveFailed'));
        }
    };

    const handleImportClick = () => {
        if (isProcessing) return;
        saveFileInputRef.current?.click();
    };

    const handleOpenKeyConfig = () => {
        setIsConfigOpen(false);
        setIsKeyModalOpen(true);
    };

    const handleImportSave = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        try {
            const rawText = await file.text();
            const parsed = JSON.parse(rawText) as unknown;

            if (isBatchSavePackage(parsed)) {
                const importedSummaries: SavedGameSummary[] = [];
                const importedIds = new Set<string>();
                let latestImported: { gameId: string; save: StorySaveFile; savedAt: string } | null = null;

                for (const item of parsed.saves) {
                    if (!isRecord(item) || !isRecord(item.save)) {
                        continue;
                    }

                    const rawEntryId = typeof item.id === 'string' ? item.id.trim() : '';
                    const gameId = rawEntryId || createGameId();

                    try {
                        const save = item.save as unknown as StorySaveFile;
                        const savedAt =
                            typeof item.savedAt === 'string' && item.savedAt.trim()
                                ? item.savedAt
                                : typeof save.savedAt === 'string' && save.savedAt.trim()
                                    ? save.savedAt
                                    : new Date().toISOString();
                        const creationInput =
                            typeof item.creationInput === 'string' && item.creationInput.trim()
                                ? item.creationInput
                                : typeof save.appState?.creationInput === 'string'
                                    ? save.appState.creationInput
                                    : '';
                        const coverImage =
                            typeof item.coverImage === 'string' && item.coverImage
                                ? item.coverImage
                                : save.appState?.story?.[0]?.imageSrc || save.appState?.currentImage;
                        if (!coverImage || !creationInput.trim()) {
                            continue;
                        }

                        await upsertSavedGame({
                            id: gameId,
                            payload: JSON.stringify(save),
                            savedAt,
                            creationInput,
                            coverImage
                        });

                        const summary: SavedGameSummary = {
                            id: gameId,
                            savedAt,
                            creationInput,
                            coverImage
                        };
                        importedSummaries.push(summary);
                        importedIds.add(gameId);

                        if (!latestImported || new Date(savedAt).getTime() >= new Date(latestImported.savedAt).getTime()) {
                            latestImported = {
                                gameId,
                                save,
                                savedAt
                            };
                        }
                    } catch (error) {
                        console.warn('Skip invalid batch save entry.', error);
                    }
                }

                if (importedSummaries.length === 0 || !latestImported) {
                    throw new Error('No valid saves found in batch file.');
                }

                setSavedGames(prev => sortSavedGames([
                    ...prev.filter(item => !importedIds.has(item.id)),
                    ...importedSummaries
                ]));
                applySaveFile(latestImported.save);
                setActiveGameId(latestImported.gameId);
                activeGameIdRef.current = latestImported.gameId;
                setViewMode('game');
                return;
            }

            const save = parseSaveFileUnchecked(rawText);
            applySaveFile(save);
            const importedGameId = createGameId();
            setActiveGameId(importedGameId);
            activeGameIdRef.current = importedGameId;
            setViewMode('game');
        } catch (err: any) {
            console.error(err);
            setError(t('errors.importSaveFailed'));
        }
    };

    useEffect(() => {
        let cancelled = false;

        const hydrateSavedGames = async () => {
            try {
                if (cancelled) return;
                const games = await listSavedGames();
                if (cancelled) return;
                setSavedGames(sortSavedGames(games));
            } catch (err) {
                console.warn(t('errors.saveReadFailed'), err);
            } finally {
                if (!cancelled) {
                    setIsStorageHydrated(true);
                }
            }
        };

        hydrateSavedGames();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!isStorageHydrated) return;
        if (isReplayActive) return;
        if (isProcessing) return;
        if (story.length === 0) return;
        if (story.some(checkpoint => checkpoint.isStreaming)) return;
        if (!creationInput.trim()) return;

        const timer = window.setTimeout(() => {
            const payload = buildSavePayload();
            persistSavePayload(payload).catch(err => {
                console.warn('Autosave write failed.', err);
            });
        }, AUTOSAVE_DEBOUNCE_MS);

        return () => {
            window.clearTimeout(timer);
        };
    }, [
        isStorageHydrated,
        isReplayActive,
        isProcessing,
        story,
        isInit,
        quality,
        style,
        agentBehaviorMode,
        currentImage,
        tasks,
        nextChoices,
        debugInfo,
        creationInput
    ]);

    const handleOpenSavedGame = async (gameId: string, options?: { throwOnError?: boolean }) => {
        if (!gameId) {
            if (options?.throwOnError) {
                throw toBridgeError('INVALID_INPUT', 'game_id is required.');
            }
            return;
        }
        if (isProcessing) {
            if (options?.throwOnError) {
                throw toBridgeError('BUSY', t('bridge.errors.busy'));
            }
            return;
        }

        try {
            const rawPayload = await loadSavedGamePayload(gameId);
            if (!rawPayload) {
                throw toBridgeError('NOT_FOUND', t('save.notFound'));
            }

            const save = parseSaveFileUnchecked(rawPayload);
            submitEpochRef.current += 1;
            applySaveFile(save);
            setActiveGameId(gameId);
            activeGameIdRef.current = gameId;
            setViewMode('game');
        } catch (err: any) {
            console.error(err);
            setError(t('errors.loadSavedGameFailed'));
            if (options?.throwOnError) {
                if (err instanceof ApiBridgeClientError) {
                    throw err;
                }
                throw toBridgeError('INTERNAL_ERROR', t('errors.loadSavedGameFailed'));
            }
        }
    };

    const handleDeleteSavedGame = async (gameId: string) => {
        if (!gameId || isProcessing) return;

        try {
            await deleteSavedGame(gameId);
            setSavedGames(prev => prev.filter(item => item.id !== gameId));

            if (activeGameIdRef.current === gameId) {
                activeGameIdRef.current = null;
                setActiveGameId(null);
            }
        } catch (err: any) {
            console.error(err);
            setError(t('errors.deleteSavedGameFailed'));
        }
    };

    const handleReturnHome = async () => {
        if (isReplayActive) {
            stopReplay('cancelled');
        }

        const isDiscardingInFlight = isProcessing;
        if (isDiscardingInFlight) {
            const confirmed = window.confirm(t('errors.discardInFlightConfirm'));
            if (!confirmed) return;
        }

        submitEpochRef.current += 1;
        let payloadToSave: StorySaveFile | null = null;

        if (story.length > 0) {
            if (isDiscardingInFlight) {
                const stableStory = story.filter(checkpoint => !checkpoint.isStreaming && !!checkpoint.imageSrc);
                const stableMeta = getLatestStableCheckpoint(stableStory);
                if (stableMeta) {
                    const latestStableCheckpoint = stableMeta.checkpoint;
                    const stableTasks = latestStableCheckpoint.tasks || [];
                    const stableNextChoices = normalizeChoiceList(latestStableCheckpoint.nextChoices);
                    const stableProfile =
                        latestStableCheckpoint.playerProfile
                        || exportRuntimeState().playerProfile
                        || DEFAULT_PLAYER_PROFILE;

                    restoreToCheckpoint(stableStory.length);
                    setPlayerProfileState(stableProfile);
                    setTaskState(stableTasks);

                    payloadToSave = buildSavePayload({
                        isInit: false,
                        story: stableStory,
                        currentImage: latestStableCheckpoint.imageSrc || null,
                        tasks: stableTasks,
                        nextChoices: stableNextChoices,
                        debugInfo: latestStableCheckpoint.debugInfo ?? null
                    });
                }
            } else if (!story.some(checkpoint => checkpoint.isStreaming)) {
                payloadToSave = buildSavePayload();
            }
        }

        if (payloadToSave) {
            try {
                await persistSavePayload(payloadToSave);
            } catch (err) {
                console.warn('Failed to save before returning home.', err);
            }
        }

        resetToHomeView();
    };

    const getBestAspectRatio = () => {
        const ratio = window.innerWidth / window.innerHeight;
        const supportedRatios = [
            { str: '16:9', val: 16/9 },
            { str: '4:3', val: 4/3 },
            { str: '1:1', val: 1 },
            { str: '3:4', val: 3/4 },
            { str: '9:16', val: 9/16 },
            { str: '4:1', val: 4/1 },
            { str: '1:4', val: 1/4 }
        ];
        let best = supportedRatios[0];
        let minDiff = Math.abs(ratio - best.val);
        for (const r of supportedRatios) {
            const diff = Math.abs(ratio - r.val);
            if (diff < minDiff) {
                minDiff = diff;
                best = r;
            }
        }
        return best.str;
    };

    const submitAction = async (
        rawActionText: string,
        source: 'player' | 'agent' = 'player',
        options: SubmitActionOptions = {}
    ): Promise<SubmitActionResult | undefined> => {
        const actionText = rawActionText.trim();
        if (!actionText) return;
        if (isProcessingRef.current || isReplayActiveRef.current) {
            if (options.throwOnError) {
                throw toBridgeError('BUSY', t('bridge.errors.busy'));
            }
            return;
        }

        const resolvedStyle = toNonEmptyString(options.styleOverride ?? styleRef.current, styleRef.current);
        setStyleState(resolvedStyle);
        if (resolvedStyle !== styleRef.current) {
            setStyle(resolvedStyle);
        }
        setProcessingInputSnapshot(actionText);
        const agentDebugForTurn = source === 'agent' ? pendingAgentDebugRef.current : null;
        if (source !== 'agent') {
            pendingAgentDebugRef.current = null;
        }
        setLiveActionText(actionText);
        setLiveActionSource(source);

        const submitEpoch = submitEpochRef.current + 1;
        submitEpochRef.current = submitEpoch;
        const isCreatingNewGame = options.forceInit ?? isInitRef.current;

        if (isCreatingNewGame) {
            setCreationInput(actionText);
            const presetGameId = options.presetGameId === undefined ? null : options.presetGameId;
            setActiveGameId(presetGameId);
            activeGameIdRef.current = presetGameId;
        }

        setIsProcessing(true);
        setProcessingPhase(isCreatingNewGame ? 'world' : 'dm');
        setError(null);
        if (!isCreatingNewGame) {
            setIsBottomUiVisible(false);
        }
        setInputValue('');
        const handlePhaseChange = (phase: ProcessingPhase) => setProcessingPhase(phase);
        let checkpointId: number | null = null;
        let isLiveActionCleared = false;

        const upsertStreamingCheckpoint = (narrative: string) => {
            if (submitEpochRef.current !== submitEpoch) return;
            if (!narrative || checkpointId === null) return;
            if (!isLiveActionCleared) {
                isLiveActionCleared = true;
                setLiveActionText('');
                setLiveActionSource(null);
            }

            setStory(prev => {
                const existingIndex = prev.findIndex(item => item.id === checkpointId);
                if (existingIndex === -1) {
                    return [...prev, {
                        id: checkpointId,
                        userInput: actionText,
                        narrative,
                        isStreaming: true
                    }];
                }

                const next = [...prev];
                next[existingIndex] = {
                    ...next[existingIndex],
                    narrative,
                    isStreaming: true
                };
                return next;
            });
        };

        try {
            let result;
            const currentRatio = getBestAspectRatio();
            const resolvedLlmModel = resolveModelName(llmModelRef.current, DEFAULT_LLM_MODEL);
            const resolvedImageModel = resolveModelName(imageModelRef.current, DEFAULT_IMAGE_MODEL);
            if (isCreatingNewGame) {
                setStory([]);
                setPlayerProfile(clonePlayerProfileValue(DEFAULT_PLAYER_PROFILE));
                setTasks([]);
                setNextChoices([]);
                checkpointIdRef.current = 1;
            }

            checkpointId = checkpointIdRef.current++;
            const handleNarrativeStream = (narrative: string) => upsertStreamingCheckpoint(narrative);

            if (isCreatingNewGame) {
                result = await initGame(
                    actionText,
                    initImageRefRef.current,
                    qualityRef.current,
                    resolvedStyle,
                    currentRatio,
                    handlePhaseChange,
                    handleNarrativeStream,
                    currentLanguageRef.current,
                    resolvedLlmModel,
                    resolvedImageModel
                );
                if (submitEpochRef.current !== submitEpoch) return;
                setIsInit(false);
                setIsBottomUiVisible(false);
                setViewMode('game');
            } else {
                const referenceImageBase64 = extractBase64FromDataUrl(currentImageRef.current);
                result = await processAction(
                    actionText,
                    currentRatio,
                    handlePhaseChange,
                    handleNarrativeStream,
                    referenceImageBase64,
                    currentLanguageRef.current,
                    resolvedLlmModel,
                    resolvedImageModel
                );
                if (submitEpochRef.current !== submitEpoch) return;
            }

            const {
                imageBase64,
                mimeType = 'image/jpeg',
                narrative,
                playerProfile: nextPlayerProfileRaw,
                tasks: nextTasks = [],
                nextChoices: nextChoicesFromDm = [],
                debugInfo: newDebugInfo
            } = result;
            const normalizedTasks = normalizeTaskList(nextTasks);
            const nextPlayerProfile =
                sanitizePlayerProfile(nextPlayerProfileRaw) || clonePlayerProfileValue(playerProfile);
            setPlayerProfile(clonePlayerProfileValue(nextPlayerProfile));
            const mergedDebugInfo = agentDebugForTurn
                ? { ...newDebugInfo, agent: agentDebugForTurn }
                : newDebugInfo;
            setDebugInfo(mergedDebugInfo);
            setTasks(normalizedTasks);
            setNextChoices(normalizeChoiceList(nextChoicesFromDm));

            const imgSrc = `data:${mimeType};base64,${imageBase64}`;
            const checkpoint: StoryCheckpoint = {
                id: checkpointId,
                userInput: actionText,
                narrative,
                playerProfile: clonePlayerProfileValue(nextPlayerProfile),
                tasks: normalizedTasks,
                nextChoices: normalizeChoiceList(nextChoicesFromDm),
                imageSrc: imgSrc,
                debugInfo: mergedDebugInfo,
                isStreaming: false
            };

            await new Promise<void>((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    if (submitEpochRef.current !== submitEpoch) {
                        resolve();
                        return;
                    }
                    setStory(prev => {
                        const existingIndex = prev.findIndex(item => item.id === checkpointId);
                        if (existingIndex === -1) {
                            return [...prev, checkpoint];
                        }
                        const next = [...prev];
                        next[existingIndex] = checkpoint;
                        return next;
                    });
                    setNextImage(imgSrc);
                    resolve();
                };
                img.onerror = () => {
                    if (submitEpochRef.current !== submitEpoch) {
                        resolve();
                        return;
                    }
                    reject(new Error(t('errors.imageLoadFailed')));
                };
                img.src = imgSrc;
            });

            pendingAgentDebugRef.current = null;
            return {
                narrative,
                playerProfile: clonePlayerProfileValue(nextPlayerProfile),
                imageDataUrl: imgSrc
            };
        } catch (err: any) {
            if (submitEpochRef.current !== submitEpoch) return;
            console.error(err);
            if (err?.debugInfo) {
                setDebugInfo(err.debugInfo);
            }
            if (checkpointId !== null) {
                setStory(prev => prev.map(item => (
                    item.id === checkpointId ? { ...item, isStreaming: false } : item
                )));
            }
            setError(err?.message || t('errors.actionFailed'));
            setIsProcessing(false);
            setProcessingPhase('dm');
            pendingAgentDebugRef.current = null;
            if (isCreatingNewGame) {
                setViewMode('home');
                setIsInit(true);
                setCurrentImage(null);
                setNextImage(null);
                setStory([]);
                setTasks([]);
                setNextChoices([]);
                setCreationInput('');
                setActiveGameId(null);
                activeGameIdRef.current = null;
                checkpointIdRef.current = 1;
                setInputValue(actionText);
            }
            if (options.throwOnError) {
                if (err instanceof ApiBridgeClientError) {
                    throw err;
                }
                if (err instanceof Error) {
                    throw err;
                }
                throw new Error(t('errors.actionFailed'));
            }
            return;
        }
    };

    const readPayloadString = (payload: Record<string, unknown>, fieldName: string) => {
        const value = payload[fieldName];
        if (typeof value !== 'string' || !value.trim()) {
            throw toBridgeError('INVALID_INPUT', `${fieldName} must be a non-empty string.`);
        }
        return value.trim();
    };

    const readOptionalPayloadString = (payload: Record<string, unknown>, fieldName: string) => {
        const value = payload[fieldName];
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value !== 'string' || !value.trim()) {
            throw toBridgeError('INVALID_INPUT', `${fieldName} must be a non-empty string when provided.`);
        }
        return value.trim();
    };

    const ensureCurrentGameId = () => {
        const current = activeGameIdRef.current;
        if (typeof current === 'string' && current.trim()) {
            return current.trim();
        }

        const nextGameId = createGameId();
        activeGameIdRef.current = nextGameId;
        setActiveGameId(nextGameId);
        return nextGameId;
    };

    const isGameLoaded = () => {
        return viewModeRef.current === 'game' && !isInitRef.current;
    };

    async function executeBridgeCommand(
        command: BridgeCommand,
        payload: BridgeCommandPayloadMap[BridgeCommand]
    ): Promise<BridgeCommandResultMap[BridgeCommand]> {
        if (command === 'show_history_games') {
            try {
                const games = await listSavedGames();
                const gameMap = games.reduce<Record<string, string>>((acc, game) => {
                    acc[game.id] = game.creationInput;
                    return acc;
                }, {});

                return { games: gameMap };
            } catch {
                throw toBridgeError('INTERNAL_ERROR', t('errors.saveReadFailed'));
            }
        }

        if (command === 'create_game') {
            if (!isRecord(payload)) {
                throw toBridgeError('INVALID_INPUT', 'Invalid create_game payload.');
            }

            const description = readPayloadString(payload, 'description');
            const styleFromPayload = readPayloadString(payload, 'style');
            const initImageBase64FromPayload = readOptionalPayloadString(payload, 'init_image_base64');

            if (isGameLoaded() && storyRef.current.length > 0) {
                try {
                    const currentPayload = buildSavePayload();
                    await persistSavePayload(currentPayload, activeGameIdRef.current || undefined);
                } catch (error) {
                    console.warn('Failed to persist current game before create_game.', error);
                }
            }

            const gameId = createGameId();

            initImageRefRef.current = initImageBase64FromPayload;
            setInitImageRef(initImageBase64FromPayload);
            setInitImagePreview(null);
            await submitAction(description, 'player', {
                forceInit: true,
                styleOverride: styleFromPayload,
                presetGameId: gameId,
                throwOnError: true
            });

            return { game_id: gameId };
        }

        if (command === 'load_game') {
            if (!isRecord(payload)) {
                throw toBridgeError('INVALID_INPUT', 'Invalid load_game payload.');
            }
            if (isProcessingRef.current || isReplayActiveRef.current) {
                throw toBridgeError('BUSY', t('bridge.errors.busy'));
            }

            const gameId = readPayloadString(payload, 'game_id');
            await handleOpenSavedGame(gameId, { throwOnError: true });
            return {};
        }

        if (command === 'get_current_game_state') {
            if (!isGameLoaded()) {
                throw toBridgeError('GAME_NOT_LOADED', t('bridge.errors.gameNotLoaded'));
            }
            if (isProcessingRef.current || isReplayActiveRef.current) {
                throw toBridgeError('BUSY', t('bridge.errors.busy'));
            }

            const runtimeState = exportRuntimeState();
            const latestStable = getLatestStableCheckpoint(storyRef.current);
            const narrative = latestStable?.checkpoint.narrative || '';
            const imageDataUrl = latestStable?.checkpoint.imageSrc || currentImageRef.current;
            if (!imageDataUrl) {
                throw toBridgeError('IMAGE_NOT_AVAILABLE', t('bridge.errors.imageNotAvailable'));
            }

            const currentGameId = ensureCurrentGameId();
            return {
                game_id: currentGameId,
                world_view: runtimeState.globalAnchor,
                narrative,
                player_profile: clonePlayerProfileValue(runtimeState.playerProfile),
                last_scene_image_data_url: imageDataUrl
            };
        }

        if (command === 'do_action') {
            if (!isRecord(payload)) {
                throw toBridgeError('INVALID_INPUT', 'Invalid do_action payload.');
            }
            if (!isGameLoaded()) {
                throw toBridgeError('GAME_NOT_LOADED', t('bridge.errors.gameNotLoaded'));
            }

            const description = readPayloadString(payload, 'description');
            const actionResult = await submitAction(description, 'player', { throwOnError: true });
            if (!actionResult) {
                throw toBridgeError('INTERNAL_ERROR', t('errors.actionFailed'));
            }

            const runtimeState = exportRuntimeState();
            const currentGameId = ensureCurrentGameId();
            return {
                game_id: currentGameId,
                world_view: runtimeState.globalAnchor,
                narrative: actionResult.narrative,
                player_profile: clonePlayerProfileValue(actionResult.playerProfile),
                last_scene_image_data_url: actionResult.imageDataUrl
            };
        }

        throw toBridgeError('INVALID_INPUT', `Unsupported command: ${String(command)}`);
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isReplayActive) return;
        const actionText = inputValue.trim();
        if (!actionText || isProcessing) return;
        if (isAutoPlayerBusy) {
            cancelAutoPlayerRun();
        }
        await submitAction(actionText, 'player');
    };

    const handleGameplayInputChange = (value: string) => {
        if (isReplayActive) return;
        if (autoPlayerStatus === 'typing') {
            cancelAutoPlayerRun();
        }
        setInputValue(value);
        setLiveActionText(value);
        setLiveActionSource(value ? 'player' : null);
    };

    const handleRestoreCheckpoint = (checkpointIndex: number) => {
        if (isProcessing || isReplayActive) return;
        const checkpoint = story[checkpointIndex];
        if (!checkpoint || !checkpoint.imageSrc || checkpoint.isStreaming) return;

        setStory(prev => prev.slice(0, checkpointIndex + 1));
        const checkpointTasks = checkpoint.tasks || [];
        const checkpointProfile = checkpoint.playerProfile || exportRuntimeState().playerProfile || DEFAULT_PLAYER_PROFILE;
        setTasks(checkpointTasks);
        setNextChoices(normalizeChoiceList(checkpoint.nextChoices));
        setPlayerProfile(clonePlayerProfileValue(checkpointProfile));
        setPlayerProfileState(checkpointProfile);
        setIsPlayerProfileOpen(false);
        setTaskState(checkpointTasks);
        setCurrentImage(checkpoint.imageSrc);
        setNextImage(null);
        setDebugInfo(checkpoint.debugInfo ?? null);
        setError(null);
        setIsInit(false);
        setIsBottomUiVisible(false);
        setIsProcessing(false);
        setProcessingPhase('dm');
        setLiveActionText('');
        setLiveActionSource(null);
        restoreToCheckpoint(checkpointIndex + 1);
    };

    useEffect(() => {
        if (!isAutoPlayerEnabled) return;
        if (isReplayActive) return;
        if (!isGameView || isInit) return;
        if (isProcessing) return;
        if (nextImage) return;
        if (isAutoPlayerBusy) return;

        const latestStable = getLatestStableCheckpoint(story);
        if (!latestStable) return;
        const { checkpoint } = latestStable;
        if (autoPlayerTriggeredCheckpointIdRef.current === checkpoint.id) return;
        autoPlayerTriggeredCheckpointIdRef.current = checkpoint.id;

        const runToken = autoPlayerRunTokenRef.current + 1;
        autoPlayerRunTokenRef.current = runToken;

        const runAutoPlayer = async () => {
            setAutoPlayerStatus('thinking');
            setIsBottomUiVisible(true);
            requestAnimationFrame(() => {
                gameplayInputRef.current?.focus();
            });

            try {
                const result = await generateAutoPlayerAction({
                    latestOptions: normalizeChoiceList(checkpoint.nextChoices || nextChoices),
                    currentProfile: checkpoint.playerProfile || playerProfile,
                    currentTasks: checkpoint.tasks || tasks,
                    latestNarrative: checkpoint.narrative,
                    latestImageBase64: extractBase64FromDataUrl(checkpoint.imageSrc || currentImage),
                    behaviorMode: agentBehaviorMode,
                    outputLanguage: currentLanguage,
                    llmModel: resolveModelName(llmModel, DEFAULT_LLM_MODEL)
                });

                if (autoPlayerRunTokenRef.current !== runToken) return;
                pendingAgentDebugRef.current = result.debug;
                setDebugInfo(prev => (prev ? { ...prev, agent: result.debug } : prev));
                const actionText = result.action.trim();
                if (!actionText) {
                    throw new Error('AutoPlayerAgent returned an empty action.');
                }

                setAutoPlayerStatus('typing');
                setInputValue('');
                setLiveActionText('');
                setLiveActionSource('agent');
                const characters = Array.from(actionText);
                for (const char of characters) {
                    if (autoPlayerRunTokenRef.current !== runToken) return;
                    await new Promise(resolve => window.setTimeout(resolve, AUTO_PLAYER_TYPING_TICK_MS));
                    if (autoPlayerRunTokenRef.current !== runToken) return;
                    setInputValue(prev => `${prev}${char}`);
                    setLiveActionText(prev => `${prev}${char}`);
                }

                if (autoPlayerRunTokenRef.current !== runToken) return;
                await new Promise(resolve => window.setTimeout(resolve, AUTO_PLAYER_CONFIRM_DELAY_MS));
                if (autoPlayerRunTokenRef.current !== runToken) return;
                setAutoPlayerStatus('idle');
                await submitAction(actionText, 'agent');
            } catch (err) {
                if (autoPlayerRunTokenRef.current !== runToken) return;
                console.warn('AutoPlayerAgent failed.', err);
                setAutoPlayerStatus('idle');
                setIsAutoPlayerEnabled(false);
                pendingAgentDebugRef.current = null;
                setError(t('errors.autoPlayerFailed'));
            }
        };

        void runAutoPlayer();
    }, [
        currentImage,
        agentBehaviorMode,
        currentLanguage,
        isAutoPlayerBusy,
        isAutoPlayerEnabled,
        isGameView,
        isInit,
        isReplayActive,
        isProcessing,
        llmModel,
        nextChoices,
        nextImage,
        playerProfile,
        story,
        t,
        tasks
    ]);

    const toggleHistoryConversationRound = (roundNumber: number) => {
        setExpandedHistoryConversationRounds(prev =>
            prev.includes(roundNumber)
                ? prev.filter(item => item !== roundNumber)
                : [...prev, roundNumber]
        );
    };

    const isHistoryConversationRoundExpanded = (roundNumber: number) => {
        return expandedHistoryConversationRounds.includes(roundNumber);
    };

    const renderDebugImagePreview = (block: DebugRequestBlock) => {
        if (!block.imageDataUrl) return null;
        return (
            <img
                src={block.imageDataUrl}
                alt={`${block.title} preview`}
                className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 object-contain max-h-56"
            />
        );
    };

    const renderDmPromptBlock = (block: DebugRequestBlock) => {
        if (block.key !== 'history_conversation') {
            return (
                <div key={block.key}>
                    <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{block.title}</h3>
                    <pre className="bg-black/30 p-3 rounded-lg whitespace-pre-wrap overflow-x-auto">{block.promptText}</pre>
                    {renderDebugImagePreview(block)}
                </div>
            );
        }

        const parsedBlock = parseHistoryConversationBlock(block.promptText);
        if (!parsedBlock) {
            return (
                <div key={block.key}>
                    <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{block.title}</h3>
                    <pre className="bg-black/30 p-3 rounded-lg whitespace-pre-wrap overflow-x-auto">{block.promptText}</pre>
                    {renderDebugImagePreview(block)}
                </div>
            );
        }

        return (
            <div key={block.key}>
                <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{block.title}</h3>
                <div className="bg-black/30 p-3 rounded-lg space-y-2">
                    {parsedBlock.opening && (
                        <pre className="whitespace-pre-wrap overflow-x-auto">{parsedBlock.opening}</pre>
                    )}
                    {parsedBlock.rounds.map(round => {
                        const isExpanded = isHistoryConversationRoundExpanded(round.roundNumber);
                        return (
                            <div key={`${block.key}-round-${round.roundNumber}`} className="border border-white/10 rounded-md overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => toggleHistoryConversationRound(round.roundNumber)}
                                    className="w-full px-2 py-1.5 flex items-center justify-between text-left hover:bg-white/5 transition-colors"
                                >
                                    <span className="text-zinc-300">{t('story.debugRound', { roundNumber: round.roundNumber })}</span>
                                    <ChevronDown
                                        className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                    />
                                </button>
                                {isExpanded && (
                                    <pre className="px-2 py-1.5 border-t border-white/10 whitespace-pre-wrap overflow-x-auto">
                                        {round.messageEntries.join('\n')}
                                    </pre>
                                )}
                            </div>
                        );
                    })}
                    {parsedBlock.closing && (
                        <pre className="whitespace-pre-wrap overflow-x-auto">{parsedBlock.closing}</pre>
                    )}
                </div>
                {renderDebugImagePreview(block)}
            </div>
        );
    };

    const currentDmDebugInfo = activeDebugInfo?.dm ?? null;
    const currentWorldDebugInfo = activeDebugInfo?.image ?? null;
    const currentAgentDebugInfo = activeDebugInfo?.agent ?? null;
    const isVisualDmRequestBlock = (block: DebugRequestBlock) => block.key.startsWith('visual_dm_');
    const dmRequestBlocks = currentDmDebugInfo
        ? currentDmDebugInfo.requestBlocks.filter(block => !isVisualDmRequestBlock(block))
        : [];
    const visualDmRequestBlocks = currentDmDebugInfo
        ? currentDmDebugInfo.requestBlocks.filter(isVisualDmRequestBlock)
        : [];
    const currentVisualDmOutput =
        currentDmDebugInfo && typeof currentDmDebugInfo.dmOutput === 'object' && currentDmDebugInfo.dmOutput !== null
            ? (currentDmDebugInfo.dmOutput as any).visualDm ?? null
            : null;

    const isDebugPanelVisible = isGameView && !isInit && isDebugOpen && Boolean(activeDebugInfo);

    if (!hasKey && !isKeyModalOpen) {
        return null; // Wait for checkKey to finish
    }

    const processingLabel = isInit
        ? (
            activeProcessingPhase === 'world'
                ? t('processing.world')
                : activeProcessingPhase === 'dm'
                    ? t('processing.dm')
                    : t('processing.render')
        )
        : (activeProcessingPhase === 'dm' ? t('processing.dm') : t('processing.render'));
    const autoPlayerToggleTitle = isAutoPlayerEnabled ? t('autoPlayer.disableTitle') : t('autoPlayer.enableTitle');
    const bottomHintText = activeIsProcessing
        ? processingLabel
        : (!isInit && !activeIsBottomUiVisible ? t('input.pressSpaceToInput') : null);
    const statusList = activePlayerProfile?.statuses || [];
    const skillList = activePlayerProfile?.skills || [];
    const itemList = activePlayerProfile?.items || [];
    const gameplayInputDisplayValue = isReplayActive
        ? activeInputValue
        : (activeIsProcessing && !isInit ? processingInputSnapshot : activeInputValue);

    return (
        <div className="relative w-full h-screen bg-black overflow-hidden font-sans">
            {/* Key Modal */}
            <AnimatePresence>
                {isKeyModalOpen && (
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                    >
                        <motion.div 
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 space-y-6 relative"
                        >
                            {hasKey && (
                                <button 
                                    onClick={() => setIsKeyModalOpen(false)}
                                    className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            )}
                            <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mx-auto">
                                <Key className="w-8 h-8 text-zinc-400" />
                            </div>
                            <div className="text-center">
                                <h1 className="text-2xl font-medium mb-2 text-white">{t('keyModal.title')}</h1>
                                <p className="text-zinc-400 text-sm">
                                    {t('keyModal.description')}
                                </p>
                            </div>
                            
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">{t('keyModal.option1')}</label>
                                    <div className="flex gap-2">
                                        <input 
                                            type="password" 
                                            value={customKeyInput}
                                            onChange={e => setCustomKeyInput(e.target.value)}
                                            placeholder={t('keyModal.inputPlaceholder')}
                                            className="flex-1 bg-black border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
                                        />
                                        <button 
                                            onClick={handleSaveCustomKey}
                                            disabled={!customKeyInput.trim()}
                                            className="bg-zinc-800 text-white px-4 py-3 rounded-xl hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {t('common.save')}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
            <input
                type="file"
                ref={saveFileInputRef}
                onChange={handleImportSave}
                accept="application/json,.json"
                className="hidden"
            />

            {isHomeView && (
                <div className="home-main-shell absolute inset-0 overflow-y-auto text-white">
                    <div className="home-main-shell-background" aria-hidden="true">
                        <AnimatePresence initial={false}>
                            {homeBackgroundImageUrl ? (
                                <motion.div
                                    key={homeBackgroundImageUrl}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.5, ease: 'easeInOut' }}
                                    className="home-main-shell-background-layer"
                                    style={{
                                        backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.22) 0%, rgba(0, 0, 0, 0.38) 100%), url(${homeBackgroundImageUrl})`
                                    }}
                                />
                            ) : null}
                        </AnimatePresence>
                    </div>
                    <div className="home-main-shell-content mx-auto w-full max-w-7xl px-6 pb-20 pt-24 md:px-10">
                        <div className="text-center">
                            <h1 className="home-main-title text-5xl md:text-7xl">
                                <span className="home-main-title-primary">{appName.primary}</span>
                                {appName.secondary ? (
                                    <>
                                        <span className="home-main-title-separator" aria-hidden="true">｜</span>
                                        <span className="home-main-title-secondary">{appName.secondary}</span>
                                    </>
                                ) : null}
                            </h1>
                        </div>

                        <div className="mt-16 mx-auto w-full max-w-3xl">
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleImageUpload}
                                accept="image/*"
                                className="hidden"
                            />
                            <form onSubmit={handleSubmit} className="space-y-7">
                                {initImagePreview && (
                                    <div className="relative inline-block">
                                        <img
                                            src={initImagePreview}
                                            alt={t('accessibility.referenceImage')}
                                            className="h-24 w-24 object-cover rounded-2xl border border-white/15 shadow-[0_24px_48px_rgba(0,0,0,0.45)]"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => { setInitImagePreview(null); setInitImageRef(null); }}
                                            className="absolute -top-2 -right-2 rounded-full border border-white/20 bg-black/80 p-1 text-white transition-colors hover:bg-black"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                )}
                                <div className="relative">
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="home-input-icon absolute left-6 top-1/2 z-10 -translate-y-1/2 transition-colors"
                                        title={t('navigation.uploadReferenceImage')}
                                    >
                                        <ImageIcon className="w-6 h-6" />
                                    </button>
                                    <input
                                        type="text"
                                        value={inputValue}
                                        onChange={e => setInputValue(e.target.value)}
                                        disabled={isProcessing}
                                        placeholder={t('home.worldInputPlaceholder')}
                                        className="home-input-field w-full py-4 pl-16 pr-20 text-base outline-none transition-colors"
                                    />
                                    <button
                                        type="submit"
                                        disabled={isProcessing || !inputValue.trim()}
                                        className="home-send-button absolute right-3 top-1/2 -translate-y-1/2 p-2.5 text-white transition-colors disabled:opacity-35"
                                    >
                                        {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                                    </button>
                                </div>
                                <div className="flex flex-wrap items-center justify-center gap-3">
                                    {STYLE_OPTIONS.map(option => (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => setStyle(option.value)}
                                            className={`home-style-pill text-sm transition-colors ${style === option.value ? 'home-style-pill-active' : ''}`}
                                        >
                                            {t(option.labelKey)}
                                        </button>
                                    ))}
                                </div>
                                {error && (
                                    <div className="text-sm text-center text-red-300 bg-red-950/40 border border-red-900/50 rounded-xl py-3 px-4">
                                        {error}
                                    </div>
                                )}
                            </form>
                        </div>

                        {savedGames.length > 0 && (
                            <section className="mt-20 mx-auto w-full max-w-5xl">
                                <div className="mb-4 flex items-center justify-between">
                                    <h2 className="home-recent-title text-2xl">{t('home.recentGames')}</h2>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => scrollHomeLibraryByPage('left')}
                                            disabled={isLibraryScrollAtStart}
                                            className="home-recent-nav-btn rounded-full p-2 transition-colors disabled:opacity-30"
                                            title={t('navigation.previousPage')}
                                        >
                                            <ChevronLeft className="w-4 h-4" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => scrollHomeLibraryByPage('right')}
                                            disabled={isLibraryScrollAtEnd}
                                            className="home-recent-nav-btn rounded-full p-2 transition-colors disabled:opacity-30"
                                            title={t('navigation.nextPage')}
                                        >
                                            <ChevronRight className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                                <div
                                    ref={homeLibraryRef}
                                    onScroll={syncLibraryScrollState}
                                    className="home-library-scrollbar flex gap-4 overflow-x-auto pb-2 pr-1 custom-scrollbar"
                                >
                                    {savedGames.map(game => (
                                        <div
                                            key={game.id}
                                            className="group relative w-[236px] shrink-0"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleOpenSavedGame(game.id)}
                                                className="home-recent-card w-full overflow-hidden text-left transition-colors"
                                            >
                                                <img
                                                    src={game.coverImage}
                                                    alt={game.creationInput}
                                                    className="h-32 w-full object-cover"
                                                />
                                                <div className="space-y-1.5 p-3">
                                                    <p className="truncate text-[14px] font-medium text-zinc-100">{game.creationInput}</p>
                                                    <p className="text-[11px] text-zinc-500">{formatSavedAt(game.savedAt, currentLanguage)}</p>
                                                </div>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={event => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    void handleDeleteSavedGame(game.id);
                                                }}
                                                className="home-recent-delete-btn absolute right-2 top-2 rounded-full p-2 opacity-0 transition-all duration-200 group-hover:opacity-100 focus-visible:opacity-100"
                                                aria-label={t('navigation.deleteHistory')}
                                                title={t('navigation.delete')}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}
                    </div>
                </div>
            )}

            <AnimatePresence mode="wait">
                {isWorldCoverVisible && (
                    <motion.div
                        className="absolute inset-0 z-30 overflow-hidden bg-black"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                    >
                        <AnimatePresence mode="wait">
                            {worldCoverImageSrc && (
                                <motion.img
                                    key={worldCoverImageSrc}
                                    src={worldCoverImageSrc}
                                    alt={t('accessibility.worldCover')}
                                    className="absolute inset-0 h-full w-full object-cover"
                                    initial={{ opacity: 0, scale: 1.05 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 1.02 }}
                                    transition={{ duration: 0.9, ease: 'easeOut' }}
                                />
                            )}
                        </AnimatePresence>
                        <div
                            className="absolute inset-0"
                            style={{ background: 'linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.12) 62%, rgba(0, 0, 0, 0.68) 100%)' }}
                        />
                        <div className="absolute bottom-20 left-1/2 z-10 w-full max-w-2xl -translate-x-1/2 px-4 md:bottom-24">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={processingLabel}
                                    className="mx-auto flex w-fit max-w-full items-center justify-center gap-2 rounded-full border border-white/25 bg-black/45 px-4 py-2 text-xs tracking-wide text-white/90 backdrop-blur-xl"
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -8 }}
                                    transition={{ duration: 0.35, ease: 'easeOut' }}
                                >
                                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                    <span>{processingLabel}</span>
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Base Image */}
            {isGameView && activeCurrentImage && (
                <div className="absolute inset-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-black">
                    <img 
                        src={activeCurrentImage} 
                        className="block w-full h-auto" 
                        alt={t('accessibility.currentView')}
                    />
                </div>
            )}
            
            {/* Fading Next Image */}
            <AnimatePresence>
                {isGameView && activeNextImage && (
                    <motion.div 
                        key={activeNextImage}
                        className="absolute inset-0 overflow-y-auto overflow-x-hidden custom-scrollbar z-10"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 1.5, ease: "easeInOut" }}
                        onAnimationComplete={() => {
                            if (isReplayActive) {
                                setReplayViewState(prev => {
                                    if (!prev || !prev.nextImage) return prev;
                                    return {
                                        ...prev,
                                        currentImage: prev.nextImage,
                                        nextImage: null,
                                        isProcessing: false,
                                        processingPhase: 'dm'
                                    };
                                });
                                return;
                            }

                            setCurrentImage(activeNextImage);
                            setNextImage(null);
                            setIsProcessing(false);
                            setProcessingPhase('dm');
                        }}
                    >
                        <img 
                            src={activeNextImage} 
                            className="block w-full h-auto" 
                            alt={t('accessibility.nextView')}
                        />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* current_story */}
            {shouldShowCurrentStory && (
                <div className={`absolute bottom-36 z-20 pointer-events-none transition-all duration-500 ${gameplayHorizontalOffsetClass}`}>
                    <div className="w-full max-w-3xl">
                        <p className="current-story-caption max-h-[38vh] overflow-hidden pr-2 text-sm sm:text-base font-medium leading-relaxed text-zinc-100 whitespace-pre-wrap">
                            {displayedNarrativeValue}
                            {(isLatestNarrativeStreaming || displayedNarrativeValue !== liveNarrative) ? (
                                <span className="inline-block w-1 h-3.5 align-middle ml-1 bg-zinc-200 animate-pulse" />
                            ) : null}
                        </p>
                        {activeLiveActionText && (
                            <p className="current-story-caption mt-2 max-h-[14vh] overflow-hidden text-sm sm:text-base font-medium leading-relaxed text-amber-100/90 whitespace-pre-wrap">
                                {activeLiveActionText}
                                {(activeLiveActionSource === 'agent' && autoPlayerStatus === 'typing') ? (
                                    <span className="inline-block w-1 h-3.5 align-middle ml-1 bg-amber-100/90 animate-pulse" />
                                ) : null}
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* full_story */}
            <AnimatePresence>
                {isGameView && !isInit && isLogOpen && (
                    <motion.div 
                        initial={{ x: -320, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: -320, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="absolute top-0 left-0 w-80 h-full bg-black/70 backdrop-blur-xl border-r border-white/10 p-6 flex flex-col z-30"
                        onAnimationComplete={() => {
                            if (!isStoryHoverOpen || !isLogOpen) return;
                            setIsStoryHoverClosable(true);
                        }}
                        onMouseLeave={() => {
                            if (!isStoryHoverOpen || !isStoryHoverClosable) return;
                            setIsStoryHoverOpen(false);
                            setIsStoryHoverClosable(false);
                            setIsLogOpen(false);
                        }}
                    >
                        <div className="flex items-center justify-between mb-6 shrink-0">
                            <h2 className="text-white/50 text-xs font-bold tracking-widest uppercase">{t('common.story')}</h2>
                            <button
                                onClick={() => {
                                    setIsStoryHoverOpen(false);
                                    setIsStoryHoverClosable(false);
                                    setIsLogOpen(false);
                                }}
                                className="text-white/50 hover:text-white transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-6 pr-2 custom-scrollbar">
                            {activeStory.map((checkpoint, i) => {
                                const checkpointIsStreaming =
                                    !isReplayActive
                                    && Boolean((checkpoint as StoryCheckpoint).isStreaming);
                                const isReplayDisabled =
                                    isProcessing || isReplayActive || !checkpoint.imageSrc || checkpointIsStreaming;

                                return (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        key={checkpoint.id}
                                        className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-3"
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                                {t('story.checkpoint', { index: i + 1 })}
                                            </span>
                                            <div className="flex items-center gap-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => startReplayFromCheckpoint(i)}
                                                    disabled={isReplayDisabled}
                                                    className="text-[10px] uppercase tracking-wider border border-white/20 text-white/70 hover:text-white hover:border-white/40 px-2 py-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    {t('common.replay')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRestoreCheckpoint(i)}
                                                    disabled={isReplayDisabled}
                                                    className="text-[10px] uppercase tracking-wider border border-white/20 text-white/70 hover:text-white hover:border-white/40 px-2 py-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    {t('common.restore')}
                                                </button>
                                            </div>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">{t('common.you')}</span>
                                            <p className="text-sm text-zinc-300 leading-relaxed">{checkpoint.userInput}</p>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">{t('common.dm')}</span>
                                            <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">{checkpoint.narrative}</p>
                                        </div>
                                        {checkpoint.imageSrc && (
                                            <img
                                                src={checkpoint.imageSrc}
                                                alt={t('story.checkpoint', { index: i + 1 })}
                                                className="w-full rounded-lg border border-white/10"
                                            />
                                        )}
                                    </motion.div>
                                );
                            })}
                            {activeStory.length === 0 && (
                                <div className="text-xs text-zinc-500 uppercase tracking-wider">
                                    {t('common.noStoryYet')}
                                </div>
                            )}
                            <div ref={logEndRef} className="h-4" />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* full_story trigger */}
            {isGameView && !isInit && (
                <div className="absolute top-6 left-6 z-20 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleReturnHome}
                        className="bg-black/40 backdrop-blur-md border border-white/10 text-white/80 hover:text-white p-2.5 rounded-xl transition-all hover:bg-black/60 flex items-center gap-2"
                        title={t('navigation.backHome')}
                    >
                        <ArrowLeft className="w-5 h-5" />
                        <span className="text-xs font-medium uppercase tracking-wider hidden sm:block">{t('common.home')}</span>
                    </button>
                    <button 
                        onClick={() => {
                            setIsStoryHoverOpen(false);
                            setIsStoryHoverClosable(false);
                            setIsLogOpen(true);
                        }}
                        className="bg-black/40 backdrop-blur-md border border-white/10 text-white/70 hover:text-white p-2.5 rounded-xl transition-all hover:bg-black/60 flex items-center gap-2"
                        title={t('navigation.openStory')}
                    >
                        <Menu className="w-5 h-5" />
                        <span className="text-xs font-medium uppercase tracking-wider hidden sm:block">{t('common.story')}</span>
                    </button>
                </div>
            )}

            {/* Config & Debug Controls */}
            <div className="absolute top-6 right-6 z-20 flex items-start gap-3">
                {isGameView && !isInit && (
                    <button
                        type="button"
                        onClick={toggleAutoPlayer}
                        className={`backdrop-blur-md border p-2.5 rounded-xl transition-all flex items-center justify-center ${
                            isAutoPlayerEnabled
                                ? 'bg-emerald-500/20 border-emerald-200/40 text-emerald-100 hover:bg-emerald-500/30'
                                : 'bg-black/40 border-white/10 text-white/70 hover:text-white hover:bg-black/60'
                        }`}
                        title={autoPlayerToggleTitle}
                    >
                        <Bot className={`w-5 h-5 ${isAutoPlayerBusy ? 'animate-pulse' : ''}`} />
                    </button>
                )}

                {isGameView && !isInit && (
                    <button 
                        onClick={() => setIsDebugOpen(prev => !prev)}
                        className="bg-black/40 backdrop-blur-md border border-white/10 text-white/70 hover:text-white p-2.5 rounded-xl transition-all hover:bg-black/60 flex items-center justify-center"
                        title={t('debug.openDm')}
                    >
                        <Bug className="w-5 h-5" />
                    </button>
                )}

                <div className="relative">
                    <button
                        onClick={() => setIsConfigOpen(prev => !prev)}
                        className="bg-black/40 backdrop-blur-md border border-white/10 text-white/80 hover:text-white p-2.5 rounded-xl transition-all hover:bg-black/60 flex items-center justify-center"
                        title={t('config.title')}
                    >
                        <Settings2 className="w-5 h-5" />
                    </button>

                    <AnimatePresence>
                        {isConfigOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                                className="absolute top-14 right-0 w-[24rem] bg-black/85 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl space-y-4"
                            >
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.quality')}</div>
                                    <div className="grid grid-cols-4 gap-1.5">
                                        {['512px', '1K', '2K', '4K'].map(q => (
                                            <button
                                                key={q}
                                                type="button"
                                                onClick={() => setQuality(q)}
                                                className={`px-2 py-1.5 text-[11px] rounded-lg transition-colors ${quality === q ? 'bg-white text-black font-medium' : 'text-white/70 bg-white/5 hover:bg-white/10'}`}
                                            >
                                                {q}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.style')}</div>
                                    <select
                                        value={style}
                                        onChange={event => setStyle(event.target.value)}
                                        className="w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 outline-none focus:border-white/35 transition-colors"
                                    >
                                        {STYLE_OPTIONS.map(option => (
                                            <option key={option.value} value={option.value} className="bg-zinc-900 text-zinc-100">
                                                {t(option.labelKey)}
                                            </option>
                                        ))}
                                    </select>
                                    <div className="mt-1 text-[10px] text-zinc-500">
                                        {t('config.currentStyle', { style: currentStyleLabel })}
                                    </div>
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.language')}</div>
                                    <select
                                        value={currentLanguage}
                                        onChange={event => void i18n.changeLanguage(resolveAppLanguage(event.target.value))}
                                        className="w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 outline-none focus:border-white/35 transition-colors"
                                    >
                                        {LANGUAGE_OPTIONS.map(option => (
                                            <option key={option.value} value={option.value} className="bg-zinc-900 text-zinc-100">
                                                {t(option.labelKey)}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.llmModel')}</div>
                                    <select
                                        value={llmModelSelectValue}
                                        onChange={event => {
                                            const nextValue = event.target.value;
                                            if (nextValue === CUSTOM_MODEL_OPTION_VALUE) {
                                                if (isLlmModelPreset) {
                                                    setLlmModel('');
                                                }
                                                return;
                                            }
                                            setLlmModel(nextValue);
                                        }}
                                        className="w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 outline-none focus:border-white/35 transition-colors"
                                    >
                                        {LLM_MODEL_OPTIONS.map(model => (
                                            <option key={model} value={model} className="bg-zinc-900 text-zinc-100">
                                                {model}
                                            </option>
                                        ))}
                                        <option value={CUSTOM_MODEL_OPTION_VALUE} className="bg-zinc-900 text-zinc-100">
                                            {t('config.customInput')}
                                        </option>
                                    </select>
                                    {llmModelSelectValue === CUSTOM_MODEL_OPTION_VALUE && (
                                        <input
                                            type="text"
                                            value={llmModel}
                                            onChange={event => setLlmModel(event.target.value)}
                                            placeholder={t('config.customLlmPlaceholder')}
                                            className="mt-2 w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 placeholder:text-zinc-500 outline-none focus:border-white/35 transition-colors"
                                        />
                                    )}
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.imageModel')}</div>
                                    <select
                                        value={imageModelSelectValue}
                                        onChange={event => {
                                            const nextValue = event.target.value;
                                            if (nextValue === CUSTOM_MODEL_OPTION_VALUE) {
                                                if (isImageModelPreset) {
                                                    setImageModel('');
                                                }
                                                return;
                                            }
                                            setImageModel(nextValue);
                                        }}
                                        className="w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 outline-none focus:border-white/35 transition-colors"
                                    >
                                        {IMAGE_MODEL_OPTIONS.map(model => (
                                            <option key={model} value={model} className="bg-zinc-900 text-zinc-100">
                                                {model}
                                            </option>
                                        ))}
                                        <option value={CUSTOM_MODEL_OPTION_VALUE} className="bg-zinc-900 text-zinc-100">
                                            {t('config.customInput')}
                                        </option>
                                    </select>
                                    {imageModelSelectValue === CUSTOM_MODEL_OPTION_VALUE && (
                                        <input
                                            type="text"
                                            value={imageModel}
                                            onChange={event => setImageModel(event.target.value)}
                                            placeholder={t('config.customImagePlaceholder')}
                                            className="mt-2 w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 placeholder:text-zinc-500 outline-none focus:border-white/35 transition-colors"
                                        />
                                    )}
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('config.agentBehaviorModeLabel')}</div>
                                    <input
                                        type="text"
                                        value={agentBehaviorMode}
                                        onChange={event => setAgentBehaviorMode(event.target.value)}
                                        placeholder={t('config.agentBehaviorModePlaceholder')}
                                        className="w-full bg-white/5 border border-white/15 text-white text-xs rounded-lg px-2.5 py-2 placeholder:text-zinc-500 outline-none focus:border-white/35 transition-colors"
                                    />
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsConfigOpen(false);
                                            handleImportClick();
                                        }}
                                        disabled={isProcessing || isReplayActive}
                                        className="text-xs text-zinc-200 border border-white/15 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                        {t('common.import')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsConfigOpen(false);
                                            void handleExportAllSaves();
                                        }}
                                        disabled={isProcessing || isReplayActive || savedGames.length === 0}
                                        className="text-xs text-zinc-200 border border-white/15 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                                    >
                                        <Download className="w-3.5 h-3.5" />
                                        {t('common.exportAll')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsConfigOpen(false);
                                            handleExportSave();
                                        }}
                                        disabled={isProcessing || isReplayActive || story.length === 0}
                                        className="text-xs text-zinc-200 border border-white/15 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                                    >
                                        <Download className="w-3.5 h-3.5" />
                                        {t('common.export')}
                                    </button>
                                </div>

                                <button
                                    type="button"
                                    onClick={toggleApiBridgeEnabled}
                                    className={`w-full text-xs border rounded-lg px-3 py-2 transition-colors flex items-center justify-center gap-1.5 ${
                                        isApiBridgeConnected
                                            ? 'text-emerald-100 border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                                            : 'text-rose-100 border-rose-400/40 bg-rose-500/10 hover:bg-rose-500/20'
                                    }`}
                                >
                                    <Plug className="w-3.5 h-3.5" />
                                    {isApiBridgeConnected ? t('bridge.disconnect') : t('bridge.connect')}
                                </button>
                                <div className="text-[10px] text-zinc-500">
                                    {t('bridge.statusLabel')}: {apiBridgeStatusText}
                                </div>

                                <button
                                    type="button"
                                    onClick={handleOpenKeyConfig}
                                    className="w-full text-xs text-zinc-200 border border-white/15 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition-colors flex items-center justify-center gap-1.5"
                                >
                                    <Key className="w-3.5 h-3.5" />
                                    {t('common.apiKey')}
                                </button>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Debug Panel */}
            <AnimatePresence>
                {isDebugPanelVisible && (
                    <motion.div 
                        initial={{ x: 400, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: 400, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="absolute top-0 right-0 w-96 h-full bg-black/80 backdrop-blur-xl border-l border-white/10 p-6 flex flex-col z-30"
                    >
                        <div className="flex items-center justify-between mb-4 shrink-0">
                            <h2 className="text-white/50 text-xs font-bold tracking-widest uppercase">{t('debug.title')}</h2>
                            <button onClick={() => setIsDebugOpen(false)} className="text-white/50 hover:text-white transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        
                        <div className="flex items-center gap-2 mb-6 border-b border-white/10 pb-2 shrink-0">
                            <button 
                                onClick={() => setActiveDebugTab('dm')}
                                className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase rounded-lg transition-colors ${activeDebugTab === 'dm' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'}`}
                            >
                                DM
                            </button>
                            <button 
                                onClick={() => setActiveDebugTab('visualdm')}
                                className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase rounded-lg transition-colors ${activeDebugTab === 'visualdm' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'}`}
                            >
                                VisualDM
                            </button>
                            <button 
                                onClick={() => setActiveDebugTab('world')}
                                className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase rounded-lg transition-colors ${activeDebugTab === 'world' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'}`}
                            >
                                Render
                            </button>
                            <button
                                onClick={() => setActiveDebugTab('agent')}
                                className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase rounded-lg transition-colors ${activeDebugTab === 'agent' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'}`}
                            >
                                AutoPlayer
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto space-y-6 pr-2 custom-scrollbar text-xs text-zinc-300">
                            {activeDebugTab === 'dm' && (
                                <>
                                    {!currentDmDebugInfo && (
                                        <div className="bg-white/5 p-3 rounded-lg text-zinc-400">{t('debug.noDmData')}</div>
                                    )}
                                    {currentDmDebugInfo && (
                                        <>
                                            {dmRequestBlocks.map(renderDmPromptBlock)}
                                            <div>
                                                <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{t('debug.dmOutputJson')}</h3>
                                                <pre className="bg-black/30 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                                                    {JSON.stringify(currentDmDebugInfo.dmOutput, null, 2)}
                                                </pre>
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                            {activeDebugTab === 'visualdm' && (
                                <>
                                    {(!currentDmDebugInfo || (visualDmRequestBlocks.length === 0 && !currentVisualDmOutput)) && (
                                        <div className="bg-white/5 p-3 rounded-lg text-zinc-400">{t('debug.noVisualDmData')}</div>
                                    )}
                                    {currentDmDebugInfo && (
                                        <>
                                            {visualDmRequestBlocks.map(renderDmPromptBlock)}
                                            {currentVisualDmOutput && (
                                                <div>
                                                    <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{t('debug.visualDmOutputJson')}</h3>
                                                    <pre className="bg-black/30 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                                                        {JSON.stringify(currentVisualDmOutput, null, 2)}
                                                    </pre>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                            {activeDebugTab === 'world' && (
                                <>
                                    {!currentWorldDebugInfo && (
                                        <div className="bg-white/5 p-3 rounded-lg text-zinc-400">{t('debug.noImageData')}</div>
                                    )}
                                    {currentWorldDebugInfo && (
                                        <>
                                            {currentWorldDebugInfo.requestBlocks.map(renderDmPromptBlock)}
                                        </>
                                    )}
                                </>
                            )}
                            {activeDebugTab === 'agent' && (
                                <>
                                    {!currentAgentDebugInfo && (
                                        <div className="bg-white/5 p-3 rounded-lg text-zinc-400">{t('debug.noAgentData')}</div>
                                    )}
                                    {currentAgentDebugInfo && (
                                        <>
                                            {currentAgentDebugInfo.requestBlocks.map(renderDmPromptBlock)}
                                            <div>
                                                <h3 className="text-zinc-500 font-bold mb-2 uppercase tracking-wider">{t('debug.agentOutput')}</h3>
                                                <pre className="bg-white/5 p-3 rounded-lg whitespace-pre-wrap overflow-x-auto">
                                                    {JSON.stringify({
                                                        outputAction: currentAgentDebugInfo.outputAction || '',
                                                        ...(currentAgentDebugInfo.rawModelText
                                                            ? { rawModelText: currentAgentDebugInfo.rawModelText }
                                                            : {})
                                                    }, null, 2)}
                                                </pre>
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Player Profile Modal */}
            <AnimatePresence>
                {isGameView && !isInit && isPlayerProfileOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 z-40 bg-black/70 backdrop-blur-sm p-4 flex items-end sm:items-center justify-center"
                        onClick={() => setIsPlayerProfileOpen(false)}
                    >
                        <motion.div
                            initial={{ y: 20, opacity: 0, scale: 0.98 }}
                            animate={{ y: 0, opacity: 1, scale: 1 }}
                            exit={{ y: 20, opacity: 0, scale: 0.98 }}
                            className="w-full max-w-lg bg-zinc-950 border border-white/15 rounded-2xl shadow-2xl overflow-hidden"
                            onClick={e => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('player.profile')}</div>
                                    <div className="text-white text-lg">{activePlayerProfile.playerName}</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setIsPlayerProfileOpen(false)}
                                    className="text-zinc-400 hover:text-white transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto custom-scrollbar">
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.status')}</div>
                                    <div className="space-y-3">
                                        {statusList.map((status, index) => (
                                            <div key={`${status.name}-${index}`} className="space-y-1.5">
                                                <div className="flex items-center justify-between text-xs text-zinc-200">
                                                    <span>{status.name}</span>
                                                    <span>{status.percent}%</span>
                                                </div>
                                                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full transition-all duration-500"
                                                        style={{ width: `${status.percent}%`, backgroundColor: status.color }}
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.skills')}</div>
                                    <div className="space-y-2">
                                        {skillList.length > 0 ? (
                                            skillList.map((skill, index) => (
                                                <div key={`${skill.name}-${index}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                                    <div className="text-sm text-white">{skill.name}</div>
                                                    <div className="text-xs text-zinc-300 mt-0.5 whitespace-pre-wrap">{skill.description}</div>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="text-xs text-zinc-500">{t('common.noSkills')}</div>
                                        )}
                                    </div>
                                </div>

                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{t('common.items')}</div>
                                    <div className="space-y-2">
                                        {itemList.length > 0 ? (
                                            itemList.map((item, index) => (
                                                <div key={`${item.name}-${index}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                                    <div className="text-sm text-white">{item.name}</div>
                                                    <div className="text-xs text-zinc-300 mt-0.5 whitespace-pre-wrap">{item.description}</div>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="text-xs text-zinc-500">{t('common.noItems')}</div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Input Area */}
            {isGameView && (
                <div className={`${isInit
                ? `${activeIsProcessing ? 'absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 z-20' : 'absolute top-[66%] left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 z-20'}`
                : `absolute bottom-6 z-20 ${isGameplayLayoutTransitionReady ? 'transition-all duration-500' : ''} ${gameplayHorizontalOffsetClass}`
            }`}>
                <div className={`w-full ${isInit ? 'max-w-3xl' : 'max-w-[58rem]'} relative`}>
                    {bottomHintText && (
                        <div className="pb-2 flex justify-center">
                            <div className="inline-flex items-center gap-2 text-xs text-white/70 tracking-wide px-4 py-2 rounded-full border border-white/15 bg-black/40 backdrop-blur-xl">
                                {activeIsProcessing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                <span>{bottomHintText}</span>
                            </div>
                        </div>
                    )}
                        <div className={`${!isInit ? 'flex items-end gap-3' : ''}`}>
                        {!isInit && activeIsBottomUiVisible && (
                            <button
                                type="button"
                                onClick={() => setIsPlayerProfileOpen(true)}
                                className="h-[52px] shrink-0 rounded-xl border border-white/20 bg-black/45 backdrop-blur-xl px-4 text-white/85 hover:text-white hover:bg-black/60 transition-colors shadow-2xl inline-flex items-center gap-2"
                                title={t('player.openProfile')}
                            >
                                <User className="w-4 h-4" />
                                <span className="text-xs tracking-wide whitespace-nowrap">{t('player.profile')}</span>
                            </button>
                        )}

                        <div className={`w-full ${!isInit ? 'max-w-3xl flex-1 min-w-0' : ''}`}>
                            {!isInit && activeIsBottomUiVisible && (
                                <div className="mb-2 bg-black/45 backdrop-blur-xl border-[0.5px] border-white/20 rounded-xl p-2.5 shadow-2xl">
                                    {activeTasks.length > 0 ? (
                                        <div className="space-y-1.5">
                                            {activeTasks.map((task, index) => (
                                                <div key={`${task.name}-${index}`} className="bg-white/5 border-[0.5px] border-white/20 rounded-md px-2.5 py-1.5">
                                                    <div className="text-xs text-white font-medium">
                                                        {`${task.type === 'side' ? t('task.sidePrefix') : t('task.mainPrefix')}${task.name}`}
                                                    </div>
                                                    <p className="text-[11px] text-zinc-300 mt-0.5 whitespace-pre-wrap">{task.content}</p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-xs text-zinc-500 px-1 py-1">{t('common.noActiveTasks')}</div>
                                    )}
                                </div>
                            )}

                            {!isInit && activeIsBottomUiVisible && activeNextChoices.length > 0 && (
                                <div className="mb-2">
                                    <div className="flex flex-wrap gap-1.5">
                                        {activeNextChoices.map((choice, index) => (
                                            <button
                                                key={`${choice}-${index}`}
                                                type="button"
                                                onClick={() => handleGameplayInputChange(choice)}
                                                disabled={activeIsProcessing}
                                                className="text-xs text-zinc-200 border border-white/20 bg-black/40 backdrop-blur-xl hover:bg-black/60 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                {choice}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {isInit && initImagePreview && (
                                <div className="mb-4 relative inline-block">
                                    <img src={initImagePreview} alt={t('accessibility.referenceImage')} className="h-24 w-24 object-cover rounded-xl border border-white/20 shadow-2xl" />
                                    <button 
                                        type="button"
                                        onClick={() => { setInitImagePreview(null); setInitImageRef(null); }}
                                        className="absolute -top-2 -right-2 bg-black/80 text-white p-1 rounded-full border border-white/20 hover:bg-black"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                            
                            {((isInit && !activeIsProcessing) || (!isInit && activeIsBottomUiVisible)) && (
                                <form onSubmit={handleSubmit} className="relative group">
                                    {isInit && (
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white transition-colors z-10"
                                            title={t('navigation.uploadReferenceImage')}
                                        >
                                            <ImageIcon className="w-5 h-5" />
                                        </button>
                                    )}
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        onChange={handleImageUpload}
                                        accept="image/*"
                                        className="hidden"
                                    />
                                    <input
                                        ref={gameplayInputRef}
                                        type="text"
                                        value={gameplayInputDisplayValue}
                                        onChange={e => handleGameplayInputChange(e.target.value)}
                                        disabled={activeIsProcessing}
                                        placeholder={isInit ? t('input.startPlaceholder') : t('input.nextPlaceholder')}
                                        className={`w-full bg-black/40 backdrop-blur-xl border border-white/10 text-white placeholder-white/40 rounded-xl py-3.5 ${isInit ? 'pl-12' : 'pl-4'} ${isInit ? 'pr-14' : 'pr-24'} outline-none transition-all shadow-2xl
                                        ${activeIsProcessing ? 'opacity-50' : 'focus:bg-black/60 focus:border-white/30 hover:border-white/20'}`}
                                    />
                                    {!isInit && (
                                        <button
                                            type="button"
                                            onClick={toggleAutoPlayer}
                                            className={`absolute right-12 top-1/2 -translate-y-1/2 p-2 rounded-lg border transition-all ${
                                                isAutoPlayerEnabled
                                                    ? 'bg-emerald-500/25 border-emerald-200/40 text-emerald-100 hover:bg-emerald-500/35'
                                                    : 'bg-white/5 border-white/20 text-white/75 hover:bg-white/15'
                                            }`}
                                            title={autoPlayerToggleTitle}
                                        >
                                            <Bot className={`w-4 h-4 ${isAutoPlayerBusy ? 'animate-pulse' : ''}`} />
                                        </button>
                                    )}
                                    <button
                                        type="submit"
                                        disabled={activeIsProcessing || !activeInputValue.trim()}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-2 bg-white/10 rounded-lg text-white hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 transition-all"
                                    >
                                        {activeIsProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                                    </button>
                                </form>
                            )}

                            {error && (
                                <div className="mt-4 text-red-400 text-sm text-center bg-red-950/50 backdrop-blur-md border border-red-900/50 rounded-xl py-3 px-4 shadow-2xl">
                                    {error}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                </div>
            )}
        </div>
    );
}
