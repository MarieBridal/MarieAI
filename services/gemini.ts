
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

export type NoiseProfile = 'digital' | 'film' | 'coarse' | 'quantum';
export type ImageQuality = '1K' | '2K' | '4K' | '6K';

export interface TextNode {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  hexColor: string;
  fontFamily: string;
}

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export const checkApiKey = async (): Promise<boolean> => {
  if (typeof window !== 'undefined' && localStorage.getItem('GEMINI_API_KEY')) {
    return true;
  }
  if (typeof window.aistudio?.hasSelectedApiKey === 'function') {
    return await window.aistudio.hasSelectedApiKey();
  }
  return !!process.env.API_KEY;
};

export const openKeySelector = async () => {
  if (typeof window.aistudio?.openSelectKey === 'function') {
    await window.aistudio.openSelectKey();
    return;
  }

  const currentKey = localStorage.getItem('GEMINI_API_KEY') || '';
  const key = window.prompt("Vui lòng nhập Gemini API Key của bạn (Bắt đầu bằng AIza...).\nĐể trống để xóa key hiện tại:", currentKey);

  if (key !== null) {
    if (key.trim() === '') {
      localStorage.removeItem('GEMINI_API_KEY');
    } else {
      localStorage.setItem('GEMINI_API_KEY', key.trim());
    }
  }
};

export const getNearestGeminiRatio = (w: number, h: number): string => {
  const ratio = w / h;
  const targets = [
    { label: '1:1', value: 1 },
    { label: '4:3', value: 4 / 3 },
    { label: '3:4', value: 3 / 4 },
    { label: '16:9', value: 16 / 9 },
    { label: '9:16', value: 9 / 16 }
  ];
  return targets.reduce((prev, curr) =>
    Math.abs(curr.value - ratio) < Math.abs(prev.value - ratio) ? curr : prev
  ).label;
};

export async function optimizeReferenceImage(base64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxDim = 1024;
      let w = img.width;
      let h = img.height;
      if (w > h) {
        if (w > maxDim) { h = (h * maxDim) / w; w = maxDim; }
      } else {
        if (h > maxDim) { w = (w * maxDim) / h; h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error("Lỗi tối ưu hóa ảnh mẫu."));
    img.src = base64;
  });
}

function generateDynamicSeed(prompt: string, salt?: string): number {
  const baseStr = `${prompt}_${salt || "MARIE_STABLE"}`;
  let hash = 0;
  for (let i = 0; i < baseStr.length; i++) {
    const char = baseStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function applyNoiseToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  amount: number,
  maskImg?: HTMLImageElement | null,
  profile: NoiseProfile = 'digital'
) {
  if (amount <= 0) return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let maskData: Uint8ClampedArray | null = null;
  if (maskImg) {
    const mCanvas = document.createElement('canvas');
    mCanvas.width = width;
    mCanvas.height = height;
    const mCtx = mCanvas.getContext('2d')!;
    mCtx.drawImage(maskImg, 0, 0, width, height);
    maskData = mCtx.getImageData(0, 0, width, height).data;
  }

  const intensity = amount * 0.4;

  for (let i = 0; i < data.length; i += 4) {
    if (maskData && maskData[i] < 30) continue;

    let noise = 0;
    if (profile === 'digital') {
      noise = (Math.random() - 0.5) * intensity * 25.5;
    } else if (profile === 'film') {
      const r = (Math.random() + Math.random() + Math.random()) / 3;
      noise = (r - 0.5) * intensity * 35.5;
    } else if (profile === 'coarse') {
      const x = (i / 4) % width;
      const y = Math.floor((i / 4) / width);
      const blockSeed = Math.sin(Math.floor(x / 2) * 12.9898 + Math.floor(y / 2) * 78.233) * 43758.5453;
      noise = (blockSeed - Math.floor(blockSeed) - 0.5) * intensity * 45.5;
    } else if (profile === 'quantum') {
      noise = (Math.random() > 0.5 ? 1 : -1) * Math.random() * intensity * 50;
    }

    data[i] = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
}

export async function applyLocalNoise(
  base64: string,
  amount: number,
  maskB64?: string | null,
  profile: NoiseProfile = 'digital'
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      let maskImg: HTMLImageElement | null = null;
      if (maskB64) {
        maskImg = new Image();
        maskImg.src = maskB64;
        await new Promise(r => maskImg!.onload = r);
      }

      applyNoiseToCanvas(ctx, canvas.width, canvas.height, amount, maskImg, profile);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = base64;
  });
}

