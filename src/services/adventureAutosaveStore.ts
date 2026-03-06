const DB_NAME = 'openword_local_store_v1';
const DB_VERSION = 1;
const AUTOSAVE_STORE_NAME = 'autosave_payloads';
const SAVED_GAMES_STORE_NAME = 'saved_games';
const LATEST_AUTOSAVE_KEY = 'latest';
const LOCAL_STORAGE_AUTOSAVE_KEY = 'OPENWORD_AUTOSAVE_PAYLOAD_V1';
const LOCAL_STORAGE_SAVED_GAMES_KEY = 'OPENWORD_SAVED_GAMES_V1';

interface AutosaveEntry {
    id: string;
    payload: string;
    savedAt: string;
}

export interface SavedGameRecord {
    id: string;
    payload: string;
    savedAt: string;
    creationInput: string;
    coverImage: string;
}

export interface SavedGameSummary {
    id: string;
    savedAt: string;
    creationInput: string;
    coverImage: string;
}

const hasIndexedDb = () => {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const toSavedGameRecord = (value: unknown): SavedGameRecord | null => {
    if (!isRecord(value)) return null;
    if (typeof value.id !== 'string' || !value.id) return null;
    if (typeof value.payload !== 'string' || !value.payload) return null;
    if (typeof value.savedAt !== 'string' || !value.savedAt) return null;
    if (typeof value.creationInput !== 'string' || !value.creationInput.trim()) return null;
    if (typeof value.coverImage !== 'string' || !value.coverImage) return null;

    return {
        id: value.id,
        payload: value.payload,
        savedAt: value.savedAt,
        creationInput: value.creationInput,
        coverImage: value.coverImage
    };
};

const toSavedGameSummary = (value: SavedGameRecord): SavedGameSummary => {
    return {
        id: value.id,
        savedAt: value.savedAt,
        creationInput: value.creationInput,
        coverImage: value.coverImage
    };
};

const parseSavedGamesFromLocalStorage = (): SavedGameRecord[] => {
    const raw = localStorage.getItem(LOCAL_STORAGE_SAVED_GAMES_KEY);
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(toSavedGameRecord)
            .filter((item): item is SavedGameRecord => item !== null);
    } catch {
        return [];
    }
};

const writeSavedGamesToLocalStorage = (records: SavedGameRecord[]) => {
    localStorage.setItem(LOCAL_STORAGE_SAVED_GAMES_KEY, JSON.stringify(records));
};

const openAutosaveDatabase = async () => {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(AUTOSAVE_STORE_NAME)) {
                db.createObjectStore(AUTOSAVE_STORE_NAME, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(SAVED_GAMES_STORE_NAME)) {
                db.createObjectStore(SAVED_GAMES_STORE_NAME, { keyPath: 'id' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB。'));
    });
};

const withStore = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    executor: (store: IDBObjectStore) => Promise<T>
) => {
    const db = await openAutosaveDatabase();
    try {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        return await executor(store);
    } finally {
        db.close();
    }
};

export const saveLatestAutosavePayload = async (payload: string) => {
    if (!payload) return;

    if (!hasIndexedDb()) {
        localStorage.setItem(LOCAL_STORAGE_AUTOSAVE_KEY, payload);
        return;
    }

    const entry: AutosaveEntry = {
        id: LATEST_AUTOSAVE_KEY,
        payload,
        savedAt: new Date().toISOString()
    };

    await withStore(AUTOSAVE_STORE_NAME, 'readwrite', async store => {
        await new Promise<void>((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('自动存档写入失败。'));
        });
    });
};

export const loadLatestAutosavePayload = async () => {
    if (!hasIndexedDb()) {
        return localStorage.getItem(LOCAL_STORAGE_AUTOSAVE_KEY);
    }

    const entry = await withStore(AUTOSAVE_STORE_NAME, 'readonly', async store => {
        return await new Promise<AutosaveEntry | null>((resolve, reject) => {
            const request = store.get(LATEST_AUTOSAVE_KEY);
            request.onsuccess = () => resolve((request.result as AutosaveEntry | undefined) ?? null);
            request.onerror = () => reject(request.error ?? new Error('自动存档读取失败。'));
        });
    });

    return entry?.payload ?? null;
};

export const upsertSavedGame = async (entry: SavedGameRecord) => {
    if (!entry.id || !entry.payload || !entry.creationInput.trim() || !entry.coverImage) return;

    if (!hasIndexedDb()) {
        const current = parseSavedGamesFromLocalStorage();
        const next = [...current.filter(item => item.id !== entry.id), entry];
        writeSavedGamesToLocalStorage(next);
        return;
    }

    await withStore(SAVED_GAMES_STORE_NAME, 'readwrite', async store => {
        await new Promise<void>((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('历史游戏写入失败。'));
        });
    });
};

export const loadSavedGamePayload = async (gameId: string) => {
    if (!gameId) return null;

    if (!hasIndexedDb()) {
        const records = parseSavedGamesFromLocalStorage();
        return records.find(item => item.id === gameId)?.payload ?? null;
    }

    const entry = await withStore(SAVED_GAMES_STORE_NAME, 'readonly', async store => {
        return await new Promise<SavedGameRecord | null>((resolve, reject) => {
            const request = store.get(gameId);
            request.onsuccess = () => resolve(toSavedGameRecord(request.result));
            request.onerror = () => reject(request.error ?? new Error('历史游戏读取失败。'));
        });
    });

    return entry?.payload ?? null;
};

export const listSavedGames = async () => {
    if (!hasIndexedDb()) {
        return parseSavedGamesFromLocalStorage().map(toSavedGameSummary);
    }

    const records = await withStore(SAVED_GAMES_STORE_NAME, 'readonly', async store => {
        return await new Promise<SavedGameRecord[]>((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const result = Array.isArray(request.result) ? request.result : [];
                resolve(
                    result
                        .map(toSavedGameRecord)
                        .filter((item): item is SavedGameRecord => item !== null)
                );
            };
            request.onerror = () => reject(request.error ?? new Error('历史游戏列表读取失败。'));
        });
    });

    return records.map(toSavedGameSummary);
};

export const deleteSavedGame = async (gameId: string) => {
    if (!gameId) return;

    if (!hasIndexedDb()) {
        const records = parseSavedGamesFromLocalStorage();
        const next = records.filter(item => item.id !== gameId);
        writeSavedGamesToLocalStorage(next);
        return;
    }

    await withStore(SAVED_GAMES_STORE_NAME, 'readwrite', async store => {
        await new Promise<void>((resolve, reject) => {
            const request = store.delete(gameId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('历史游戏删除失败。'));
        });
    });
};
