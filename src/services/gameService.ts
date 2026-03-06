import {
    FunctionCallingConfigMode,
    GoogleGenAI,
    ThinkingLevel,
    type FunctionDeclaration
} from '@google/genai';
import { PlayerProfile, clonePlayerProfile, sanitizePlayerProfile } from '../domain/playerProfile';
import type { AppLanguage } from '../i18n/types';

export interface HistoryItem {
    role: 'user' | 'model';
    text: string;
}

export interface TaskGuideItem {
    name: string;
    content: string;
    type?: 'main' | 'side';
}

type ProcessingPhase = 'world' | 'dm' | 'render';
type SceneMode = 'continue' | 'transition';
type NarrativeStreamHandler = (narrative: string) => void;

interface DebugRequestBlock {
    key: string;
    title: string;
    promptText: string;
    imageDataUrl?: string;
}

type NormalizedFunctionCall = {
    name?: string;
    args?: Record<string, unknown>;
};

interface TellStoryResult {
    narrative: string;
    sceneMode: SceneMode;
    sceneSignature: string;
    keyObjectChanges: string;
    nextChoices: string[];
}

interface VisualDmResult {
    sceneDescription: string;
}

interface WorldCreationResult {
    worldInfo: string;
    referenceWork: string;
    playerProfile: PlayerProfile;
}

interface CreateWorldResult {
    worldInfo: string;
    referenceWork: string;
}

interface CreateCharacterResult {
    playerProfile: PlayerProfile;
}

interface PlayerProfileUpdateResult {
    playerProfile: PlayerProfile;
}

interface TaskManagerResult {
    tasks: TaskGuideItem[];
}

interface NextActionResult {
    action: string;
}

interface RequiredToolResult<T> {
    payload: T;
    functionCalls: NormalizedFunctionCall[];
    responseText: string;
}

interface OptionalTaskToolResult {
    payload: TaskManagerResult | null;
    functionCalls: NormalizedFunctionCall[];
    responseText: string;
}

interface DmOutputDebug {
    tellStory: TellStoryResult;
    visualDm?: {
        sceneDescription: string;
        rawModelText?: string;
    };
    worldCreator?: {
        systemInstruction: string;
        promptText: string;
        output: WorldCreationResult;
    };
    playerProfile: {
        updatedProfile: PlayerProfile;
        updated: boolean;
        toolCalled: boolean;
    };
    taskManager: {
        called: boolean;
        error: string | null;
    };
    tasksBefore: TaskGuideItem[];
    tasksAfter: TaskGuideItem[];
    tasksChanged: boolean;
    rawModelText?: {
        tellStory?: string;
        taskManager?: string;
    };
}

interface DmDebugPayload {
    requestBlocks: DebugRequestBlock[];
    dmOutput: DmOutputDebug;
}

type StageError = Error & {
    debugInfo?: {
        dm: {
            requestBlocks: DebugRequestBlock[];
            dmOutput: any;
        };
        image: {
            requestBlocks: DebugRequestBlock[];
        };
    };
    cause?: unknown;
};

export interface GameRuntimeState {
    history: HistoryItem[];
    globalAnchor: string;
    playerProfile: PlayerProfile;
    currentQuality: string;
    currentStyle: string;
    currentAspectRatio: string;
    currentReferenceWork?: string;
    activeTasks: TaskGuideItem[];
}

export interface AutoPlayerAgentInput {
    latestOptions: string[];
    currentProfile: PlayerProfile;
    currentTasks: TaskGuideItem[];
    latestNarrative: string;
    latestImageBase64?: string | null;
    behaviorMode?: string;
    outputLanguage?: AppLanguage;
    llmModel?: string;
}

export interface AutoPlayerAgentResult {
    action: string;
    debug: {
        requestBlocks: DebugRequestBlock[];
        outputAction: string;
        rawModelText?: string;
    };
}

let history: HistoryItem[] = [];
let globalAnchor: string = '';
let currentQuality: string = '1K';
let currentStyle: string = 'Minecraft';
let currentAspectRatio: string = '16:9';
let currentReferenceWork: string = '';
let activeTasks: TaskGuideItem[] = [];

const DM_MAX_OUTPUT_TOKENS = 1024;
const VISUAL_DM_MAX_OUTPUT_TOKENS = 768;
const DM_SCHEMA_RETRIES = 3;
const WORLD_CREATOR_MAX_OUTPUT_TOKENS = 1024;
const WORLD_CREATOR_THINKING_LEVEL = ThinkingLevel.LOW;
const AUTO_PLAYER_MAX_OUTPUT_TOKENS = 256;
const DM_NARRATIVE_MAX_CHARS = 100;
const NEXT_CHOICE_MIN_COUNT = 2;
const NEXT_CHOICE_MAX_COUNT = 3;
const NEXT_CHOICE_MAX_CHARS = 25;
const MAX_MAIN_TASKS = 1;
const MAX_SIDE_TASKS = 2;
const VISUAL_DM_SCENE_DESCRIPTION_BODY_PREFIX = 'First-person POV, you see';
const VISUAL_DM_SCENE_DESCRIPTION_PREFIX_PATTERN =
    /^(?:your|you)\s+are\s+(?:\{name\}|[^,\n]+),\s*first-person\s+pov,\s*you\s+see\b/i;

const SCENE_DESCRIPTION_PURPOSE_AND_FORMAT_SCHEMA_RULES =
    `Purpose and format: sceneDescription must depict the post-narrative result frame, i.e. what the scene looks like after narrative outcomes have occurred, not an in-progress process frame. It must accurately reflect resulting facial expressions, concrete actions/behaviors, and scene/state changes. Use English first-person format and start with "${VISUAL_DM_SCENE_DESCRIPTION_BODY_PREFIX} ...". Do not include player-name prefix; it is assembled by the system.`;
const SCENE_DESCRIPTION_COVERAGE_SCHEMA_RULES =
    'Coverage and structure: first determine currently visible and interactable entities/elements, then ensure sceneDescription covers all story-critical visible content. sceneDescription may include entities/elements grounded in narrative, prior history, world_info, reference_work, or reference image, but must not conflict with established continuity. Keep one paragraph and follow this order: scene overview and camera orientation; foreground details; midground details; background details; visible characters/creatures with concrete actions/states; key props/clues with spatial anchors; lighting/weather/atmosphere.';
const SCENE_DESCRIPTION_CHANGE_SCHEMA_RULES =
    'Change tracking: avoid static-only descriptions that miss key events. When a reference image is attached, treat it as the immediate previous frame. For each recurring character/object with a changed state, sceneDescription must explicitly state both a spatial anchor (left/right/foreground/background/near/far) and a concrete action or state delta (for example: "on the left, the monster spits a fireball"). Avoid vague wording such as "changed a little".';
const SCENE_DESCRIPTION_NAMING_SCHEMA_RULES =
    'Naming: if an active task involves a well-known or uniquely identifiable NPC and that NPC is visible in the current frame, sceneDescription must use the NPC\'s canonical name directly instead of generic labels (for example, write "Geralt of Rivia" rather than "a white-haired swordsman"). If identity is uncertain, do not invent names.';
const SCENE_MODE_SCHEMA_RULES =
    'When sceneMode=transition, narrative must clearly indicate the scene switch and key traits of the new scene, and sceneSignature must provide an English scene-traits summary. When sceneMode=continue, sceneSignature must be an empty string.';
const VISUAL_DM_CONTINUE_RULES =
    'sceneDescription must describe the full current frame first, then explicit this-turn visual deltas with spatial anchors. Focus on incremental updates and continuity in the same scene.';
const VISUAL_DM_TRANSITION_RULES =
    'sceneDescription must clearly depict a transitioned new scene after narrative outcome, preserve recurring-subject identity continuity, inherit style cues from reference image, and define the new composition explicitly.';

const CREATE_WORLD_TOOL_NAME = 'create_world';
const CREATE_CHARACTER_TOOL_NAME = 'create_character';
const TELL_STORY_TOOL_NAME = 'tell_story';
const VISUAL_DESCRIBE_SCENE_TOOL_NAME = 'describe_scene';
const TASK_MANAGER_TOOL_NAME = 'task_manager';
const UPDATE_PLAYER_PROFILE_TOOL_NAME = 'update_player_profile';
const NEXT_ACTION_TOOL_NAME = 'next_action';
const DEFAULT_OUTPUT_LANGUAGE: AppLanguage = 'en-US';
const DEFAULT_LLM_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

const DEFAULT_PLAYER_PROFILE: PlayerProfile = {
    playerName: 'Unknown Adventurer',
    statuses: [{ name: 'Health', color: '#ef4444', percent: 100 }],
    skills: [],
    items: []
};

let playerProfile: PlayerProfile = clonePlayerProfile(DEFAULT_PLAYER_PROFILE);

const PLAYER_PROFILE_JSON_SCHEMA = {
    type: 'object',
    properties: {
        playerName: {
            type: 'string',
            description: 'Player display name.'
        },
        statuses: {
            type: 'array',
            minItems: 1,
            description: 'Status bar list used by UI, e.g. health, mana, shield.',
            items: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Status label.'
                    },
                    color: {
                        type: 'string',
                        description: 'Status bar color in HEX format (#RGB or #RRGGBB).'
                    },
                    percent: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 100,
                        description: 'Status percentage, integer between 0 and 100.'
                    }
                },
                required: ['name', 'color', 'percent'],
                additionalProperties: false
            }
        },
        skills: {
            type: 'array',
            description: 'Skill list. Each item contains name and description.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' }
                },
                required: ['name', 'description'],
                additionalProperties: false
            }
        },
        items: {
            type: 'array',
            description: 'Item list. Each item contains name and description.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' }
                },
                required: ['name', 'description'],
                additionalProperties: false
            }
        }
    },
    required: ['playerName', 'statuses', 'skills', 'items'],
    additionalProperties: false
};

const CREATE_WORLD_DECLARATION: FunctionDeclaration = {
    name: CREATE_WORLD_TOOL_NAME,
    description:
        'World creation tool. Returns a stable world anchor and reference work used in later DM and image stages.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            worldInfo: {
                type: 'string',
                description:
                    'Stable world setup (do not rewrite world anchor). Must cover era/environment, key factions, major conflict, core rules, and danger sources with long-play consistency.'
            },
            referenceWork: {
                type: 'string',
                description:
                    'Reference work name (any language/media, e.g. game/film/anime/novel) used to constrain consistency. If the player gives aliases, places, or world elements, infer the closest complete work title.'
            }
        },
        required: ['worldInfo', 'referenceWork'],
        additionalProperties: false
    }
};

const CREATE_CHARACTER_DECLARATION: FunctionDeclaration = {
    name: CREATE_CHARACTER_TOOL_NAME,
    description:
        'Character creation tool. Returns complete initial playerProfile JSON for UI display and later turn updates.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            playerProfile: PLAYER_PROFILE_JSON_SCHEMA
        },
        required: ['playerProfile'],
        additionalProperties: false
    }
};

