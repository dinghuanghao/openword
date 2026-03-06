const enUS = {
    common: {
        appName: '字 游 世 界｜OpenWord',
        home: 'Home',
        story: 'Story',
        dm: 'DM',
        you: 'You',
        world: 'World',
        status: 'Status',
        skills: 'Skills',
        items: 'Items',
        style: 'Style',
        quality: 'Quality',
        language: 'Language',
        llmModel: 'Language Model',
        imageModel: 'Image Model',
        apiKey: 'API Key',
        english: 'English',
        simplifiedChinese: 'Simplified Chinese',
        noStoryYet: 'No story yet.',
        noActiveTasks: 'No active tasks.',
        noSkills: 'No skills.',
        noItems: 'No items.',
        replay: 'Replay',
        restore: 'Restore',
        import: 'Import',
        export: 'Export',
        exportAll: 'Export All',
        save: 'Save',
        or: 'OR'
    },
    home: {
        subtitle: 'Dream it. Type it. Play it.',
        worldInputPlaceholder: 'Describe the world to begin...',
        recentGames: 'Recent Games'
    },
    keyModal: {
        title: 'Configure API Key',
        description: 'This game requires GEMINI_API_KEY to use Gemini 3.1 Pro and Nano Banana 2 models.',
        option1: 'Enter GEMINI_API_KEY',
        inputPlaceholder: 'Enter Gemini API Key...'
    },
    config: {
        title: 'Config',
        customInput: 'Custom Input',
        customLlmPlaceholder: 'Enter custom language model ID...',
        customImagePlaceholder: 'Enter custom image model ID...',
        agentBehaviorModeLabel: 'Agent Behavior Mode',
        agentBehaviorModePlaceholder: 'Enter behavior mode (default: You are a wildly imaginative geek. Prioritize high-risk, unconventional but executable actions, break normal workflows when necessary, but remain kind and never do truly evil things.)',
        currentStyle: 'Current style: {{style}}'
    },
    bridge: {
        connect: 'Connect API Bridge',
        disconnect: 'Disconnect API Bridge',
        statusLabel: 'Bridge Status',
        status: {
            disconnected: 'Disconnected',
            connecting: 'Connecting...',
            connected: 'Connected',
            occupied: 'Occupied by another tab. Disconnect that tab first.',
            error: 'Connection error'
        },
        errors: {
            busy: 'Game is busy. Try again later.',
            gameNotLoaded: 'No game is currently loaded.',
            imageNotAvailable: 'Current scene image is not available.'
        }
    },
    debug: {
        title: 'Debug Context',
        noDmData: 'No DM debug data available.',
        noVisualDmData: 'No VisualDM debug data available.',
        noImageData: 'No image debug data available.',
        noAgentData: 'No agent debug data available.',
        dmOutputJson: 'DM Output (JSON)',
        visualDmOutputJson: 'VisualDM Output (JSON)',
        agentOutput: 'Agent Output (JSON)',
        openDm: 'Debug DM'
    },
    player: {
        profile: 'Player Profile',
        openProfile: 'Open player profile'
    },
    input: {
        startPlaceholder: 'Describe the world to begin (e.g., Cyberpunk city, standing on a rooftop)',
        nextPlaceholder: 'What do you do next?',
        pressSpaceToInput: 'Press "Space" to input'
    },
    autoPlayer: {
        enableTitle: 'Enable auto mode',
        disableTitle: 'Disable auto mode',
        thinking: 'Auto player is thinking...',
        typing: 'Auto player is typing...'
    },
    replay: {
        stopHint: 'Replaying, press Esc or Space to stop'
    },
    processing: {
        world: 'Shaping the world...',
        dm: 'Advancing the story...',
        render: 'Rendering the world...'
    },
    coverHints: {
        shapingWorld: 'Shaping the world...',
        rewritingGeography: 'Redrawing geography and key locations...',
        generatingFactions: 'Generating factions and era conflicts...',
        loadingStoryThreads: 'Weaving mainline and side story threads...',
        preparingOpeningScene: 'Preparing your opening scene...'
    },
    navigation: {
        backHome: 'Back to home',
        openStory: 'Open story (H)',
        previousPage: 'Previous page',
        nextPage: 'Next page',
        deleteHistory: 'Delete history',
        delete: 'Delete',
        uploadReferenceImage: 'Upload reference image'
    },
    accessibility: {
        referenceImage: 'Reference image',
        currentView: 'Current view',
        nextView: 'Next view',
        worldCover: 'World creation cover slideshow'
    },
    save: {
        notFound: 'Saved game was not found.'
    },
    story: {
        checkpoint: 'Checkpoint {{index}}',
        debugRound: 'Round {{roundNumber}}'
    },
    task: {
        mainPrefix: '[Main Quest]',
        sidePrefix: '[Side Quest]'
    },
    errors: {
        importSaveFailed: 'Failed to import save file.',
        loadSavedGameFailed: 'Failed to load saved game.',
        deleteSavedGameFailed: 'Failed to delete saved game.',
        imageLoadFailed: 'Failed to load generated image. The image data might be invalid.',
        autoPlayerFailed: 'Auto player failed and was turned off.',
        actionFailed: 'An error occurred.',
        discardInFlightConfirm: 'Generation is still in progress. Returning home will discard unfinished content from this turn. Continue?',
        saveReadFailed: 'Failed to read saved games.',
        exportBatchSaveFailed: 'Failed to export saved games in batch.'
    },
    styles: {
        minecraft: 'Minecraft',
        pixelArt: '2D Pixel Art',
        pixelArt3d: '3D Pixel Art',
        realistic: 'Vanilla',
        claymation: 'Claymation'
    }
} as const;

export default enUS;