async function prepareImageForAi(
  base64: string,
  targetSize: number = 1536,
  quality: number = 0.8,
  noiseAmount: number = 0,
  maskB64?: string | null,
  profile: NoiseProfile = 'digital'
): Promise<{ data: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d')!;

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, targetSize, targetSize);

      let w = img.width;
      let h = img.height;
      let renderW, renderH, offsetX, offsetY;

      if (w > h) {
        renderW = targetSize;
        renderH = (h * targetSize) / w;
        offsetX = 0;
        offsetY = (targetSize - renderH) / 2;
      } else {
        renderH = targetSize;
        renderW = (w * targetSize) / h;
        offsetY = 0;
        offsetX = (targetSize - renderW) / 2;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, offsetX, offsetY, renderW, renderH);

      if (noiseAmount > 0) {
        let maskImg: HTMLImageElement | null = null;
        if (maskB64) {
          maskImg = new Image();
          maskImg.src = maskB64;
          await new Promise(r => maskImg!.onload = r);
        }
        applyNoiseToCanvas(ctx, targetSize, targetSize, noiseAmount, maskImg, profile);
      }

      resolve({ data: canvas.toDataURL('image/jpeg', quality).split(',')[1] });
    };
    img.onerror = () => reject(new Error("Lỗi đọc dữ liệu ảnh RAW."));
    img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
  });
}

async function resizeImageToMatch(base64: string, targetW: number, targetH: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, targetW, targetH);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Resize failed'));
    img.src = base64;
  });
}

