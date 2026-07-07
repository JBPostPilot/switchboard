import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatEvent,
  ChatMeta,
  EditorApp,
  ModelChoice,
  PermissionDecision,
  PermissionModeChoice,
  ProjectInfo,
  ThreadItem
} from '../shared/types'

const api = {
  listChats: (): Promise<ChatMeta[]> => ipcRenderer.invoke('chats:list'),
  createChat: (opts?: { newProjectName?: string }): Promise<ChatMeta | null> =>
    ipcRenderer.invoke('chats:create', opts),
  getProjectsRoot: (): Promise<string> => ipcRenderer.invoke('projects:root'),
  chooseProjectsRoot: (): Promise<string> => ipcRenderer.invoke('projects:choose-root'),
  deleteChat: (chatId: string): Promise<ChatMeta[] | null> =>
    ipcRenderer.invoke('chats:delete', chatId),
  onOpenChat: (callback: (chatId: string) => void): (() => void) => {
    const listener = (_e: unknown, chatId: string): void => callback(chatId)
    ipcRenderer.on('notification:open', listener)
    return () => ipcRenderer.removeListener('notification:open', listener)
  },
  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const listener = (_e: unknown, action: string): void => callback(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  sendMessage: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chats:send', chatId, text),
  respondPermission: (chatId: string, decision: PermissionDecision): Promise<void> =>
    ipcRenderer.invoke('chats:permission', chatId, decision),
  respondQuestion: (chatId: string, answers: Record<string, string> | null): Promise<void> =>
    ipcRenderer.invoke('chats:answer', chatId, answers),
  interrupt: (chatId: string): Promise<void> => ipcRenderer.invoke('chats:interrupt', chatId),
  setModel: (chatId: string, model?: string): Promise<void> =>
    ipcRenderer.invoke('chats:set-model', chatId, model),
  listModels: (): Promise<ModelChoice[]> => ipcRenderer.invoke('models:list'),
  setPermissionMode: (chatId: string, mode: PermissionModeChoice): Promise<void> =>
    ipcRenderer.invoke('chats:set-permission-mode', chatId, mode),
  getItems: (chatId: string): Promise<ThreadItem[]> => ipcRenderer.invoke('chats:items', chatId),
  getRaw: (chatId: string): Promise<unknown[]> => ipcRenderer.invoke('chats:raw', chatId),
  getProjectInfo: (cwd: string): Promise<ProjectInfo> => ipcRenderer.invoke('project:info', cwd),
  revealInFinder: (cwd: string): Promise<void> => ipcRenderer.invoke('project:reveal', cwd),
  listEditors: (): Promise<EditorApp[]> => ipcRenderer.invoke('project:editors'),
  openInEditor: (cwd: string, editorName: string): Promise<void> =>
    ipcRenderer.invoke('project:open-in', cwd, editorName),
  onChatEvent: (callback: (event: ChatEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: ChatEvent): void => callback(event)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  }
}

export type SwitchboardApi = typeof api

contextBridge.exposeInMainWorld('switchboard', api)
