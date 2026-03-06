import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import enUS from './resources/en-US';
import zhCN from './resources/zh-CN';
import { APP_LANGUAGE_STORAGE_KEY, APP_LANGUAGES, DEFAULT_APP_LANGUAGE, resolveAppLanguage } from './types';

void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            'en-US': {
                translation: enUS
            },
            'zh-CN': {
                translation: zhCN
            }
        },
        fallbackLng: DEFAULT_APP_LANGUAGE,
        supportedLngs: APP_LANGUAGES,
        interpolation: {
            escapeValue: false
        },
        detection: {
            order: ['localStorage', 'navigator'],
            lookupLocalStorage: APP_LANGUAGE_STORAGE_KEY,
            caches: ['localStorage'],
            convertDetectedLanguage: (language: string) => resolveAppLanguage(language)
        }
    });

export default i18n;
