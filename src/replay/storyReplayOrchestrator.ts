import { PlayerProfile } from '../domain/playerProfile';
import { TaskGuideItem } from '../services/gameService';
import { DebugInfo } from '../types';

export interface ReplayCheckpointSnapshot {
    id: number;
    userInput: string;
    narrative: string;
    playerProfile: PlayerProfile;
    tasks: TaskGuideItem[];
    nextChoices: string[];
    imageSrc: string | null;
    debugInfo: DebugInfo | null;
}

export type ReplayProcessingPhase = 'dm' | 'render';

export interface ReplayViewState {
    story: ReplayCheckpointSnapshot[];
    displayedNarrative: string;
    liveNarrative: string;
    liveActionText: string;
    liveActionSource: 'player' | 'agent' | null;
    inputValue: string;
    isBottomUiVisible: boolean;
    isProcessing: boolean;
    processingPhase: ReplayProcessingPhase;
    currentImage: string | null;
    nextImage: string | null;
    tasks: TaskGuideItem[];
    nextChoices: string[];
    playerProfile: PlayerProfile;
    debugInfo: DebugInfo | null;
}

export interface ReplayTimings {
    startDelayMs: number;
    narrativeTickMs: number;
    postNarrativeDelayMs: number;
    inputTypingTickMs: number;
    inputConfirmDelayMs: number;
    renderDelayMs: number;
    imageTransitionMs: number;
}

export type ReplayStopReason = 'user' | 'completed' | 'cancelled';

export type ReplayUiPatch = Partial<ReplayViewState>;

interface RunStoryReplayOptions {
    checkpoints: ReplayCheckpointSnapshot[];
    timings: ReplayTimings;
    onPatch: (patch: ReplayUiPatch) => void;
    shouldStop: () => boolean;
}

const WAIT_SLICE_MS = 50;

const waitInterruptible = async (durationMs: number, shouldStop: () => boolean) => {
    const safeDurationMs = Math.max(0, Math.floor(durationMs));
    if (safeDurationMs === 0) return !shouldStop();

    let elapsed = 0;
    while (elapsed < safeDurationMs) {
        if (shouldStop()) return false;
        const waitMs = Math.min(WAIT_SLICE_MS, safeDurationMs - elapsed);
        await new Promise(resolve => window.setTimeout(resolve, waitMs));
        elapsed += waitMs;
    }

    return !shouldStop();
};

const clonePlayerProfile = (value: PlayerProfile): PlayerProfile => {
    return {
        playerName: value.playerName,
        statuses: value.statuses.map(status => ({ ...status })),
        skills: value.skills.map(skill => ({ ...skill })),
        items: value.items.map(item => ({ ...item }))
    };
};

const cloneTasks = (tasks: TaskGuideItem[]) => tasks.map(task => ({ ...task }));

const cloneChoices = (choices: string[]) => choices.map(choice => choice);

const cloneDebugInfo = (value: DebugInfo | null): DebugInfo | null => {
    if (!value) return null;
    return JSON.parse(JSON.stringify(value)) as DebugInfo;
};

const cloneCheckpoint = (checkpoint: ReplayCheckpointSnapshot): ReplayCheckpointSnapshot => {
    return {
        id: checkpoint.id,
        userInput: checkpoint.userInput,
        narrative: checkpoint.narrative,
        playerProfile: clonePlayerProfile(checkpoint.playerProfile),
        tasks: cloneTasks(checkpoint.tasks),
        nextChoices: cloneChoices(checkpoint.nextChoices),
        imageSrc: checkpoint.imageSrc || null,
        debugInfo: cloneDebugInfo(checkpoint.debugInfo)
    };
};

export const cloneReplayCheckpoints = (checkpoints: ReplayCheckpointSnapshot[]) => {
    return checkpoints.map(cloneCheckpoint);
};

