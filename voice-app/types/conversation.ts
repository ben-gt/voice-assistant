export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolsUsed?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  avatarSeed: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationsState {
  conversations: Conversation[];
  activeConversationId: string | null;
}