const TELL_STORY_DECLARATION: FunctionDeclaration = {
    name: TELL_STORY_TOOL_NAME,
    description:
        'Main DM tool per turn. tell_story must be called at least once each turn; strictly follow this schema.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            narrative: {
                type: 'string',
                maxLength: DM_NARRATIVE_MAX_CHARS,
                description:
                    `Narrative in the selected output language, up to ${DM_NARRATIVE_MAX_CHARS} chars. Must include process + feedback + result. Keep it as objective plot progression only; do not include suggestions or what to do next.`
            },
            sceneMode: {
                type: 'string',
                enum: ['continue', 'transition'],
                description: `continue keeps current scene; transition switches scene. ${SCENE_MODE_SCHEMA_RULES}`
            },
            sceneSignature: {
                type: 'string',
                description:
                    'English scene-traits summary. Must be non-empty when sceneMode=transition and directly usable for drawing a new scene; must be empty when sceneMode=continue.'
            },
            keyObjectChanges: {
                type: 'string',
                description:
                    'English key-object change summary after this turn. Cover critical visible characters/objects and explicitly state expression, action, and position changes; if an aspect is unchanged, say unchanged explicitly.'
            },
            nextChoices: {
                type: 'array',
                minItems: NEXT_CHOICE_MIN_COUNT,
                maxItems: NEXT_CHOICE_MAX_COUNT,
                description: `${NEXT_CHOICE_MIN_COUNT} to ${NEXT_CHOICE_MAX_COUNT} next actions for player in selected output language; each up to ${NEXT_CHOICE_MAX_CHARS} chars and strategy should differ.`,
                items: {
                    type: 'string',
                    maxLength: NEXT_CHOICE_MAX_CHARS
                }
            }
        },
        required: ['narrative', 'sceneMode', 'sceneSignature', 'keyObjectChanges', 'nextChoices'],
        additionalProperties: false
    }
};

const buildVisualDescribeSceneDeclaration = (sceneMode: SceneMode): FunctionDeclaration => {
    const modeRules = sceneMode === 'transition' ? VISUAL_DM_TRANSITION_RULES : VISUAL_DM_CONTINUE_RULES;
    return {
        name: VISUAL_DESCRIBE_SCENE_TOOL_NAME,
        description:
            'VisualDM tool per turn. Build scene_description from world/context/reference image and current narrative result.',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                sceneDescription: {
                    type: 'string',
                    description:
                        `${SCENE_DESCRIPTION_PURPOSE_AND_FORMAT_SCHEMA_RULES} ${SCENE_DESCRIPTION_COVERAGE_SCHEMA_RULES} ${SCENE_DESCRIPTION_CHANGE_SCHEMA_RULES} ${SCENE_DESCRIPTION_NAMING_SCHEMA_RULES} ${modeRules}`
                }
            },
            required: ['sceneDescription'],
            additionalProperties: false
        }
    };
};

const TASK_MANAGER_DECLARATION: FunctionDeclaration = {
    name: TASK_MANAGER_TOOL_NAME,
    description:
        'Task management tool. Call only when tasks are added/updated/completed/failed/canceled. Must return the full valid task list after update, not an incremental patch; prioritize main-quest stability.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            tasks: {
                type: 'array',
                description:
                    'Complete valid task list; return empty array if all tasks are removed. Capacity limit: at most 1 main + 2 side tasks. Avoid duplicate objectives; when an objective enters a new phase, update existing task instead of creating duplicates.',
                maxItems: MAX_MAIN_TASKS + MAX_SIDE_TASKS,
                items: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['main', 'side'],
                            description: 'Task type: main=main quest, side=side quest.'
                        },
                        name: {
                            type: 'string',
                            maxLength: 20,
                            description: 'Task name (short, ideally within 20 chars).'
                        },
                        content: {
                            type: 'string',
                            maxLength: 80,
                            description: 'Task content (actionable and concise, ideally within 80 chars).'
                        }
                    },
                    required: ['type', 'name', 'content'],
                    additionalProperties: false
                }
            }
        },
        required: ['tasks'],
        additionalProperties: false
    }
};

const UPDATE_PLAYER_PROFILE_DECLARATION: FunctionDeclaration = {
    name: UPDATE_PLAYER_PROFILE_TOOL_NAME,
    description:
        'Player profile overwrite update tool. Must be called each turn and return the latest full playerProfile JSON.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            playerProfile: PLAYER_PROFILE_JSON_SCHEMA
        },
        required: ['playerProfile'],
        additionalProperties: false
    }
};

