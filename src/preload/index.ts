import { contextBridge, ipcRenderer } from 'electron'
import type { ChatEvent, ChatMeta, PermissionDecision, ProjectInfo, ThreadItem } from '../shared/types'

const api = {
  listChats: (): Promise<ChatMeta[]> => ipcRenderer.invoke('chats:list'),
  createChat: (opts?: { newProjectName?: string }): Promise<ChatMeta | null> =>
    ipcRenderer.invoke('chats:create', opts),
  getProjectsRoot: (): Promise<string> => ipcRenderer.invoke('projects:root'),
  deleteChat: (chatId: string): Promise<ChatMeta[]> => ipcRenderer.invoke('chats:delete', chatId),
  sendMessage: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chats:send', chatId, text),
  respondPermission: (chatId: string, decision: PermissionDecision): Promise<void> =>
    ipcRenderer.invoke('chats:permission', chatId, decision),
  interrupt: (chatId: string): Promise<void> => ipcRenderer.invoke('chats:interrupt', chatId),
  getItems: (chatId: string): Promise<ThreadItem[]> => ipcRenderer.invoke('chats:items', chatId),
  getRaw: (chatId: string): Promise<unknown[]> => ipcRenderer.invoke('chats:raw', chatId),
  getProjectInfo: (cwd: string): Promise<ProjectInfo> => ipcRenderer.invoke('project:info', cwd),
  onChatEvent: (callback: (event: ChatEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: ChatEvent): void => callback(event)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  }
}

export type SwitchboardApi = typeof api

contextBridge.exposeInMainWorld('switchboard', api)
