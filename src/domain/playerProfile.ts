export interface PlayerStatus {
    name: string;
    color: string;
    percent: number;
}

export interface PlayerEntry {
    name: string;
    description: string;
}

export interface PlayerProfile {
    playerName: string;
    statuses: PlayerStatus[];
    skills: PlayerEntry[];
    items: PlayerEntry[];
}

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const toTrimmedString = (value: unknown) => {
    return typeof value === 'string' ? value.trim() : '';
};

const toPercent = (value: unknown) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num);
    return Math.min(100, Math.max(0, rounded));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const sanitizeStatus = (value: unknown): PlayerStatus | null => {
    if (!isRecord(value)) return null;

    const name = toTrimmedString(value.name);
    const color = toTrimmedString(value.color);
    const percent = toPercent(value.percent);

    if (!name || !color || percent === null) return null;
    if (!HEX_COLOR_REGEX.test(color)) return null;

    return {
        name,
        color,
        percent
    };
};

const sanitizeEntry = (value: unknown): PlayerEntry | null => {
    if (!isRecord(value)) return null;

    const name = toTrimmedString(value.name);
    const description = toTrimmedString(value.description);
    if (!name || !description) return null;

    return {
        name,
        description
    };
};

const sanitizeEntries = (value: unknown): PlayerEntry[] => {
    if (!Array.isArray(value)) return [];

    const deduped: PlayerEntry[] = [];
    const seen = new Set<string>();

    for (const item of value) {
        const next = sanitizeEntry(item);
        if (!next) continue;
        const key = `${next.name.toLowerCase()}::${next.description.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(next);
    }

    return deduped;
};

const sanitizeStatuses = (value: unknown): PlayerStatus[] => {
    if (!Array.isArray(value)) return [];

    const deduped: PlayerStatus[] = [];
    const seen = new Set<string>();

    for (const item of value) {
        const next = sanitizeStatus(item);
        if (!next) continue;
        const key = next.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(next);
    }

    return deduped;
};

export const sanitizePlayerProfile = (value: unknown): PlayerProfile | null => {
    if (!isRecord(value)) return null;

    const playerName = toTrimmedString(value.playerName);
    if (!playerName) return null;

    const statuses = sanitizeStatuses(value.statuses);
    if (statuses.length === 0) return null;

    return {
        playerName,
        statuses,
        skills: sanitizeEntries(value.skills),
        items: sanitizeEntries(value.items)
    };
};

export const clonePlayerProfile = (value: PlayerProfile): PlayerProfile => {
    return {
        playerName: value.playerName,
        statuses: value.statuses.map(status => ({ ...status })),
        skills: value.skills.map(skill => ({ ...skill })),
        items: value.items.map(item => ({ ...item }))
    };
};
