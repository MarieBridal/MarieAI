
export enum Tab {
  VIP = 'vip',
  CHAT = 'chat',
  ANALYZE = 'analyze',
  DESIGN = 'design'
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
