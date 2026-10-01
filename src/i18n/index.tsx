import { createContext, useContext, type ReactNode } from 'react';

const messages = { title: '野外巡护离线调查', sync: '同步队列', review: '负责人复核', save: '保存现场记录' };
const I18nContext = createContext(messages);
export function I18nProvider({ children }: { children: ReactNode }) { return <I18nContext.Provider value={messages}>{children}</I18nContext.Provider>; }
export const useI18n = () => useContext(I18nContext);