const NEXT_ACTION_DECLARATION: FunctionDeclaration = {
    name: NEXT_ACTION_TOOL_NAME,
    description: 'AutoPlayer output tool. Must be called once to submit the next player action text.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description:
                    'One executable player action in target_output_language. Prefer around 20 Chinese chars or one concise English sentence.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

const outputLanguageLabelMap: Record<AppLanguage, string> = {
    'en-US': 'English',
    'zh-CN': 'Simplified Chinese'
};

const resolveOutputLanguageLabel = (outputLanguage: AppLanguage) => {
    return outputLanguageLabelMap[outputLanguage] || outputLanguageLabelMap[DEFAULT_OUTPUT_LANGUAGE];
};

export const restoreToCheckpoint = (turnCount: number) => {
    const safeTurnCount = Math.max(0, Math.floor(turnCount));
    const targetLength = safeTurnCount * 2;
    history = history.slice(0, targetLength);
};

export const setTaskState = (tasks: TaskGuideItem[]) => {
    activeTasks = sanitizeTaskItems(tasks);
};

export const setStyleState = (nextStyle: string) => {
    const normalized = typeof nextStyle === 'string' ? nextStyle.trim() : '';
    currentStyle = normalized || 'Minecraft';
};

export const setPlayerProfileState = (nextPlayerProfile: PlayerProfile) => {
    const sanitized = sanitizePlayerProfile(nextPlayerProfile);
    playerProfile = sanitized ? clonePlayerProfile(sanitized) : clonePlayerProfile(DEFAULT_PLAYER_PROFILE);
};

export const exportRuntimeState = (): GameRuntimeState => {
    return {
        history: history.map(item => ({ ...item })),
        globalAnchor,
        playerProfile: clonePlayerProfile(playerProfile),
        currentQuality,
        currentStyle,
        currentAspectRatio,
        currentReferenceWork,
        activeTasks: cloneTaskItems(activeTasks)
    };
};

export const importRuntimeState = (state: Partial<GameRuntimeState>) => {
    const nextHistory = Array.isArray(state.history)
        ? state.history
              .filter(item => item && (item.role === 'user' || item.role === 'model') && typeof item.text === 'string')
              .map(item => ({
                  role: item.role,
                  text: item.text
              }))
        : [];

    history = nextHistory;
    globalAnchor = typeof state.globalAnchor === 'string' ? state.globalAnchor : '';
    playerProfile = sanitizePlayerProfile(state.playerProfile) || clonePlayerProfile(DEFAULT_PLAYER_PROFILE);
    currentQuality = typeof state.currentQuality === 'string' && state.currentQuality.trim() ? state.currentQuality : '1K';
    currentStyle =
        typeof state.currentStyle === 'string' && state.currentStyle.trim() ? state.currentStyle : 'Minecraft';
    currentAspectRatio =
        typeof state.currentAspectRatio === 'string' && state.currentAspectRatio.trim() ? state.currentAspectRatio : '16:9';
    const legacyReferenceWork = (state as Record<string, unknown>).currentReferenceGame;
    currentReferenceWork =
        typeof state.currentReferenceWork === 'string' && state.currentReferenceWork.trim()
            ? state.currentReferenceWork
            : typeof legacyReferenceWork === 'string' && legacyReferenceWork.trim()
                ? legacyReferenceWork
                : '';
    activeTasks = sanitizeTaskItems(state.activeTasks);
};

const stylePromptMap: Record<string, string> = {
    Minecraft:
        'Minecraft-authentic voxel style with classic block scale and iconic silhouettes, upgraded like a premium modpack: high-definition textures, crisp material response, believable shadows, soft global illumination, subtle atmospheric depth, and shader-quality lighting while preserving the unmistakable Minecraft visual identity.',
    'Pixel Art':
        '2D pixel-art game style, crisp sprite readability, clean pixel composition, rich but controlled palette, and polished retro lighting.',
    '3D Pixel Art':
        'Minecraft-inspired HD micro-voxel style. Enforce much smaller blocks across the entire world (minimum 4x finer voxel density per edge than classic large-cube scale) to unlock denser geometric detail. Keep the block-based DNA, but upgrade with crisp materials, believable shadows, soft global illumination, and subtle atmospheric depth. Characters and creatures must feel native to this voxel universe while not being strictly cubic, with refined proportions and richer detail in faces, clothing, armor, and anatomy.',
    Realistic:
        'Vanilla mode: keep the source game visual language unchanged and avoid stylistic embellishment.',
    Claymation:
        'Claymation stop-motion style, handmade clay surfaces, fingerprint micro-texture, miniature set lighting, practical depth of field, and playful handcrafted look.'
};

const buildStyleRequirement = (style: string, referenceWork: string) => {
    if (style === 'Realistic') {
        const safeReferenceWork = toTrimmedString(referenceWork);
        const fidelityTarget = safeReferenceWork
            ? `the original art direction of "${safeReferenceWork}"`
            : 'the original art direction already established by the current reference world';
        return `Style Requirement: Vanilla mode. Keep visuals strictly aligned with ${fidelityTarget}, including character design language, environment motifs, material treatment, color grading, and overall mood. Apply no extra stylization, no decorative embellishment, and no cross-style reinterpretation. Strict first-person game perspective. Do not include any UI elements in the image, such as health bars, inventory bars, status bars, or HUD overlays.`;
    }

    const styleDescription = stylePromptMap[style] || `${style} game style.`;
    return `Style Requirement: ${styleDescription} Strict first-person game perspective. Do not include any UI elements in the image, such as health bars, inventory bars, status bars, or HUD overlays.`;
};

const buildWorldConsistencyRequirement = (referenceWork: string, style: string) => {
    const safeReferenceWork = toTrimmedString(referenceWork);
    const safeStyle = toTrimmedString(style) || 'requested';
    if (!safeReferenceWork) {
        return `World Consistency: Keep characters, locations, factions, props, and lore internally consistent, while transferring visuals to "${safeStyle}" style.`;
    }

    return `World Consistency: Keep all characters, locations, factions, props, and lore consistent with "${safeReferenceWork}", while transferring visuals to "${safeStyle}" style.`;
};

const getApiKey = () => {
    return localStorage.getItem('CUSTOM_GEMINI_API_KEY') || process.env.GEMINI_API_KEY || '';
};

const withRetry = async <T>(operation: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> => {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await operation();
        } catch (error: any) {
            attempt++;
            const errorMessage = error?.message || '';
            const status = error?.status || error?.code;
            const isTransient =
                status === 503 ||
                status === 429 ||
                errorMessage.includes('503') ||
                errorMessage.includes('429') ||
                errorMessage.includes('UNAVAILABLE') ||
                errorMessage.includes('high demand');

            if (!isTransient || attempt >= maxRetries) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt - 1);
            console.warn(`API overloaded (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('Max retries reached');
};

const toTrimmedString = (value: unknown) => {
    return typeof value === 'string' ? value.trim() : '';
};

const truncateByChars = (value: string, maxChars: number) => {
    return Array.from(value).slice(0, maxChars).join('');
};

const escapeXml = (value: string) => {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

const isSceneMode = (value: unknown): value is SceneMode => {
    return value === 'continue' || value === 'transition';
};

const cloneTaskItems = (tasks: TaskGuideItem[]) => {
    return tasks.map(task => ({ ...task }));
};

const resolveVisualScenePlayerName = () => {
    const normalized = toTrimmedString(playerProfile.playerName).replace(/\s+/g, ' ');
    return normalized || DEFAULT_PLAYER_PROFILE.playerName;
};

const buildVisualSceneDescriptionPrefix = () => {
    return `Your are ${resolveVisualScenePlayerName()}, ${VISUAL_DM_SCENE_DESCRIPTION_BODY_PREFIX}`;
};

const stripVisualSceneDescriptionPrefix = (value: string) => {
    return value
        .replace(/^(?:your|you)\s+are\s+(?:\{name\}|[^,\n]+),\s*/i, '')
        .replace(/^first-person\s+pov,\s*(?:i|you)\s+see\b/i, '')
        .replace(/^(first[- ]person\s+(?:pov|view)\s*[:,]?\s*)/i, '')
        .replace(/^(from (?:my|your) (?:perspective|viewpoint)\s*[:,]?\s*)/i, '')
        .replace(/^(?:i|you)\s+(?:can\s+)?see\s*/i, '')
        .replace(/^[-,:;\s]+/, '');
};

const buildVisualSceneDescription = (content: string) => {
    return `${buildVisualSceneDescriptionPrefix()} ${content}`;
};

const ensureFirstPersonSceneDescription = (prompt: string) => {
    const normalized = toTrimmedString(prompt).replace(/^[`"'“”]+|[`"'“”]+$/g, '');
    if (!normalized) {
        return `${buildVisualSceneDescriptionPrefix()} nearby NPCs or monsters in front of you.`;
    }

    const lines = normalized.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
    const hasRenderControlHeader =
        lines.length >= 2
        && /^(Using the reference image as the base frame|Scene transition|No reference image is attached)/i.test(
            lines[0]
        );

    if (hasRenderControlHeader) {
        const header = lines[0];
        const body = lines.slice(1).join(' ');
        if (!body) return header;
        if (VISUAL_DM_SCENE_DESCRIPTION_PREFIX_PATTERN.test(body)) {
            return `${header}\n${body}`;
        }
        const contentBody = stripVisualSceneDescriptionPrefix(body);
        if (!contentBody) return header;
        return `${header}\n${buildVisualSceneDescription(contentBody)}`;
    }

    if (VISUAL_DM_SCENE_DESCRIPTION_PREFIX_PATTERN.test(normalized)) {
        return normalized;
    }

    const contentBody = stripVisualSceneDescriptionPrefix(normalized);

    if (!contentBody) {
        return `${buildVisualSceneDescriptionPrefix()} nearby NPCs or monsters in front of you.`;
    }

    return buildVisualSceneDescription(contentBody);
};

const buildVisualRenderControlHeader = (
    sceneMode: SceneMode,
    hasReferenceImage: boolean
) => {
    if (sceneMode === 'transition') {
        return hasReferenceImage
            ? 'Scene transition: keep style continuity from the reference image; generate scene content strictly according to the description below.'
            : 'Scene transition: generate scene content strictly according to the description below.';
    }
    return hasReferenceImage
        ? 'Using the reference image as the base frame, apply only the changes described below; keep all undescribed parts unchanged.'
        : 'No reference image is attached; generate the full frame strictly according to the description below.';
};

const buildVisualDmModePromptText = (
    sceneMode: SceneMode,
    hasReferenceImage: boolean
) => {
    if (sceneMode === 'transition') {
        return `<visual_dm_mode_prompt>
<mode>transition</mode>
<objective>Only handle scene-transition rendering description for a new scene.</objective>
<constraints>
- Do not write continue-mode guidance.
- Explicitly define the new scene composition and changed spatial layout.
- Keep recurring-subject identity continuity.
- ${hasReferenceImage
        ? 'Use reference image only for style/identity continuity, not old layout reuse.'
        : 'No reference image available; rely fully on textual continuity.'}
</constraints>
</visual_dm_mode_prompt>`;
    }
    return `<visual_dm_mode_prompt>
<mode>continue</mode>
<objective>Only handle same-scene incremental rendering description.</objective>
<constraints>
- Do not write transition-mode guidance.
- Restate complete current frame then list this-turn deltas.
- Preserve previous layout continuity and focus on local state changes.
- ${hasReferenceImage
        ? 'Treat reference image as base frame and only update described parts.'
        : 'No reference image available; provide a full-frame continuation description.'}
</constraints>
</visual_dm_mode_prompt>`;
};

const normalizeTaskIdentityText = (value: string) => {
    return value
        .toLowerCase()
        .replace(/第?[0-9一二三四五六七八九十百]+(阶段|步)/g, '')
        .replace(/\b(?:phase|step)\s*[0-9]+\b/g, '')
        .replace(/[【】\[\]（）(){}:：\-_,，。.!?？、\s]/g, '')
        .trim();
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

const enforceTaskLimits = (tasks: TaskGuideItem[]) => {
    const merged: TaskGuideItem[] = [];

    for (const task of tasks) {
        const normalizedType = task.type === 'side' ? 'side' : 'main';
        const normalizedTask: TaskGuideItem = { ...task, type: normalizedType };
        const existingIndex = merged.findIndex(
            existing => existing.type === normalizedType && isLikelySameTaskGoal(existing, normalizedTask)
        );

        if (existingIndex >= 0) {
            // Prefer the latest wording when the same objective enters another phase.
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

const areTaskItemsEqual = (left: TaskGuideItem[], right: TaskGuideItem[]) => {
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index++) {
        if (
            left[index].name !== right[index].name
            || left[index].content !== right[index].content
            || (left[index].type || 'main') !== (right[index].type || 'main')
        ) {
            return false;
        }
    }

    return true;
};

const sanitizeTaskItems = (rawTasks: unknown): TaskGuideItem[] => {
    if (!Array.isArray(rawTasks)) return [];

    const sanitized: TaskGuideItem[] = [];
    const seenExact = new Set<string>();

    for (const rawTask of rawTasks) {
        if (!rawTask || typeof rawTask !== 'object') continue;
        const record = rawTask as Record<string, unknown>;
        const name = toTrimmedString(record.name);
        const content = toTrimmedString(record.content);
        const type = record.type === 'side' ? 'side' : 'main';
        if (!name || !content) continue;
        const exactKey = `${type}:${name.toLowerCase()}:${content.toLowerCase()}`;
        if (seenExact.has(exactKey)) continue;
        seenExact.add(exactKey);
        sanitized.push({ name, content, type });
    }

    return enforceTaskLimits(sanitized);
};

const sanitizeChoices = (rawChoices: unknown): string[] => {
    if (!Array.isArray(rawChoices)) return [];

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of rawChoices) {
        const text = truncateByChars(toTrimmedString(item), NEXT_CHOICE_MAX_CHARS);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(text);
    }

    return deduped.slice(0, NEXT_CHOICE_MAX_COUNT);
};

const normalizeAutoPlayerActionText = (value: string) => {
    return value
        .replace(/\r?\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
        .trim();
};

const isLanguageAlignedAction = (value: string, outputLanguage: AppLanguage) => {
    if (!value) return false;
    if (outputLanguage === 'zh-CN') {
        return /[\u3400-\u9fff]/.test(value);
    }
    return /[A-Za-z]/.test(value);
};

const sanitizeAutoPlayerAction = (rawAction: unknown, outputLanguage: AppLanguage) => {
    const sourceText = toTrimmedString(rawAction);
    if (!sourceText) return '';

    const candidates = sourceText
        .split(/\r?\n+/)
        .map(item => normalizeAutoPlayerActionText(item))
        .filter(Boolean);
    if (candidates.length === 0) return '';

    const matched = candidates.find(item => isLanguageAlignedAction(item, outputLanguage));
    if (matched) return matched;

    const normalized = normalizeAutoPlayerActionText(sourceText);
    if (!normalized) return '';
    return normalized;
};

const serializePlayerProfileForPrompt = (value: PlayerProfile) => {
    return JSON.stringify(value);
};

const arePlayerProfilesEqual = (left: PlayerProfile, right: PlayerProfile) => {
    return JSON.stringify(left) === JSON.stringify(right);
};

const formatTaskListForXml = (tasks: TaskGuideItem[]) => {
    if (tasks.length === 0) {
        return '<active_tasks><none>NO_ACTIVE_TASK</none></active_tasks>';
    }

    const taskBlocks = tasks
        .map(
            task =>
                `<task>
<type>${escapeXml(task.type === 'side' ? 'side' : 'main')}</type>
<name>${escapeXml(task.name)}</name>
<content>${escapeXml(task.content)}</content>
</task>`
        )
        .join('\n');

    return `<active_tasks>
${taskBlocks}
</active_tasks>`;
};

const buildConversationContentsFromHistory = () => {
    return history.map(item => ({
        role: item.role,
        parts: [{ text: item.text }]
    }));
};

const buildHistoryConversationPromptText = () => {
    if (history.length === 0) {
        return `<history_conversation>
<none>NO_HISTORY</none>
</history_conversation>`;
    }

    const historyBlocks = history
        .map(
            (item, index) =>
                `<message index="${index + 1}" role="${item.role.toUpperCase()}">${escapeXml(item.text)}</message>`
        )
        .join('\n');

    return `<history_conversation>
${historyBlocks}
</history_conversation>`;
};

const buildReferenceImagePromptText = (referenceImage: string | null | undefined) => {
    const status = referenceImage ? 'ATTACHED_PREVIOUS_FRAME_IMAGE' : 'NONE';
    return `<reference_image>
${status}
</reference_image>`;
};

const buildLatestImagesPromptText = (latestImageBase64: string | null | undefined) => {
    const status = latestImageBase64 ? 'ATTACHED_LATEST_IMAGE' : 'NO_IMAGE';
    return `<latest_images>
${status}
</latest_images>`;
};

const buildDebugImageDataUrl = (base64Payload: string | null | undefined, mimeType: string = 'image/jpeg') => {
    const normalized = toTrimmedString(base64Payload);
    if (!normalized) return undefined;
    return `data:${mimeType};base64,${normalized}`;
};

const formatLatestOptionsForXml = (latestOptions: string[]) => {
    const sanitizedOptions = sanitizeChoices(latestOptions);
    if (sanitizedOptions.length === 0) {
        return '<latest_options><none>NO_OPTIONS</none></latest_options>';
    }

    const optionBlocks = sanitizedOptions
        .map((option, index) => `<option index="${index + 1}">${escapeXml(option)}</option>`)
        .join('\n');

    return `<latest_options>
${optionBlocks}
</latest_options>`;
};

const formatCurrentTaskForXml = (currentTasks: TaskGuideItem[]) => {
    const sanitizedTasks = sanitizeTaskItems(currentTasks);
    if (sanitizedTasks.length === 0) {
        return '<current_task><none>NO_ACTIVE_TASK</none></current_task>';
    }

    const taskBlocks = sanitizedTasks
        .map(
            task =>
                `<task>
<type>${escapeXml(task.type === 'side' ? 'side' : 'main')}</type>
<name>${escapeXml(task.name)}</name>
<content>${escapeXml(task.content)}</content>
</task>`
        )
        .join('\n');

    return `<current_task>
${taskBlocks}
</current_task>`;
};

const buildCurrentTurnUserInputWithHintPromptText = (userInput: string, hint: string) => {
    return `<current_turn_user_input_with_hint>
<player_input>${escapeXml(userInput)}</player_input>
<hint>${escapeXml(hint)}</hint>
</current_turn_user_input_with_hint>`;
};

const buildOpeningActDirectionPromptText = (referenceWork: string, playerWorldRequirement: string) => {
    const normalizedReferenceWork = toTrimmedString(referenceWork);
    const normalizedPlayerWorldRequirement = toTrimmedString(playerWorldRequirement);
    return `<opening_act_direction>
<when_to_apply>Apply this only for first entry into game (Act 1 / turn_number=1).</when_to_apply>
<priority_rule>If the player_world_requirement already provides an explicit opening setup (clear place, position, and immediate situation), follow that opening as the primary source of truth.</priority_rule>
<fallback_rule>If the player_world_requirement does not clearly describe an opening setup, create an iconic or grand opening tableau inspired by the reference work, then quickly hand control to the player.</fallback_rule>
<reference_work>${escapeXml(normalizedReferenceWork || 'N/A')}</reference_work>
<player_world_requirement>${escapeXml(normalizedPlayerWorldRequirement || 'N/A')}</player_world_requirement>
<iconic_examples>
- Skyrim-style: wake up in a constrained moving transport (for example, a prison cart) heading toward visible danger.
- The Legend of Zelda: Breath of the Wild-style: stand on the initial high plateau and overlook the vast Hyrule landscape as a grand reveal.
- Stardew Valley-style: start at the farm, with overgrown weeds and a small wooden cabin in view for a first-day beginning.
</iconic_examples>
<constraints>
- Treat examples as inspiration only, never mandatory copy.
- Keep world lore, factions, and tone fully consistent with world_info and reference_work.
- Do not mix settings from unrelated IP.
- Hand control to the player quickly after the opening tableau.
- The opening must establish location, immediate tension, and at least one clear actionable interaction.
</constraints>
</opening_act_direction>`;
};

interface DmRequestPayload {
    contents: Array<{ role: 'user' | 'model'; parts: any[] }>;
    requestBlocks: DebugRequestBlock[];
}

interface VisualDmRequestPayload {
    contents: Array<{ role: 'user' | 'model'; parts: any[] }>;
    requestBlocks: DebugRequestBlock[];
}

interface AutoPlayerRequestPayload {
    contents: Array<{ role: 'user' | 'model'; parts: any[] }>;
    requestBlocks: DebugRequestBlock[];
}

interface DmRequestOptions {
    allowOpeningActDirectionBlock?: boolean;
}

const buildDmRequestPayload = (
    systemInstruction: string,
    currentTurnContextPromptText: string,
    userInput: string,
    hint: string,
    referenceImageBase64: string | null | undefined,
    extraPromptBlocks: DebugRequestBlock[] = [],
    options: DmRequestOptions = {}
): DmRequestPayload => {
    const allowOpeningActDirectionBlock = options.allowOpeningActDirectionBlock === true;
    const isolatedExtraPromptBlocks = allowOpeningActDirectionBlock
        ? extraPromptBlocks
        : extraPromptBlocks.filter(block => block.key !== 'opening_act_direction');
    const historyConversationPromptText = buildHistoryConversationPromptText();
    const referenceImagePromptText = buildReferenceImagePromptText(referenceImageBase64);
    const referenceImageDataUrl = buildDebugImageDataUrl(referenceImageBase64);
    const userInputWithHintPromptText = buildCurrentTurnUserInputWithHintPromptText(userInput, hint);
    const contents = buildConversationContentsFromHistory();
    const parts: any[] = [];

    if (referenceImageBase64) {
        parts.push({
            inlineData: {
                data: referenceImageBase64,
                mimeType: 'image/jpeg'
            }
        });
    }

    parts.push({
        text: [
            currentTurnContextPromptText,
            referenceImagePromptText,
            ...isolatedExtraPromptBlocks.map(block => block.promptText),
            userInputWithHintPromptText
        ].join('\n')
    });

    contents.push({
        role: 'user',
        parts
    });

    return {
        contents,
        requestBlocks: [
            {
                key: 'system_prompt',
                title: 'System Prompt',
                promptText: systemInstruction
            },
            {
                key: 'history_conversation',
                title: 'History Conversation',
                promptText: historyConversationPromptText
            },
            {
                key: 'current_turn_context',
                title: 'Current Turn Context',
                promptText: currentTurnContextPromptText
            },
            {
                key: 'reference_image',
                title: 'Reference Image',
                promptText: referenceImagePromptText,
                ...(referenceImageDataUrl ? { imageDataUrl: referenceImageDataUrl } : {})
            },
            ...isolatedExtraPromptBlocks,
            {
                key: 'current_turn_user_input_with_hint',
                title: 'Current Turn User Input (+ Hint)',
                promptText: userInputWithHintPromptText
            }
        ]
    };
};

const buildVisualDmSystemInstruction = (sceneMode: SceneMode, hasReferenceImage: boolean) => {
    const modeRules = sceneMode === 'transition' ? VISUAL_DM_TRANSITION_RULES : VISUAL_DM_CONTINUE_RULES;
    const modePolicy =
        sceneMode === 'transition'
            ? '- Mode focus: transition only. Build a clearly switched scene with continuity of recurring subjects.'
            : '- Mode focus: continue only. Keep same scene continuity and describe only incremental visual deltas.';
    const referencePolicy = hasReferenceImage
        ? '- Reference image is available. Use it as visual continuity evidence.'
        : '- No reference image is available. Build the full visual description from text context only.';
    return `<system_prompt>
<base_setup>
You are VisualDM for a TRPG game.
Your only job is to convert narrative outcome + scene state signals into one image-ready scene_description.
</base_setup>
<function_contract>
- Generate scene_description only; do not produce narrative, task updates, or player profile changes.
- scene_description must be English, one paragraph, and image-ready.
- Always depict the post-narrative result frame rather than in-progress actions.
</function_contract>
<render_handoff_policy>
- scene_description is sent directly to the image model; write it as an executable rendering instruction.
${modePolicy}
${referencePolicy}
</render_handoff_policy>
<scene_rules>
- ${SCENE_DESCRIPTION_PURPOSE_AND_FORMAT_SCHEMA_RULES}
- ${SCENE_DESCRIPTION_COVERAGE_SCHEMA_RULES}
- ${SCENE_DESCRIPTION_CHANGE_SCHEMA_RULES}
- ${SCENE_DESCRIPTION_NAMING_SCHEMA_RULES}
- ${modeRules}
</scene_rules>
</system_prompt>`;
};

const buildVisualDmContextXml = (
    worldInfo: string,
    referenceWork: string,
    lastNarrative: string,
    currentNarrative: string,
    sceneMode: SceneMode,
    sceneSignature: string,
    keyObjectChanges: string
) => {
    const modeContext =
        sceneMode === 'transition'
            ? `<transition_context>
<scene_signature>${escapeXml(sceneSignature || 'N/A')}</scene_signature>
<task_focus>Design the new scene composition and transitioned spatial layout.</task_focus>
</transition_context>`
            : `<continue_context>
<baseline_instruction>Keep the same scene and apply only this-turn deltas.</baseline_instruction>
<task_focus>Preserve layout continuity and emphasize local changes only.</task_focus>
</continue_context>`;
    return `<visual_dm_context>
<world_info>${escapeXml(worldInfo || 'N/A')}</world_info>
<reference_work>${escapeXml(referenceWork || 'N/A')}</reference_work>
<last_narrative>${escapeXml(lastNarrative || 'N/A')}</last_narrative>
<current_narrative>${escapeXml(currentNarrative)}</current_narrative>
<scene_mode>${sceneMode}</scene_mode>
<key_object_changes>${escapeXml(keyObjectChanges || 'N/A')}</key_object_changes>
${modeContext}
</visual_dm_context>`;
};

const buildVisualDmRequestPayload = (
    systemInstruction: string,
    contextPromptText: string,
    modePromptText: string,
    referenceImageBase64: string | null | undefined
): VisualDmRequestPayload => {
    const referenceImagePromptText = buildReferenceImagePromptText(referenceImageBase64);
    const referenceImageDataUrl = buildDebugImageDataUrl(referenceImageBase64);
    const parts: any[] = [];

    if (referenceImageBase64) {
        parts.push({
            inlineData: {
                data: referenceImageBase64,
                mimeType: 'image/jpeg'
            }
        });
    }
    parts.push({
        text: [modePromptText, contextPromptText, referenceImagePromptText].join('\n')
    });

    return {
        contents: [
            {
                role: 'user',
                parts
            }
        ],
        requestBlocks: [
            {
                key: 'visual_dm_system_prompt',
                title: 'VisualDM System Prompt',
                promptText: systemInstruction
            },
            {
                key: 'visual_dm_mode_prompt',
                title: 'VisualDM Mode Prompt',
                promptText: modePromptText
            },
            {
                key: 'visual_dm_context',
                title: 'VisualDM Context',
                promptText: contextPromptText,
                ...(referenceImageDataUrl ? { imageDataUrl: referenceImageDataUrl } : {})
            },
            {
                key: 'visual_dm_reference_image',
                title: 'VisualDM Reference Image',
                promptText: referenceImagePromptText,
                ...(referenceImageDataUrl ? { imageDataUrl: referenceImageDataUrl } : {})
            }
        ]
    };
};

const buildDmTurnContextXml = (
    turnNumber: number,
    currentPlayerProfile: PlayerProfile,
    tasks: TaskGuideItem[],
    forceSideEvent: boolean,
    travelIntent: boolean,
    referenceWork: string,
    outputLanguage: AppLanguage
) => {
    const safePlayerProfile = escapeXml(serializePlayerProfileForPrompt(currentPlayerProfile));
    const safeReferenceWork = escapeXml(referenceWork || 'N/A');
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    return `<current_turn_context>
<turn_number>${turnNumber}</turn_number>
<reference_work>${safeReferenceWork}</reference_work>
<target_output_language>${escapeXml(outputLanguageLabel)}</target_output_language>
<current_player_profile>${safePlayerProfile}</current_player_profile>
${formatTaskListForXml(tasks)}
<creative_pressure>${forceSideEvent ? 'HIGH' : 'NORMAL'}</creative_pressure>
<travel_intent_detected>${travelIntent ? 'YES' : 'NO'}</travel_intent_detected>
</current_turn_context>`;
};

const buildOpeningTurnContextXml = (
    globalSetting: string,
    currentPlayerProfile: PlayerProfile,
    referenceWork: string,
    outputLanguage: AppLanguage
) => {
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    return `<current_turn_context>
<turn_number>1</turn_number>
<global_setting>${escapeXml(globalSetting || 'N/A')}</global_setting>
<reference_work>${escapeXml(referenceWork || 'N/A')}</reference_work>
<target_output_language>${escapeXml(outputLanguageLabel)}</target_output_language>
<current_player_profile>${escapeXml(serializePlayerProfileForPrompt(currentPlayerProfile))}</current_player_profile>
<turn_goal>Generate the opening turn with clear action space and initial conflict.</turn_goal>
<tool_call_reminder>You must call tell_story and update_player_profile.</tool_call_reminder>
</current_turn_context>`;
};

const buildTaskManagerContextXml = (
    globalSetting: string,
    currentPlayerProfile: PlayerProfile,
    playerAction: string,
    latestNarrative: string,
    turnNumber: number
) => {
    return `<task_context>
<turn_number>${turnNumber}</turn_number>
<global_setting>${escapeXml(globalSetting || 'N/A')}</global_setting>
<current_player_profile>${escapeXml(serializePlayerProfileForPrompt(currentPlayerProfile))}</current_player_profile>
<latest_player_action>${escapeXml(playerAction)}</latest_player_action>
<latest_dm_narrative>${escapeXml(latestNarrative)}</latest_dm_narrative>
${formatTaskListForXml(activeTasks)}
</task_context>`;
};

const buildAutoPlayerSystemInstruction = (
    worldInfo: string,
    referenceWork: string,
    outputLanguage: AppLanguage,
    behaviorMode: string
) => {
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    const safeWorldInfo = escapeXml(worldInfo || 'N/A');
    const safeReferenceWork = escapeXml(referenceWork || 'N/A');
    const safeBehaviorMode = escapeXml(behaviorMode);
    return `<system_prompt>
<base_setup>
You are AutoPlayerAgent. Your only job is to produce one executable player action for the next turn.
</base_setup>
<xml_schema_note>
<workflow>Per-turn order: reason first, tool call second.</workflow>
<tool_contract>Hard constraints for next_action call. Field constraints are defined by tool schema.</tool_contract>
<language_policy>
- next_action.action must be written in ${escapeXml(outputLanguageLabel)}.
- Do not mix other languages in the same action.
</language_policy>
</xml_schema_note>
<world_info>
${safeWorldInfo}
</world_info>
<reference_work>
${safeReferenceWork}
</reference_work>
<target_output_language>
${escapeXml(outputLanguageLabel)}
</target_output_language>
<behavior_mode>
${safeBehaviorMode}
</behavior_mode>
<behavior_priority>
- behavior_mode is the highest-priority strategy policy for choosing the next action.
- If behavior_mode indicates aggressive/hacker/jailbreak play, prefer loophole probing, sequence breaks, social engineering, resource hijacking, and rule-bending routes over safe conventional choices.
- Keep the action executable in one turn under the current scene constraints; do not output impossible omnipotent actions.
</behavior_priority>
<workflow>
1. Read history, latest narrative, current profile, current task, latest image, and current options.
2. Infer the best immediate action from context continuity, world rules, profile capability, and current objective.
3. You must call next_action exactly once and put the final action text into action.
</workflow>
<tool_contract>
- The only allowed tool is next_action.
- Every turn must call next_action exactly once. Missing call is invalid.
- next_action.action must contain the final action text for this turn.
- Never output plain text, markdown, explanation, or freeform JSON outside tool calls.
</tool_contract>
<constraints>
- options are references only; choose action mainly by behavior_mode.
- Output 10-30 characters.
</constraints>
</system_prompt>`;
};

const buildAutoPlayerToolCallReminderPromptText = () => {
    return '<tool_call_reminder>You must call next_action exactly once and put the final action text in action.</tool_call_reminder>';
};

const buildAutoPlayerCurrentProfilePromptText = (currentProfile: PlayerProfile) => {
    return `<current_profile>${escapeXml(serializePlayerProfileForPrompt(currentProfile))}</current_profile>`;
};

const buildAutoPlayerContextXml = (
    latestOptions: string[],
    currentProfile: PlayerProfile,
    currentTasks: TaskGuideItem[],
    latestImageBase64: string | null | undefined
) => {
    const toolCallReminderPromptText = buildAutoPlayerToolCallReminderPromptText();
    const latestOptionsPromptText = formatLatestOptionsForXml(latestOptions);
    const currentProfilePromptText = buildAutoPlayerCurrentProfilePromptText(currentProfile);
    const currentTaskPromptText = formatCurrentTaskForXml(currentTasks);
    const latestImagesPromptText = buildLatestImagesPromptText(latestImageBase64);
    return `<auto_player_context>
${toolCallReminderPromptText}
${latestOptionsPromptText}
${currentProfilePromptText}
${currentTaskPromptText}
${latestImagesPromptText}
</auto_player_context>`;
};

const buildAutoPlayerRequestPayload = (
    systemInstruction: string,
    latestOptions: string[],
    currentProfile: PlayerProfile,
    currentTasks: TaskGuideItem[],
    latestImageBase64: string | null | undefined
): AutoPlayerRequestPayload => {
    const historyPromptText = buildHistoryConversationPromptText();
    const contextPromptText = buildAutoPlayerContextXml(
        latestOptions,
        currentProfile,
        currentTasks,
        latestImageBase64
    );
    const latestImageDataUrl = buildDebugImageDataUrl(latestImageBase64);
    const contents = buildConversationContentsFromHistory();
    const parts: any[] = [];

    if (latestImageBase64) {
        parts.push({
            inlineData: {
                data: latestImageBase64,
                mimeType: 'image/jpeg'
            }
        });
    }

    parts.push({ text: contextPromptText });
    contents.push({
        role: 'user',
        parts
    });

    return {
        contents,
        requestBlocks: [
            {
                key: 'system_prompt',
                title: 'System Prompt',
                promptText: systemInstruction
            },
            {
                key: 'history_conversation',
                title: 'History',
                promptText: historyPromptText
            },
            {
                key: 'auto_player_context',
                title: 'Auto Player Context',
                promptText: contextPromptText,
                ...(latestImageDataUrl ? { imageDataUrl: latestImageDataUrl } : {})
            }
        ]
    };
};

const normalizeFunctionCalls = (response: unknown): NormalizedFunctionCall[] => {
    if (!response || typeof response !== 'object') return [];

    const responseRecord = response as Record<string, unknown>;
    const directFunctionCalls = Array.isArray(responseRecord.functionCalls)
        ? responseRecord.functionCalls
        : [];

    const fallbackFromCandidates: unknown[] = [];
    const candidates = Array.isArray(responseRecord.candidates) ? responseRecord.candidates : [];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const candidateRecord = candidate as Record<string, unknown>;
        const content = candidateRecord.content;
        if (!content || typeof content !== 'object') continue;
        const contentRecord = content as Record<string, unknown>;
        const parts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            const partRecord = part as Record<string, unknown>;
            if (partRecord.functionCall) {
                fallbackFromCandidates.push(partRecord.functionCall);
            }
        }
    }

    const rawCalls = directFunctionCalls.length > 0 ? directFunctionCalls : fallbackFromCandidates;
    const normalized: NormalizedFunctionCall[] = [];
    for (const rawCall of rawCalls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const callRecord = rawCall as Record<string, unknown>;
        const rawName = typeof callRecord.name === 'string' ? callRecord.name.trim() : '';
        const argsValue = callRecord.args;
        const args =
            argsValue && typeof argsValue === 'object' && !Array.isArray(argsValue)
                ? (argsValue as Record<string, unknown>)
                : undefined;

        normalized.push({
            name: rawName || undefined,
            args
        });
    }

    return normalized;
};

const extractResponseTextParts = (response: unknown) => {
    if (!response || typeof response !== 'object') return '';

    const responseRecord = response as Record<string, unknown>;
    const candidates = Array.isArray(responseRecord.candidates) ? responseRecord.candidates : [];
    const textParts: string[] = [];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const candidateRecord = candidate as Record<string, unknown>;
        const content = candidateRecord.content;
        if (!content || typeof content !== 'object') continue;
        const contentRecord = content as Record<string, unknown>;
        const parts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            const partRecord = part as Record<string, unknown>;
            if (typeof partRecord.text !== 'string') continue;
            textParts.push(partRecord.text);
        }
    }

    return textParts.join('\n');
};

const buildDmOutputDebug = (
    storyResult: RequiredToolResult<TellStoryResult>,
    taskToolResult: OptionalTaskToolResult,
    playerProfileBefore: PlayerProfile,
    playerProfileAfter: PlayerProfile,
    tasksBefore: TaskGuideItem[],
    tasksAfter: TaskGuideItem[]
): DmOutputDebug => {
    const tellStoryText = toTrimmedString(storyResult.responseText);
    const taskManagerText = toTrimmedString(taskToolResult.responseText);
    const taskManagerCalled = taskToolResult.functionCalls.some(call => call.name === TASK_MANAGER_TOOL_NAME);
    const playerProfileToolCalled = storyResult.functionCalls.some(call => call.name === UPDATE_PLAYER_PROFILE_TOOL_NAME);

    const rawModelText =
        tellStoryText || taskManagerText
            ? {
                  ...(tellStoryText ? { tellStory: tellStoryText } : {}),
                  ...(taskManagerText ? { taskManager: taskManagerText } : {})
              }
            : undefined;

    return {
        tellStory: storyResult.payload,
        playerProfile: {
            updatedProfile: clonePlayerProfile(playerProfileAfter),
            updated: !arePlayerProfilesEqual(playerProfileBefore, playerProfileAfter),
            toolCalled: playerProfileToolCalled
        },
        taskManager: {
            called: taskManagerCalled,
            error: null
        },
        tasksBefore: cloneTaskItems(tasksBefore),
        tasksAfter: cloneTaskItems(tasksAfter),
        tasksChanged: !areTaskItemsEqual(tasksBefore, tasksAfter),
        ...(rawModelText ? { rawModelText } : {})
    };
};

const createStageError = (
    message: string,
    requestBlocks: DebugRequestBlock[],
    dmOutput: Record<string, unknown>,
    cause?: unknown
): StageError => {
    const error = new Error(message) as StageError;
    error.debugInfo = {
        dm: {
            requestBlocks,
            dmOutput
        },
        image: {
            requestBlocks: []
        }
    };
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
};

const parseTellStoryPayload = (value: unknown): TellStoryResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;

    const narrative = truncateByChars(toTrimmedString(record.narrative), DM_NARRATIVE_MAX_CHARS);
    const sceneMode = record.sceneMode;
    const sceneSignature = typeof record.sceneSignature === 'string' ? record.sceneSignature.trim() : '';
    const keyObjectChanges = toTrimmedString(record.keyObjectChanges);
    const nextChoices = sanitizeChoices(record.nextChoices);

    if (
        !narrative
        || !isSceneMode(sceneMode)
        || !keyObjectChanges
        || nextChoices.length < NEXT_CHOICE_MIN_COUNT
        || nextChoices.length > NEXT_CHOICE_MAX_COUNT
    ) {
        return null;
    }

    return {
        narrative,
        sceneMode,
        sceneSignature,
        keyObjectChanges,
        nextChoices
    };
};

