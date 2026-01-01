"use client";

import { useState, useEffect, useCallback } from "react";
import type { Conversation, Message, ConversationsState } from "@/types/conversation";

const STORAGE_KEY = "voice-assistant-conversations";

const generateAvatarSeed = () => {
  return Math.random().toString(36).substring(2, 15);
};

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed: ConversationsState = JSON.parse(stored);
        setConversations(parsed.conversations || []);
        setActiveConversationId(parsed.activeConversationId);
      } catch {
        // Invalid data, start fresh
      }
    }
  }, []);

  // Save to localStorage whenever state changes
  useEffect(() => {
    const state: ConversationsState = {
      conversations,
      activeConversationId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [conversations, activeConversationId]);

  const activeConversation = conversations.find(c => c.id === activeConversationId) || null;

  const createConversation = useCallback(() => {
    const newConversation: Conversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      avatarSeed: generateAvatarSeed(),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setConversations(prev => [newConversation, ...prev]);
    setActiveConversationId(newConversation.id);
    return newConversation;
  }, []);

  const switchConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
  }, [activeConversationId]);

  const addMessage = useCallback((conversationId: string, message: Message) => {
    setConversations(prev => prev.map(c => {
      if (c.id === conversationId) {
        return {
          ...c,
          messages: [...c.messages, message],
          updatedAt: Date.now(),
        };
      }
      return c;
    }));
  }, []);

  const updateTitle = useCallback((conversationId: string, title: string) => {
    setConversations(prev => prev.map(c => {
      if (c.id === conversationId) {
        return { ...c, title };
      }
      return c;
    }));
  }, []);

  const generateTitle = useCallback(async (conversationId: string, userMessage: string, assistantMessage: string) => {
    try {
      const res = await fetch("/api/generate-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userMessage, assistantMessage }),
      });
      if (res.ok) {
        const { title } = await res.json();
        updateTitle(conversationId, title);
      }
    } catch {
      // Keep default title on error
    }
  }, [updateTitle]);

  return {
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    switchConversation,
    deleteConversation,
    addMessage,
    updateTitle,
    generateTitle,
  };
}
