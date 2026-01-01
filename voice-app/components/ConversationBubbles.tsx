"use client";

import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
import { bottts } from "@dicebear/collection";
import type { Conversation } from "@/types/conversation";

interface ConversationBubblesProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onDelete: (id: string) => void;
}

function Avatar({ seed, size = 48 }: { seed: string; size?: number }) {
  const avatarSvg = useMemo(() => {
    const avatar = createAvatar(bottts, {
      seed,
      size,
      backgroundColor: ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf"],
    });
    return avatar.toDataUri();
  }, [seed, size]);

  return (
    <img
      src={avatarSvg}
      alt="Conversation avatar"
      className="w-full h-full rounded-full"
    />
  );
}

export function ConversationBubbles({
  conversations,
  activeConversationId,
  onSelect,
  onNewConversation,
  onDelete,
}: ConversationBubblesProps) {
  // Show max 5 most recent conversations
  const visibleConversations = conversations.slice(0, 5);

  return (
    <div className="fixed bottom-6 right-6 flex flex-col-reverse items-center gap-3 z-50">
      {/* New conversation button */}
      <button
        onClick={onNewConversation}
        className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg hover:shadow-xl hover:scale-110 transition-all duration-200 flex items-center justify-center"
        title="New conversation"
      >
        <PlusIcon className="w-6 h-6" />
      </button>

      {/* Conversation bubbles */}
      {visibleConversations.map((conversation) => {
        const isActive = conversation.id === activeConversationId;
        return (
          <div key={conversation.id} className="relative group">
            <button
              onClick={() => onSelect(conversation.id)}
              className={`relative rounded-full shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-110 ${
                isActive
                  ? "w-14 h-14 ring-3 ring-indigo-500 ring-offset-2"
                  : "w-12 h-12"
              }`}
              title={conversation.title}
            >
              <Avatar seed={conversation.avatarSeed} size={isActive ? 56 : 48} />
              {conversation.messages.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-indigo-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
                  {conversation.messages.length > 99 ? "99+" : conversation.messages.length}
                </span>
              )}
            </button>

            {/* Delete button on hover */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conversation.id);
              }}
              className="absolute -top-1 -left-1 w-5 h-5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center hover:bg-red-600"
              title="Delete conversation"
            >
              <XIcon className="w-3 h-3" />
            </button>

            {/* Title tooltip */}
            <div className="absolute right-full mr-3 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none">
              {conversation.title}
              <div className="absolute left-full top-1/2 -translate-y-1/2 border-4 border-transparent border-l-gray-900" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