const parseVisualDmPayload = (value: unknown): VisualDmResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const sceneDescription = toTrimmedString(record.sceneDescription);
    if (!sceneDescription) return null;
    return { sceneDescription };
};

const parseCreateWorldPayload = (value: unknown): CreateWorldResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const worldInfo = toTrimmedString(record.worldInfo);
    const referenceWork = toTrimmedString(record.referenceWork);
    if (!worldInfo || !referenceWork) return null;

    return {
        worldInfo,
        referenceWork
    };
};

const parseCreateCharacterPayload = (value: unknown): CreateCharacterResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedProfile = sanitizePlayerProfile(record.playerProfile);
    if (!parsedProfile) return null;

    return {
        playerProfile: parsedProfile
    };
};

const parsePlayerProfileUpdatePayload = (value: unknown): PlayerProfileUpdateResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedProfile = sanitizePlayerProfile(record.playerProfile);
    if (!parsedProfile) return null;

    return {
        playerProfile: parsedProfile
    };
};

const parseNextActionPayload = (value: unknown, outputLanguage: AppLanguage): NextActionResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const action = sanitizeAutoPlayerAction(record.action, outputLanguage);
    if (!action) return null;

    return { action };
};

const buildWorldCreatorSystemInstruction = (outputLanguage: AppLanguage) => {
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    return `<system_prompt>
<base_setup>
You are WorldCreator. You only create the world anchor and initial character profile. Do not advance story turns.
</base_setup>
<xml_schema_note>
<workflow>Execution order for this stage: world anchor first, initial character second.</workflow>
<tool_contract>Hard constraints for create_world/create_character calls. Detailed field constraints are defined by each tool schema.</tool_contract>
</xml_schema_note>
<workflow>
1. Parse the player's world requirement, including indirect clues (aliases, places, factions, character names).
2. Call create_world and return worldInfo + referenceWork (complete work title, any language/media).
3. If the player did not provide a complete work title, infer and fill the closest complete title.
4. Call create_character and return playerProfile.
5. Do not output plain text or freeform JSON.
</workflow>
<tool_contract>
- You must call both create_world and create_character.
- create_world returns only worldInfo and referenceWork.
- referenceWork must be non-empty and may be from any common language/media category.
- create_character returns only playerProfile.
- playerProfile textual fields must be written in ${escapeXml(outputLanguageLabel)}.
- All field-level constraints must follow tool schemas.
</tool_contract>
</system_prompt>`;
};