export class GeminiService {
  private getClient() {
    let key = process.env.API_KEY;
    if (typeof window !== 'undefined') {
      const localKey = localStorage.getItem('GEMINI_API_KEY');
      if (localKey) key = localKey;
    }
    return new GoogleGenAI({ apiKey: key });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async withRetry<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error: any) {
        attempt++;
        const errorMessage = error?.message?.toLowerCase() || "";
        const isRetryable =
          errorMessage.includes("503") ||
          errorMessage.includes("529") ||
          errorMessage.includes("unavailable") ||
          errorMessage.includes("high demand") ||
          errorMessage.includes("quota");

        if (!isRetryable || attempt >= maxRetries) {
          throw error;
        }

        const waitTime = Math.pow(2, attempt - 1) * 1500;
        console.warn(`[Gemini API] Request failed (${errorMessage}). Retrying ${attempt}/${maxRetries} in ${waitTime}ms...`);

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('gemini-retry', { detail: { attempt, maxRetries } }));
        }

        await this.delay(waitTime);
      }
    }
    throw new Error("Max retries exceeded");
  }

  async processImage(
    prompt: string,
    imageB64?: string,
    quality: ImageQuality = '4K',
    referenceImageB64?: string,
    imageSalt?: string,
    isChainedRef: boolean = false,
    noiseAmount: number = 0,
    maskB64?: string | null,
    profile: NoiseProfile = 'digital',
    aspectRatio: string = '1:1',
    intensity: number = 100,
    bgB64?: string | null
  ): Promise<string | undefined> {
    const ai = this.getClient();
    const dynamicSeed = generateDynamicSeed(prompt, imageSalt);
    const apiQuality = quality === '6K' ? '4K' : quality;

    let systemInstruction = `You are the MARIE PIXEL-LOCK SUPREMACY ENGINE (v4.5) - FULL ANATOMY PROTOCOL.
    
    CRITICAL MANDATE:
    1. ANATOMICAL COMPLETENESS (NO CLIPPING): The user's mask is only a PLACEMENT ANCHOR (position guide). You MUST render the requested object (e.g., horse, person, vehicle) COMPLETELY and WHOLLY. Even if the object's body naturally extends beyond the user's rough mask, YOU MUST RENDER THE FULL OBJECT. Never truncate or cut parts (like heads, tails, or limbs) at the mask boundary. You are authorized to expand the generation into the source image to ensure 100% anatomical integrity.
    2. QUANTUM INTENSITY (${intensity}%): Scale all micro-details and texture clarity by this factor.
    3. PHOTOREALISTIC ANCHORING: Align lighting, textures, and perspective to make the full object look native to the scene.
    4. NOISE DNA: Incorporate ${noiseAmount}% ${profile.toUpperCase()} grain.

    MISSION: Ensure the target object is rendered fully without any cropping at the mask edges.`;

    if (bgB64) {
      systemInstruction += `\n\n    SPECIAL MISSION (BACKGROUND COMPOSITING): 
      You MUST extract the main subject from the SOURCE_TEMPLATE and flawlessly composite it onto the BACKGROUND_ENVIRONMENT.
      
      CRITICAL COMPOSITING CONSTRAINTS:
      - [EXACT PIXEL SUBJECT EXTRACTION]: You MUST NOT alter, hallucinate, redraw, or modify the anatomy, face, clothes, shape, texture, or identity of the original subject in the SOURCE_TEMPLATE in ANY WAY. Preserve 100% of the subject's original pixels.
      - [ULTRA-REALISTIC BLENDING]: Generate physically accurate CAST SHADOWS onto the floor/surfaces of the BACKGROUND_ENVIRONMENT. Create matched AMBIENT OCCLUSION and LIGHT REFLECTIONS on the subject so it perfectly matches the lighting situation of the new background.
      - [ZERO HALLUCINATION]: DO NOT invent, hallucinate, or add any other subjects, animals, humans, or objects that are not already present in the SOURCE_TEMPLATE or BACKGROUND_ENVIRONMENT.
      - OVERALL GOAL: Make it look like a 100% real photograph where the exact original subject was actually physically present in the new background environment.`;
    }

    const parts: any[] = [];
    if (bgB64) {
      const { data: bgData } = await prepareImageForAi(bgB64, 1536, 0.8);
      parts.push({ text: "BACKGROUND_ENVIRONMENT:" }, { inlineData: { data: bgData, mimeType: 'image/jpeg' } });
    }
    if (referenceImageB64) {
      const { data: refData } = await prepareImageForAi(referenceImageB64, 1024, 0.7);
      parts.push({ text: "STYLE_DNA_REF:" }, { inlineData: { data: refData, mimeType: 'image/jpeg' } });
    }
    if (imageB64) {
      const { data: targetData } = await prepareImageForAi(imageB64, 1536, 0.8, noiseAmount, maskB64, profile);
      parts.push({ text: "SOURCE_TEMPLATE:" }, { inlineData: { data: targetData, mimeType: 'image/jpeg' } });
    }
    if (maskB64) {
      const { data: maskData } = await prepareImageForAi(maskB64, 1536, 0.8);
      parts.push({ text: "PLACEMENT_ANCHOR_MASK:" }, { inlineData: { data: maskData, mimeType: 'image/jpeg' } });
    }

    parts.push({ text: `[QUANTUM_RENDER] Prompt: ${prompt}. Intensity: ${intensity}%. FOCUS: Anatomical completeness, zero clipping.` });

    try {
      const response = await this.withRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts },
        config: { systemInstruction, seed: dynamicSeed, imageConfig: { aspectRatio: aspectRatio as any, imageSize: apiQuality as any } }
      }));
      const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      return imagePart?.inlineData ? `data:image/png;base64,${imagePart.inlineData.data}` : undefined;
    } catch (error: any) {
      if (error.message?.includes('403') || error.message?.includes('Requested entity was not found.')) {
        await openKeySelector();
      }
      throw error;
    }
  }

  async generateSemanticMask(imageB64: string): Promise<string | undefined> {
    const ai = this.getClient();

    // Determine aspect ratio
    const img = new Image();
    img.src = imageB64.startsWith('data:') ? imageB64 : `data:image/png;base64,${imageB64}`;
    await new Promise(r => img.onload = r);
    const aspectRatio = getNearestGeminiRatio(img.width, img.height);

    const { data: targetData } = await prepareImageForAi(imageB64, 1536, 0.8);

    const parts = [
      { text: "SOURCE_IMAGE:" },
      { inlineData: { data: targetData, mimeType: 'image/jpeg' } },
      {
        text: `[SPECIAL MISSION: EXACT SEMANTIC SEGMENTATION] 
Generate a pixel-perfect color-coded semantic map based strictly on the SOURCE_IMAGE geometry.
COLOR CODING RULES:
1. Paint the Main Subject (entire body, clothing, hair) in PURE RED (#FF0000).
2. Paint all Background Environment in PURE GREEN (#00FF00).
3. If the subject is human, paint exposed Skin/Face in PURE BLUE (#0000FF).
CRITICAL: Do not alter the outline, position, or structure of anything. Output only flat colors perfectly tracing the original image.` }
    ];

    try {
      const response = await this.withRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts },
        config: { imageConfig: { aspectRatio: aspectRatio as any, imageSize: '2K' as any } }
      }));
      const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart?.inlineData) return undefined;
      // Resize to exactly match the original image dimensions
      return await resizeImageToMatch(`data:image/png;base64,${imagePart.inlineData.data}`, img.width, img.height);
    } catch (error: any) {
      if (error.message?.includes('403') || error.message?.includes('Requested entity was not found.')) {
        await openKeySelector();
      }
      throw error;
    }
  }

  async generateDepthMap(imageB64: string): Promise<string | undefined> {
    const ai = this.getClient();

    const img = new Image();
    img.src = imageB64.startsWith('data:') ? imageB64 : `data:image/png;base64,${imageB64}`;
    await new Promise(r => img.onload = r);
    const aspectRatio = getNearestGeminiRatio(img.width, img.height);

    const { data: targetData } = await prepareImageForAi(imageB64, 1536, 0.8);

    const parts = [
      { text: "SOURCE_IMAGE:" },
      { inlineData: { data: targetData, mimeType: 'image/jpeg' } },
      {
        text: `[SPECIAL MISSION: 3D Z-DEPTH MAP ESTIMATION] 
Generate a high-precision, smooth grayscale Depth Map derived perfectly from the perspective of the SOURCE_IMAGE.
RULES:
1. Pure White (#FFFFFF) represents objects closest to the camera.
2. Pure Black (#000000) represents the furthest background or infinity.
3. Use smooth gradients of gray (0-255) to represent intermediate distances seamlessly.
4. Preserve the exact edges and silhouettes of objects.
Do not add any text or borders. Output purely a monochrome depth layer matching the original layout.` }
    ];

    try {
      const response = await this.withRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts },
        config: { imageConfig: { aspectRatio: aspectRatio as any, imageSize: '2K' as any } }
      }));
      const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart?.inlineData) return undefined;
      // Resize to exactly match the original image dimensions
      return await resizeImageToMatch(`data:image/png;base64,${imagePart.inlineData.data}`, img.width, img.height);
    } catch (error: any) {
      if (error.message?.includes('403') || error.message?.includes('Requested entity was not found.')) {
        await openKeySelector();
      }
      throw error;
    }
  }

  async chat(history: any[], message: string) {
    const ai = this.getClient();
    const chat = ai.chats.create({ model: 'gemini-3-pro-preview' });
    const res = await chat.sendMessage({ message });
    return res.text;
  }

  private async optimizeImageForExtraction(base64: string, maxSize: number = 1536): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > h && w > maxSize) {
          h = Math.round((h * maxSize) / w);
          w = maxSize;
        } else if (h > w && h > maxSize) {
          w = Math.round((w * maxSize) / h);
          h = maxSize;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      };
      img.onerror = () => reject(new Error("Image extraction optimization failed"));
      img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    });
  }

  async extractTypography(imageB64: string): Promise<TextNode[]> {
    const ai = this.getClient();
    const prompt = `Analyze this design image carefully. For every distinct text element you see, please extract:
1. The text content.
2. The approximate bounding box top-left coordinates (x, y) relative to the image dimensions (from 0 to 1).
3. The approximate font size relative to the image height (from 0 to 1).
4. The exact dominant hex color of the text (e.g. #FFFFFF).
5. The font style roughly matching standard CSS families (e.g. "sans-serif", "serif", "monospace", "cursive").

Return ONLY a valid JSON array of objects with the exact keys: "text", "x", "y", "fontSize", "hexColor", "fontFamily". Give no markdown formatting or backticks around the json. Example output:
[{"text": "SALE OFF", "x": 0.1, "y": 0.2, "fontSize": 0.05, "hexColor": "#FF0000", "fontFamily": "sans-serif"}]`;

    try {
      const cleanBase64 = await this.optimizeImageForExtraction(imageB64);

      const res = await this.withRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: { parts: [{ inlineData: { data: cleanBase64, mimeType: 'image/jpeg' } }, { text: prompt }] },
        config: { temperature: 0.1 }
      }));
      // In @google/genai SDK res.text is often a string property instead of a method or vice versa.
      // Usually it's response.text getter. Let's handle both.
      const txt = typeof res.text === 'function' ? (res as any).text() : res.text || "[]";

      // Extract array from possible markdown or conversational text
      const match = String(txt).match(/\[[\s\S]*\]/);
      const jsonStr = match ? match[0] : "[]";

      const nodes = JSON.parse(jsonStr);
      if (!Array.isArray(nodes)) return [];

      return nodes.map((n: any, i: number) => ({
        id: `txt_${Date.now()}_${i}`,
        text: n.text || "TEXT",
        x: n.x || 0.5,
        y: n.y || 0.5,
        fontSize: n.fontSize || 0.05,
        hexColor: n.hexColor || "#FFFFFF",
        fontFamily: n.fontFamily || "sans-serif"
      }));
    } catch (e: any) {
      console.error("Typography extraction failed:", e);
      throw new Error(`Text Parse failed: ${e.message}`);
    }
  }

  async analyzeImage(imageB64: string, prompt: string = "Analyze this image.") {
    const ai = this.getClient();
    const res = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: { parts: [{ inlineData: { data: imageB64, mimeType: 'image/jpeg' } }, { text: prompt }] }
    });
    return res.text;
  }
}

export const gemini = new GeminiService();
