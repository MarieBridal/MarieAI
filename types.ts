
export enum Tab {
  VIP = 'vip',
  V2 = 'v2',
  V3 = 'v3',
  CHAT = 'chat',
  ANALYZE = 'analyze'
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  image?: string;
}

export interface ImageOperation {
  id: string;
  prompt: string;
  originalUrl?: string;
  resultUrl: string;
  type: 'edit' | 'upscale' | 'generate';
  status: 'processing' | 'completed' | 'error';
  timestamp: number;
}