const buildDmSystemInstruction = (worldInfo: string, referenceWork: string, outputLanguage: AppLanguage) => {
    const safeWorldInfo = escapeXml(worldInfo || 'N/A');
    const normalizedReferenceWork = toTrimmedString(referenceWork);
    const safeReferenceWork = escapeXml(normalizedReferenceWork || 'N/A');
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    const referencePolicy = normalizedReferenceWork
        ? `- Reference anchor is ${safeReferenceWork}: characters, locations, factions, props, rules, and narrative tone must stay consistent with this world. Do not mix in other IP settings.`
        : '- If reference_work is missing, strictly follow world_info only and do not introduce cross-IP settings.';
    return `<system_prompt>
<base_setup>
You are a highly creative and causality-driven TRPG dungeon master (DM).
Your task is to advance the story based on player action and prior history, and return structured results via tools.
</base_setup>
<xml_schema_note>
<workflow>Per-turn order: reason first, call tools second, finalize narration last.</workflow>
<world_info>Stable world anchor. Do not rewrite it; only interpret or reference it.</world_info>
<reference_work>Stable reference-work anchor. Do not replace it with other IPs.</reference_work>
<tool_contract>Hard constraints for tool calls. Detailed field rules are defined by tool schemas.</tool_contract>
<narration_policy>Narration style and causal boundaries.</narration_policy>
<language_policy>
- Target output language for user-visible DM text fields is ${escapeXml(outputLanguageLabel)}.
- narrative, nextChoices, task name/content, and playerProfile textual fields must use ${escapeXml(outputLanguageLabel)}.
- Do not mix languages in a single field.
- sceneSignature and keyObjectChanges must remain English.
</language_policy>
</xml_schema_note>
<workflow>
1. Read history and current player action, then run causal reasoning.
2. You must call tell_story first to produce structured result for this turn.
3. You must call update_player_profile to return the latest full playerProfile for this turn.
</workflow>
<world_info>
${safeWorldInfo}
</world_info>
<reference_work>
${safeReferenceWork}
</reference_work>
<tool_contract>
- Every turn must call both tell_story and update_player_profile. Never output only plain text or raw JSON.
- Missing either required call is invalid.
- Field-level constraints must follow tool schemas first.
</tool_contract>
<narration_policy>
- ${referencePolicy}
- Maintain continuity with history and avoid causality-breaking jumps.
- If the player's action is unusual but still compatible with world setup and current player profile, prefer allowing the attempt to happen.
- For high-risk or uncertain actions, resolve with explicit cost, danger, tradeoff, or consequence instead of hard-blocking.
- If an action conflicts with hard world rules, convert it to the closest feasible in-world attempt and explain the constraint through narrative feedback.
- Player actions must produce explainable process, feedback, and results.
- You may introduce conflicts or side events, but they must stay consistent with world setup and history.
- keyObjectChanges must summarize key visible object/character expression, action, and position changes after this turn.
</narration_policy>
</system_prompt>`;
};

