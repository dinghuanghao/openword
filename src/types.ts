export interface DebugInfo {
    dm: {
        requestBlocks: DebugRequestBlock[];
        dmOutput: any;
    };
    image: {
        requestBlocks: DebugRequestBlock[];
    };
    agent?: {
        requestBlocks: DebugRequestBlock[];
        outputAction?: string;
        rawModelText?: string;
    };
}

export interface DebugRequestBlock {
    key: string;
    title: string;
    promptText: string;
    imageDataUrl?: string;
}
