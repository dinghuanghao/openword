export type AppLanguage = 'en-US' | 'zh-CN';

export const APP_LANGUAGE_STORAGE_KEY = 'OPENWORD_UI_LANGUAGE';

export const APP_LANGUAGES: AppLanguage[] = ['en-US', 'zh-CN'];

export const DEFAULT_APP_LANGUAGE: AppLanguage = 'en-US';

export const resolveAppLanguage = (value: string | null | undefined): AppLanguage => {
    if (!value) return DEFAULT_APP_LANGUAGE;

    const normalized = value.toLowerCase();
    if (normalized.startsWith('zh')) return 'zh-CN';
    if (normalized.startsWith('en')) return 'en-US';

    return DEFAULT_APP_LANGUAGE;
};