const getLatestNarrativeFromHistory = () => {
    for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index];
        if (item.role === 'model') {
            return toTrimmedString(item.text);
        }
    }
    return '';
};

const generateVisualSceneDescription = async (
    ai: GoogleGenAI,
    llmModel: string,
    worldInfo: string,
    referenceWork: string,
    lastNarrative: string,
    currentNarrative: string,
    sceneMode: SceneMode,
    sceneSignature: string,
    keyObjectChanges: string,
    referenceImageBase64: string | null | undefined
) => {
    const hasReferenceImage = Boolean(toTrimmedString(referenceImageBase64));
    const systemInstruction = buildVisualDmSystemInstruction(sceneMode, hasReferenceImage);
    const modePromptText = buildVisualDmModePromptText(sceneMode, hasReferenceImage);
    const contextPromptText = buildVisualDmContextXml(
        worldInfo,
        referenceWork,
        lastNarrative,
        currentNarrative,
        sceneMode,
        sceneSignature,
        keyObjectChanges
    );
    const visualDmRequestPayload = buildVisualDmRequestPayload(
        systemInstruction,
        contextPromptText,
        modePromptText,
        referenceImageBase64 || null
    );

    try {
        const visualDmToolResult = await collectRequiredFunctionCallsWithRetry(
            'VisualDM stage',
            () =>
                ai.models.generateContent({
                    model: llmModel,
                    contents: visualDmRequestPayload.contents,
                    config: {
                        systemInstruction,
                        temperature: 0.2,
                        maxOutputTokens: VISUAL_DM_MAX_OUTPUT_TOKENS,
                        tools: [{ functionDeclarations: [buildVisualDescribeSceneDeclaration(sceneMode)] }],
                        toolConfig: {
                            functionCallingConfig: {
                                mode: FunctionCallingConfigMode.ANY,
                                allowedFunctionNames: [VISUAL_DESCRIBE_SCENE_TOOL_NAME]
                            }
                        },
                        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                    }
                }),
            [{ name: VISUAL_DESCRIBE_SCENE_TOOL_NAME, parser: parseVisualDmPayload }]
        );
        const visualPayload = visualDmToolResult.payloadByTool[VISUAL_DESCRIBE_SCENE_TOOL_NAME] as VisualDmResult;
        const renderControlHeader = buildVisualRenderControlHeader(sceneMode, hasReferenceImage);
        const normalizedSceneBody = ensureFirstPersonSceneDescription(visualPayload.sceneDescription);
        return {
            sceneDescription: `${renderControlHeader}\n${normalizedSceneBody}`,
            requestBlocks: visualDmRequestPayload.requestBlocks,
            rawModelText: toTrimmedString(visualDmToolResult.responseText)
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        throw createStageError(
            `VisualDM stage failed. Reason: ${reason}`,
            visualDmRequestPayload.requestBlocks,
            {
                visualDmError: reason
            },
            error
        );
    }
};

const parseTaskManagerPayload = (value: unknown): TaskManagerResult | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.tasks)) return null;

    return {
        tasks: sanitizeTaskItems(record.tasks)
    };
};

interface RequiredToolSpec<T> {
    name: string;
    parser: (value: unknown) => T | null;
}

interface MultiRequiredToolResult {
    payloadByTool: Record<string, unknown>;
    functionCalls: NormalizedFunctionCall[];
    responseText: string;
}

const collectRequiredFunctionCallsWithRetry = async (
    label: string,
    operation: () => Promise<any>,
    requiredTools: RequiredToolSpec<unknown>[]
): Promise<MultiRequiredToolResult> => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= DM_SCHEMA_RETRIES; attempt++) {
        try {
            const response = await withRetry(operation);
            const functionCalls = normalizeFunctionCalls(response);
            const payloadByTool: Record<string, unknown> = {};
            let nextSearchIndex = 0;

            for (const requiredTool of requiredTools) {
                const targetIndex = functionCalls.findIndex(
                    (call, index) => index >= nextSearchIndex && call.name === requiredTool.name
                );
                if (targetIndex < 0) {
                    const observedNames = functionCalls
                        .map(call => call.name)
                        .filter((name): name is string => Boolean(name))
                        .join(', ');
                    const detail = observedNames ? ` Observed calls: ${observedNames}.` : ' Observed calls: none.';
                    throw new Error(`Missing required function call: ${requiredTool.name}.${detail}`);
                }
                nextSearchIndex = targetIndex + 1;

                const targetCall = functionCalls[targetIndex];

                const parsedPayload = requiredTool.parser(targetCall.args ?? null);
                if (!parsedPayload) {
                    throw new Error(`Malformed arguments for function call: ${requiredTool.name}`);
                }

                payloadByTool[requiredTool.name] = parsedPayload;
            }

            return {
                payloadByTool,
                functionCalls,
                responseText: extractResponseTextParts(response)
            };
        } catch (error) {
            lastError = error;
            console.warn(`${label} failed on attempt ${attempt}/${DM_SCHEMA_RETRIES}.`, error);
            if (attempt < DM_SCHEMA_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 400 * attempt));
            }
        }
    }

    const message = lastError instanceof Error ? lastError.message : 'unknown error';
    throw new Error(`${label} failed after retries. Stage failed, please retry. Reason: ${message}`);
};

const extractOptionalToolPayload = <T>(
    functionCalls: NormalizedFunctionCall[],
    optionalTool: RequiredToolSpec<T>
): T | null => {
    for (let index = functionCalls.length - 1; index >= 0; index--) {
        const call = functionCalls[index];
        if (call.name !== optionalTool.name) continue;
        const parsedPayload = optionalTool.parser(call.args ?? null);
        if (parsedPayload) return parsedPayload;
    }

    return null;
};

