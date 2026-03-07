import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from '@/locales/zh-CN/common.json';
import en from '@/locales/en/common.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCN },
      en: { common: en },
    },
    defaultNS: 'common',
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'oxidenote-lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
