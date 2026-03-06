const zhCN = {
    common: {
        appName: '字 游 世 界｜OpenWord',
        home: '主页',
        story: '剧情',
        dm: 'DM',
        you: '你',
        world: '世界',
        status: '状态',
        skills: '技能',
        items: '物品',
        style: '风格',
        quality: '画质',
        language: '语言',
        llmModel: '语言模型',
        imageModel: '图像模型',
        apiKey: 'API Key',
        english: 'English',
        simplifiedChinese: '简体中文',
        noStoryYet: '暂无剧情。',
        noActiveTasks: '暂无进行中的任务。',
        noSkills: '暂无技能。',
        noItems: '暂无物品。',
        replay: '重放',
        restore: '回退',
        import: '导入',
        export: '导出',
        exportAll: '批量导出',
        save: '保存',
        or: '或'
    },
    home: {
        subtitle: '句句成画，步步为局。',
        worldInputPlaceholder: '描述世界设定并开始...',
        recentGames: '最近游戏'
    },
    keyModal: {
        title: '配置 API Key',
        description: '该游戏需要配置 GEMINI_API_KEY 才能使用 Gemini 3.1 Pro 与 Nano Banana 2 模型。',
        option1: '输入 GEMINI_API_KEY',
        inputPlaceholder: '输入 Gemini API Key...'
    },
    config: {
        title: '设置',
        customInput: '自定义输入',
        customLlmPlaceholder: '输入自定义语言模型 ID...',
        customImagePlaceholder: '输入自定义图像模型 ID...',
        agentBehaviorModeLabel: 'Agent 行为模式',
        agentBehaviorModePlaceholder: '输入行为模式（默认：你是一个天马行空的极客，优先选择高风险、非常规但可执行的激进行动，必要时打破常规流程，但你本身是善良的，不会做出非常邪恶的事。）',
        currentStyle: '当前风格：{{style}}'
    },
    bridge: {
        connect: '连接 API Bridge',
        disconnect: '断开 API Bridge',
        statusLabel: 'Bridge 状态',
        status: {
            disconnected: '未连接',
            connecting: '连接中...',
            connected: '已连接',
            occupied: '已被其他标签页占用，请先断开那一页。',
            error: '连接异常'
        },
        errors: {
            busy: '当前正在处理中，请稍后再试。',
            gameNotLoaded: '未加载游戏。',
            imageNotAvailable: '当前场景图片不可用。'
        }
    },
    debug: {
        title: '调试上下文',
        noDmData: '暂无可用 DM 调试数据。',
        noVisualDmData: '暂无可用 VisualDM 调试数据。',
        noImageData: '暂无可用图像调试数据。',
        noAgentData: '暂无可用 Agent 调试数据。',
        dmOutputJson: 'DM 输出 (JSON)',
        visualDmOutputJson: 'VisualDM 输出 (JSON)',
        agentOutput: 'Agent 输出 (JSON)',
        openDm: '调试 DM'
    },
    player: {
        profile: '角色信息',
        openProfile: '打开角色信息'
    },
    input: {
        startPlaceholder: '描述世界设定并开始（例如：赛博朋克城市，站在高楼天台）',
        nextPlaceholder: '你接下来要做什么？',
        pressSpaceToInput: '按“空格”进行输入'
    },
    autoPlayer: {
        enableTitle: '开启自动模式',
        disableTitle: '关闭自动模式',
        thinking: '自动玩家思考中...',
        typing: '自动玩家输入中...'
    },
    replay: {
        stopHint: '重放中，按 Esc 或空格停止'
    },
    processing: {
        world: '正在塑造世界观...',
        dm: '正在推衍剧情...',
        render: '正在渲染世界...'
    },
    coverHints: {
        shapingWorld: '正在塑造世界观...',
        rewritingGeography: '正在重绘地理版图与关键地点...',
        generatingFactions: '正在生成势力关系与时代冲突...',
        loadingStoryThreads: '正在编织主线与支线剧情...',
        preparingOpeningScene: '正在准备你的开场镜头...'
    },
    navigation: {
        backHome: '返回主页',
        openStory: '打开剧情 (H)',
        previousPage: '上一页',
        nextPage: '下一页',
        deleteHistory: '删除历史记录',
        delete: '删除',
        uploadReferenceImage: '上传参考图'
    },
    accessibility: {
        referenceImage: '参考图片',
        currentView: '当前视角',
        nextView: '下一视角',
        worldCover: '世界生成封面轮播图'
    },
    save: {
        notFound: '未找到对应存档。'
    },
    story: {
        checkpoint: '检查点 {{index}}',
        debugRound: '第 {{roundNumber}} 轮'
    },
    task: {
        mainPrefix: '【主线任务】',
        sidePrefix: '【支线任务】'
    },
    errors: {
        importSaveFailed: '导入存档失败。',
        loadSavedGameFailed: '读取历史游戏失败。',
        deleteSavedGameFailed: '删除历史记录失败。',
        imageLoadFailed: '生成图片加载失败，图片数据可能无效。',
        autoPlayerFailed: '自动玩家执行失败，已关闭自动模式。',
        actionFailed: '发生错误。',
        discardInFlightConfirm: '当前仍在生成中，返回主页将丢弃本回合尚未完成的新内容。是否继续？',
        saveReadFailed: '读取存档列表失败。',
        exportBatchSaveFailed: '批量导出存档失败。'
    },
    styles: {
        minecraft: 'Minecraft',
        pixelArt: '像素',
        pixelArt3d: '体素',
        realistic: '原版',
        claymation: '粘土艺术'
    }
} as const;

export default zhCN;