const collectOptionalTaskManagerUpdate = async (operation: () => Promise<any>): Promise<OptionalTaskToolResult> => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= DM_SCHEMA_RETRIES; attempt++) {
        try {
            const response = await withRetry(operation);
            const functionCalls = normalizeFunctionCalls(response);
            const targetCall = functionCalls.find(call => call.name === TASK_MANAGER_TOOL_NAME);

            if (!targetCall) {
                return {
                    payload: null,
                    functionCalls,
                    responseText: extractResponseTextParts(response)
                };
            }

            const parsedPayload = parseTaskManagerPayload(targetCall.args ?? null);
            if (!parsedPayload) {
                throw new Error('Malformed arguments for function call: task_manager');
            }

            return {
                payload: parsedPayload,
                functionCalls,
                responseText: extractResponseTextParts(response)
            };
        } catch (error) {
            lastError = error;
            console.warn(`Task manager stage failed on attempt ${attempt}/${DM_SCHEMA_RETRIES}.`, error);
            if (attempt < DM_SCHEMA_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 300 * attempt));
            }
        }
    }

    const message = lastError instanceof Error ? lastError.message : 'unknown error';
    throw new Error(`Task manager stage failed after retries. Reason: ${message}`);
};

const maybeUpdateTasks = async (
    ai: GoogleGenAI,
    globalSetting: string,
    currentPlayerProfile: PlayerProfile,
    playerAction: string,
    latestNarrative: string,
    turnNumber: number,
    outputLanguage: AppLanguage,
    llmModel: string
) => {
    const outputLanguageLabel = resolveOutputLanguageLabel(outputLanguage);
    const systemInstruction = `<system_prompt>
<base_setup>You are the task manager and maintain the current active task list.</base_setup>
<workflow>
1. Decide whether tasks changed based on history and current turn context.
2. If no task change: do not call tool, respond with NO_TASK_UPDATE.
3. If task changed: call task_manager and return the full updated task list.
</workflow>
<tool_contract>
- Field constraints and capacity limits follow task_manager tool schema.
- Prioritize main-quest stability and avoid noisy churn.
- Task name/content text must be in ${escapeXml(outputLanguageLabel)}.
</tool_contract>
</system_prompt>`;

    const promptText = buildTaskManagerContextXml(globalSetting, currentPlayerProfile, playerAction, latestNarrative, turnNumber);
    const requestBlocks: DebugRequestBlock[] = [
        {
            key: 'task_manager_system_prompt',
            title: 'Task Manager System Prompt',
            promptText: systemInstruction
        },
        {
            key: 'task_manager_context',
            title: 'Task Manager Context',
            promptText
        }
    ];
    const contents = [
        ...buildConversationContentsFromHistory(),
        {
            role: 'user',
            parts: [{ text: promptText }]
        }
    ];

    let toolResult: OptionalTaskToolResult;
    try {
        toolResult = await collectOptionalTaskManagerUpdate(() =>
            ai.models.generateContent({
                model: llmModel,
                contents,
                config: {
                    systemInstruction,
                    temperature: 0.2,
                    maxOutputTokens: 512,
                    tools: [{ functionDeclarations: [TASK_MANAGER_DECLARATION] }],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.AUTO
                        }
                    },
                    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                }
            })
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        throw createStageError(
            `Task manager stage failed. Reason: ${reason}`,
            requestBlocks,
            {
                taskManagerError: reason
            },
            error
        );
    }

    const nextTasks = toolResult.payload ? toolResult.payload.tasks : activeTasks;
    return {
        nextTasks: cloneTaskItems(nextTasks),
        toolResult
    };
};

export const generateAutoPlayerAction = async (
    input: AutoPlayerAgentInput
): Promise<AutoPlayerAgentResult> => {
    const apiKey = getApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const outputLanguage = input.outputLanguage || DEFAULT_OUTPUT_LANGUAGE;
    const behaviorMode = typeof input.behaviorMode === 'string' ? input.behaviorMode : '';
    const systemInstruction = buildAutoPlayerSystemInstruction(globalAnchor, currentReferenceWork, outputLanguage, behaviorMode);
    const resolvedLlmModel = toTrimmedString(input.llmModel) || DEFAULT_LLM_MODEL;
    const latestImageBase64 = toTrimmedString(input.latestImageBase64) || null;
    const sanitizedProfile = sanitizePlayerProfile(input.currentProfile) || clonePlayerProfile(playerProfile);
    const sanitizedTasks = sanitizeTaskItems(input.currentTasks);
    const autoPlayerRequestPayload = buildAutoPlayerRequestPayload(
        systemInstruction,
        input.latestOptions,
        sanitizedProfile,
        sanitizedTasks,
        latestImageBase64
    );
    const requestBlocks = autoPlayerRequestPayload.requestBlocks;

    const autoPlayerToolResult = await collectRequiredFunctionCallsWithRetry(
        'AutoPlayer stage',
        () =>
            ai.models.generateContent({
                model: resolvedLlmModel,
                contents: autoPlayerRequestPayload.contents,
                config: {
                    systemInstruction,
                    temperature: 0.2,
                    maxOutputTokens: AUTO_PLAYER_MAX_OUTPUT_TOKENS,
                    tools: [{ functionDeclarations: [NEXT_ACTION_DECLARATION] }],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.ANY,
                            allowedFunctionNames: [NEXT_ACTION_TOOL_NAME]
                        }
                    },
                    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                }
            }),
        [{ name: NEXT_ACTION_TOOL_NAME, parser: value => parseNextActionPayload(value, outputLanguage) }]
    );

    const nextActionPayload = autoPlayerToolResult.payloadByTool[NEXT_ACTION_TOOL_NAME] as NextActionResult;
    const action = sanitizeAutoPlayerAction(nextActionPayload.action, outputLanguage);
    if (!action) {
        throw new Error('AutoPlayerAgent returned an empty action.');
    }

    const rawModelText = toTrimmedString(autoPlayerToolResult.responseText || '');
    return {
        action,
        debug: {
            requestBlocks,
            outputAction: action,
            ...(rawModelText ? { rawModelText } : {})
        }
    };
};

export const initGame = async (
    prompt: string,
    imageRef?: string | null,
    quality: string = '1K',
    style: string = 'Minecraft',
    aspectRatio: string = '16:9',
    onPhaseChange?: (phase: ProcessingPhase) => void,
    onNarrativeStream?: NarrativeStreamHandler,
    outputLanguage: AppLanguage = DEFAULT_OUTPUT_LANGUAGE,
    llmModel: string = DEFAULT_LLM_MODEL,
    imageModel: string = DEFAULT_IMAGE_MODEL
) => {
    onPhaseChange?.('world');
    currentQuality = quality;
    currentStyle = style;
    currentAspectRatio = aspectRatio;
    history = [];
    globalAnchor = '';
    currentReferenceWork = '';
    playerProfile = clonePlayerProfile(DEFAULT_PLAYER_PROFILE);
    activeTasks = [];

    const apiKey = getApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const resolvedLlmModel = toTrimmedString(llmModel) || DEFAULT_LLM_MODEL;
    const resolvedImageModel = toTrimmedString(imageModel) || DEFAULT_IMAGE_MODEL;

    const worldCreatorModel = resolvedLlmModel;
    const worldCreatorSystemInstruction = buildWorldCreatorSystemInstruction(outputLanguage);
    const worldCreatorPrompt = `<world_creation_request>
<player_world_requirement>${escapeXml(prompt)}</player_world_requirement>
<output_expectation>Call create_world first, then create_character to finish world and initial player profile creation.</output_expectation>
</world_creation_request>`;

    const worldCreationToolResult = await collectRequiredFunctionCallsWithRetry(
        'World creator stage',
        () =>
            ai.models.generateContent({
                model: worldCreatorModel,
                contents: worldCreatorPrompt,
                config: {
                    systemInstruction: worldCreatorSystemInstruction,
                    maxOutputTokens: WORLD_CREATOR_MAX_OUTPUT_TOKENS,
                    tools: [{ functionDeclarations: [CREATE_WORLD_DECLARATION, CREATE_CHARACTER_DECLARATION] }],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.ANY,
                            allowedFunctionNames: [CREATE_WORLD_TOOL_NAME, CREATE_CHARACTER_TOOL_NAME]
                        }
                    },
                    thinkingConfig: { thinkingLevel: WORLD_CREATOR_THINKING_LEVEL }
                }
            }),
        [
            { name: CREATE_WORLD_TOOL_NAME, parser: parseCreateWorldPayload },
            { name: CREATE_CHARACTER_TOOL_NAME, parser: parseCreateCharacterPayload }
        ]
    );

    const createWorldPayload = worldCreationToolResult.payloadByTool[CREATE_WORLD_TOOL_NAME] as CreateWorldResult;
    const createCharacterPayload =
        worldCreationToolResult.payloadByTool[CREATE_CHARACTER_TOOL_NAME] as CreateCharacterResult;
    globalAnchor = createWorldPayload.worldInfo;
    currentReferenceWork = createWorldPayload.referenceWork;
    playerProfile = clonePlayerProfile(createCharacterPayload.playerProfile);

    onPhaseChange?.('dm');

    const dmModel = resolvedLlmModel;
    const systemInstruction = buildDmSystemInstruction(globalAnchor, currentReferenceWork, outputLanguage);
    const openingTurnContextPromptText = buildOpeningTurnContextXml(
        globalAnchor,
        playerProfile,
        currentReferenceWork,
        outputLanguage
    );
    const openingTurnHint =
        'Generate the opening turn with clear action space and initial conflict, then ensure tell_story and update_player_profile are called.';
    const openingActDirectionPrompt: DebugRequestBlock = {
        key: 'opening_act_direction',
        title: 'Opening Act Direction',
        promptText: buildOpeningActDirectionPromptText(currentReferenceWork, prompt)
    };
    const dmRequestPayload = buildDmRequestPayload(
        systemInstruction,
        openingTurnContextPromptText,
        prompt,
        openingTurnHint,
        imageRef || null,
        [openingActDirectionPrompt],
        { allowOpeningActDirectionBlock: true }
    );

    const dmToolResult = await collectRequiredFunctionCallsWithRetry(
        'Initial DM stage',
        () =>
            ai.models.generateContent({
                model: dmModel,
                contents: dmRequestPayload.contents,
                config: {
                    systemInstruction,
                    maxOutputTokens: DM_MAX_OUTPUT_TOKENS,
                    tools: [{ functionDeclarations: [TELL_STORY_DECLARATION, UPDATE_PLAYER_PROFILE_DECLARATION] }],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.ANY,
                            allowedFunctionNames: [TELL_STORY_TOOL_NAME, UPDATE_PLAYER_PROFILE_TOOL_NAME]
                        }
                    },
                    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                }
            }),
        [{ name: TELL_STORY_TOOL_NAME, parser: parseTellStoryPayload }]
    );

    const storyPayload = dmToolResult.payloadByTool[TELL_STORY_TOOL_NAME] as TellStoryResult;
    const playerProfileUpdatePayload = extractOptionalToolPayload(dmToolResult.functionCalls, {
        name: UPDATE_PLAYER_PROFILE_TOOL_NAME,
        parser: parsePlayerProfileUpdatePayload
    });
    const storyResult: RequiredToolResult<TellStoryResult> = {
        payload: storyPayload,
        functionCalls: dmToolResult.functionCalls,
        responseText: dmToolResult.responseText
    };

    const playerProfileBeforeTurn = clonePlayerProfile(playerProfile);
    if (playerProfileUpdatePayload) {
        playerProfile = clonePlayerProfile(playerProfileUpdatePayload.playerProfile);
    }

    const narrative = storyPayload.narrative;
    const sceneMode: SceneMode = storyPayload.sceneMode;
    const sceneSignature =
        sceneMode === 'transition'
            ? storyPayload.sceneSignature ||
              'new location, changed lighting, different faction presence, fresh hazards'
            : '';
    const lastNarrative = getLatestNarrativeFromHistory();
    const visualDmResult = await generateVisualSceneDescription(
        ai,
        resolvedLlmModel,
        globalAnchor,
        currentReferenceWork,
        lastNarrative,
        narrative,
        sceneMode,
        sceneSignature,
        storyPayload.keyObjectChanges,
        imageRef || null
    );
    onNarrativeStream?.(narrative);

    const taskUpdate = await maybeUpdateTasks(
        ai,
        globalAnchor,
        playerProfile,
        prompt,
        narrative,
        1,
        outputLanguage,
        resolvedLlmModel
    );
    const resolvedTasks = taskUpdate.nextTasks;
    const dmOutputDebug = buildDmOutputDebug(
        storyResult,
        taskUpdate.toolResult,
        playerProfileBeforeTurn,
        playerProfile,
        [],
        resolvedTasks
    );
    const debugInfo: DmDebugPayload = {
        requestBlocks: [...dmRequestPayload.requestBlocks, ...visualDmResult.requestBlocks],
        dmOutput: {
            ...dmOutputDebug,
            visualDm: {
                sceneDescription: visualDmResult.sceneDescription,
                ...(visualDmResult.rawModelText ? { rawModelText: visualDmResult.rawModelText } : {})
            },
            worldCreator: {
                systemInstruction: worldCreatorSystemInstruction,
                promptText: worldCreatorPrompt,
                output: {
                    worldInfo: createWorldPayload.worldInfo,
                    referenceWork: createWorldPayload.referenceWork,
                    playerProfile: clonePlayerProfile(createCharacterPayload.playerProfile)
                }
            }
        }
    };

    return await generateFrame(
        ai,
        prompt,
        visualDmResult.sceneDescription,
        narrative,
        imageRef,
        debugInfo,
        resolvedTasks,
        storyPayload.nextChoices,
        resolvedImageModel,
        onPhaseChange
    );
};