export const createReplayViewState = (
    checkpoints: ReplayCheckpointSnapshot[],
    fallbackPlayerProfile: PlayerProfile
): ReplayViewState | null => {
    if (checkpoints.length === 0) return null;

    const safeCheckpoints = cloneReplayCheckpoints(checkpoints);
    const firstCheckpoint = safeCheckpoints[0];

    return {
        story: safeCheckpoints,
        displayedNarrative: '',
        liveNarrative: '',
        liveActionText: '',
        liveActionSource: null,
        inputValue: '',
        isBottomUiVisible: false,
        isProcessing: false,
        processingPhase: 'dm',
        currentImage: firstCheckpoint.imageSrc || null,
        nextImage: null,
        tasks: cloneTasks(firstCheckpoint.tasks),
        nextChoices: cloneChoices(firstCheckpoint.nextChoices),
        playerProfile: clonePlayerProfile(firstCheckpoint.playerProfile || fallbackPlayerProfile),
        debugInfo: cloneDebugInfo(firstCheckpoint.debugInfo)
    };
};

export const applyReplayUiPatch = (state: ReplayViewState, patch: ReplayUiPatch): ReplayViewState => {
    return {
        ...state,
        ...patch
    };
};

export const runStoryReplay = async ({ checkpoints, timings, onPatch, shouldStop }: RunStoryReplayOptions) => {
    if (checkpoints.length === 0) return 'completed' as const;

    const didWaitForStart = await waitInterruptible(timings.startDelayMs, shouldStop);
    if (!didWaitForStart) return 'cancelled' as const;

    for (let index = 0; index < checkpoints.length; index += 1) {
        if (shouldStop()) return 'cancelled' as const;

        const checkpoint = checkpoints[index];
        const nextCheckpoint = checkpoints[index + 1];

        onPatch({
            currentImage: checkpoint.imageSrc || null,
            nextImage: null,
            tasks: cloneTasks(checkpoint.tasks),
            nextChoices: cloneChoices(checkpoint.nextChoices),
            playerProfile: clonePlayerProfile(checkpoint.playerProfile),
            debugInfo: cloneDebugInfo(checkpoint.debugInfo),
            liveNarrative: checkpoint.narrative,
            displayedNarrative: '',
            liveActionText: '',
            liveActionSource: null,
            inputValue: '',
            isBottomUiVisible: false,
            isProcessing: false,
            processingPhase: 'dm'
        });

        let displayedNarrative = '';
        for (const character of Array.from(checkpoint.narrative)) {
            if (shouldStop()) return 'cancelled' as const;
            displayedNarrative = `${displayedNarrative}${character}`;
            onPatch({ displayedNarrative });
            const didCompleteTick = await waitInterruptible(timings.narrativeTickMs, shouldStop);
            if (!didCompleteTick) return 'cancelled' as const;
        }

        if (!nextCheckpoint) continue;

        const didWaitBeforeInput = await waitInterruptible(timings.postNarrativeDelayMs, shouldStop);
        if (!didWaitBeforeInput) return 'cancelled' as const;

        onPatch({
            isBottomUiVisible: true,
            liveActionText: '',
            liveActionSource: 'player',
            inputValue: ''
        });

        let typedAction = '';
        for (const character of Array.from(nextCheckpoint.userInput)) {
            if (shouldStop()) return 'cancelled' as const;
            typedAction = `${typedAction}${character}`;
            onPatch({
                inputValue: typedAction,
                liveActionText: typedAction,
                liveActionSource: 'player'
            });
            const didCompleteTick = await waitInterruptible(timings.inputTypingTickMs, shouldStop);
            if (!didCompleteTick) return 'cancelled' as const;
        }

        const didConfirm = await waitInterruptible(timings.inputConfirmDelayMs, shouldStop);
        if (!didConfirm) return 'cancelled' as const;

        onPatch({
            isBottomUiVisible: false,
            isProcessing: true,
            processingPhase: 'render',
            liveActionText: typedAction,
            liveActionSource: 'player'
        });

        const didRenderWait = await waitInterruptible(timings.renderDelayMs, shouldStop);
        if (!didRenderWait) return 'cancelled' as const;

        if (nextCheckpoint.imageSrc) {
            onPatch({ nextImage: nextCheckpoint.imageSrc });
            const didTransitionWait = await waitInterruptible(timings.imageTransitionMs, shouldStop);
            if (!didTransitionWait) return 'cancelled' as const;
        } else {
            onPatch({
                isProcessing: false,
                processingPhase: 'dm'
            });
        }
    }

    return 'completed' as const;
};