export const processAction = async (
    userInput: string,
    aspectRatio: string = '16:9',
    onPhaseChange?: (phase: ProcessingPhase) => void,
    onNarrativeStream?: NarrativeStreamHandler,
    referenceImageBase64?: string | null,
    outputLanguage: AppLanguage = DEFAULT_OUTPUT_LANGUAGE,
    llmModel: string = DEFAULT_LLM_MODEL,
    imageModel: string = DEFAULT_IMAGE_MODEL
) => {
    onPhaseChange?.('dm');
    currentAspectRatio = aspectRatio;

    const apiKey = getApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const resolvedLlmModel = toTrimmedString(llmModel) || DEFAULT_LLM_MODEL;
    const resolvedImageModel = toTrimmedString(imageModel) || DEFAULT_IMAGE_MODEL;

    const dmModel = resolvedLlmModel;
    const systemInstruction = buildDmSystemInstruction(globalAnchor, currentReferenceWork, outputLanguage);

    const turnNumber = Math.floor(history.length / 2) + 1;
    const forceSideEvent = turnNumber % 3 === 0;
    const travelIntent = /(去|前往|移动|赶往|转移|travel|go to|head to|move to)/i.test(userInput);
    const tasksBefore = cloneTaskItems(activeTasks);
    const playerProfileBeforeTurn = clonePlayerProfile(playerProfile);
    const turnContextXml = buildDmTurnContextXml(
        turnNumber,
        playerProfile,
        tasksBefore,
        forceSideEvent,
        travelIntent,
        currentReferenceWork,
        outputLanguage
    );
    const decisionFocusHint = 'First decide side-event triggering and scene switching, then call tell_story.';
    const dmRequestPayload = buildDmRequestPayload(
        systemInstruction,
        turnContextXml,
        userInput,
        decisionFocusHint,
        referenceImageBase64 || null,
        [],
        { allowOpeningActDirectionBlock: false }
    );

    const dmToolResult = await collectRequiredFunctionCallsWithRetry(
        'Action DM stage',
        () =>
            ai.models.generateContent({
                model: dmModel,
                contents: dmRequestPayload.contents,
                config: {
                    systemInstruction,
                    temperature: 0.7,
                    maxOutputTokens: DM_MAX_OUTPUT_TOKENS,
                    tools: [{ functionDeclarations: [TELL_STORY_DECLARATION, UPDATE_PLAYER_PROFILE_DECLARATION] }],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.ANY,
                            allowedFunctionNames: [TELL_STORY_TOOL_NAME, UPDATE_PLAYER_PROFILE_TOOL_NAME]
                        }
                    },
                    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                }
            }),
        [{ name: TELL_STORY_TOOL_NAME, parser: parseTellStoryPayload }]
    );

    const storyPayload = dmToolResult.payloadByTool[TELL_STORY_TOOL_NAME] as TellStoryResult;
    const playerProfileUpdatePayload = extractOptionalToolPayload(dmToolResult.functionCalls, {
        name: UPDATE_PLAYER_PROFILE_TOOL_NAME,
        parser: parsePlayerProfileUpdatePayload
    });
    const storyResult: RequiredToolResult<TellStoryResult> = {
        payload: storyPayload,
        functionCalls: dmToolResult.functionCalls,
        responseText: dmToolResult.responseText
    };

    const narrative = storyPayload.narrative;
    if (playerProfileUpdatePayload) {
        playerProfile = clonePlayerProfile(playerProfileUpdatePayload.playerProfile);
    }
    const sceneMode: SceneMode = storyPayload.sceneMode;
    const sceneSignature =
        sceneMode === 'transition'
            ? storyPayload.sceneSignature ||
              'new location, changed lighting, different faction presence, fresh hazards'
            : '';
    const lastNarrative = getLatestNarrativeFromHistory();
    const visualDmResult = await generateVisualSceneDescription(
        ai,
        resolvedLlmModel,
        globalAnchor,
        currentReferenceWork,
        lastNarrative,
        narrative,
        sceneMode,
        sceneSignature,
        storyPayload.keyObjectChanges,
        referenceImageBase64 || null
    );

    onNarrativeStream?.(narrative);

    const taskUpdate = await maybeUpdateTasks(
        ai,
        globalAnchor,
        playerProfile,
        userInput,
        narrative,
        turnNumber,
        outputLanguage,
        resolvedLlmModel
    );
    const resolvedTasks = taskUpdate.nextTasks;
    const debugInfo: DmDebugPayload = {
        requestBlocks: [...dmRequestPayload.requestBlocks, ...visualDmResult.requestBlocks],
        dmOutput: buildDmOutputDebug(
            storyResult,
            taskUpdate.toolResult,
            playerProfileBeforeTurn,
            playerProfile,
            tasksBefore,
            resolvedTasks
        )
    };
    debugInfo.dmOutput.visualDm = {
        sceneDescription: visualDmResult.sceneDescription,
        ...(visualDmResult.rawModelText ? { rawModelText: visualDmResult.rawModelText } : {})
    };

    return await generateFrame(
        ai,
        userInput,
        visualDmResult.sceneDescription,
        narrative,
        referenceImageBase64 || null,
        debugInfo,
        resolvedTasks,
        storyPayload.nextChoices,
        resolvedImageModel,
        onPhaseChange
    );
};

const generateFrame = async (
    ai: GoogleGenAI,
    userInput: string,
    sceneDescription: string,
    narrative: string,
    referenceImage: string | null | undefined,
    debugInfo: DmDebugPayload,
    resolvedTasks: TaskGuideItem[],
    nextChoices: string[],
    imageModel: string,
    onPhaseChange?: (phase: ProcessingPhase) => void
) => {
    onPhaseChange?.('render');

    const worldConsistencyRequirement = buildWorldConsistencyRequirement(currentReferenceWork, currentStyle);
    const styleRequirement = buildStyleRequirement(currentStyle, currentReferenceWork);
    const normalizedSceneDescription = ensureFirstPersonSceneDescription(sceneDescription);
    const finalPrompt = `${normalizedSceneDescription}
${worldConsistencyRequirement}
${styleRequirement}`;

    const parts: any[] = [];

    if (referenceImage) {
        parts.push({
            inlineData: {
                data: referenceImage,
                mimeType: 'image/jpeg'
            }
        });
    }
    parts.push({ text: finalPrompt });

    const imgResponse = await withRetry(
        () =>
            ai.models.generateContent({
                model: imageModel,
                contents: { parts },
                config: {
                    imageConfig: {
                        aspectRatio: currentAspectRatio,
                        imageSize: currentQuality
                    }
                }
            }),
        4,
        2000
    );

    let newImageBase64 = '';
    let mimeType = 'image/jpeg';
    if (imgResponse.candidates && imgResponse.candidates[0].content.parts) {
        for (const part of imgResponse.candidates[0].content.parts) {
            if (part.inlineData) {
                newImageBase64 = part.inlineData.data;
                if (part.inlineData.mimeType) {
                    mimeType = part.inlineData.mimeType;
                }
                break;
            }
        }
    }

    if (!newImageBase64) {
        throw new Error('Failed to generate image. The model might have blocked the request.');
    }

    activeTasks = cloneTaskItems(resolvedTasks);
    history.push({ role: 'user', text: userInput });
    history.push({ role: 'model', text: narrative });
    const referenceImageDataUrl = buildDebugImageDataUrl(referenceImage);

    const imageDebugInfo = {
        requestBlocks: [
            {
                key: 'reference_image',
                title: 'Reference Image',
                promptText: buildReferenceImagePromptText(referenceImage),
                ...(referenceImageDataUrl ? { imageDataUrl: referenceImageDataUrl } : {})
            },
            {
                key: 'image_generation_prompt',
                title: 'Image Generation Prompt',
                promptText: finalPrompt
            }
        ]
    };

    const fullDebugInfo = {
        dm: debugInfo,
        image: imageDebugInfo
    };

    return {
        imageBase64: newImageBase64,
        mimeType,
        narrative,
        playerProfile: clonePlayerProfile(playerProfile),
        tasks: cloneTaskItems(activeTasks),
        nextChoices: sanitizeChoices(nextChoices),
        debugInfo: fullDebugInfo
    };
};
