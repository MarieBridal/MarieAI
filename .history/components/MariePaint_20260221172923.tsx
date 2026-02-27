
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { gemini, applyLocalNoise, NoiseProfile, ImageQuality, getNearestGeminiRatio, TextNode } from '../services/gemini';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Images, Palette, Layers, Loader2, Download, Trash2,
  StepForward, Undo, Plus, X, Type, Wand2
} from 'lucide-react';
import { cn } from '../utils';
import { createMultiLayerPsdBlob, PsdLayerParams } from '../services/psdExport';
import { applyColorMatch } from '../utils/colorMatch';

interface PaintItem {
  id: string;
  original: string;
  results: string[];
  rawResults: string[];
  selectedResultIndex: number;
  undoStack: string[];
  redoStack: string[];
  mask: string | null;
  prompt: string;
  featherAmount: number;
  blendOpacity: number;
  maskDilation: number;
  isProcessing?: boolean;
  detectedTexts?: TextNode[];
}

interface MariePaintProps {
  title?: string;
}

export const MariePaint: React.FC<MariePaintProps> = ({ title = "MARIE PIXEL-LOCK" }) => {
  const [items, setItems] = useState<PaintItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [defaultDilation, setDefaultDilation] = useState(20);
  const [defaultFeather, setDefaultFeather] = useState(15);
  const [defaultOpacity, setDefaultOpacity] = useState(100);

  const [refImage, setRefImage] = useState<string | null>(null);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [quality, setQuality] = useState<ImageQuality>('4K');
  const [numVariants, setNumVariants] = useState<number>(1);
  const [noiseAmount, setNoiseAmount] = useState<number>(0);
  const [noiseTarget, setNoiseTarget] = useState<'global' | 'mask'>('global');
  const [noiseProfile, setNoiseProfile] = useState<NoiseProfile>('digital');
  const [quantumIntensity, setQuantumIntensity] = useState<number>(100);

  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(40);
  const [isEraser, setIsEraser] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [canvasActive, setCanvasActive] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeItem = currentIndex >= 0 ? items[currentIndex] : null;
  const currentImage = activeItem ? (activeItem.selectedResultIndex >= 0 ? activeItem.results[activeItem.selectedResultIndex] : activeItem.original) : null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        setIsSpacePressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') setIsSpacePressed(false); };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, []);

  const performBlending = useCallback(async (item: PaintItem, resultIdx: number): Promise<string> => {
    if (resultIdx === -1 || !item.rawResults[resultIdx]) return item.original;

    const rawAiB64 = item.rawResults[resultIdx];
    const originalImg = new Image(); originalImg.src = item.original; await new Promise(r => originalImg.onload = r);
    const aiImg = new Image(); aiImg.src = rawAiB64; await new Promise(r => aiImg.onload = r);

    const targetW = originalImg.naturalWidth;
    const targetH = originalImg.naturalHeight;

    const finalCanvas = document.createElement('canvas'); finalCanvas.width = targetW; finalCanvas.height = targetH;
    const fctx = finalCanvas.getContext('2d')!;
    fctx.drawImage(originalImg, 0, 0);

    const aiLayer = document.createElement('canvas'); aiLayer.width = targetW; aiLayer.height = targetH;
    const actx = aiLayer.getContext('2d')!;

    const aiSize = aiImg.width;
    let renderW, renderH, offsetX, offsetY;

    if (targetW > targetH) {
      renderW = aiSize; renderH = (targetH * aiSize) / targetW; offsetX = 0; offsetY = (aiSize - renderH) / 2;
    } else {
      renderH = aiSize; renderW = (targetW * aiSize) / targetH; offsetY = 0; offsetX = (aiSize - renderW) / 2;
    }

    // Engine hòa trộn V4.5: Hỗ trợ Overdrive Opacity
    let remainingAlpha = item.blendOpacity / 100;
    while (remainingAlpha > 0) {
      actx.globalAlpha = Math.min(1, remainingAlpha);
      actx.drawImage(aiImg, offsetX, offsetY, renderW, renderH, 0, 0, targetW, targetH);
      remainingAlpha -= 1;
    }

    if (item.mask) {
      const featherMask = document.createElement('canvas'); featherMask.width = targetW; featherMask.height = targetH;
      const fmctx = featherMask.getContext('2d')!;
      const userMask = new Image(); userMask.src = item.mask; await new Promise(r => userMask.onload = r);

      // Smart Dilation V4.5: Tăng diện tích mask để không làm vật thể AI bị cắt cụt
      if (item.maskDilation > 0) {
        fmctx.filter = `blur(${item.maskDilation * 0.5}px)`; // Làm mờ nhẹ cạnh giãn
        fmctx.drawImage(userMask, -item.maskDilation, -item.maskDilation, targetW + item.maskDilation * 2, targetH + item.maskDilation * 2);
      }

      // Vẽ mask gốc đè lên trung tâm để giữ lõi đậm đặc
      fmctx.filter = 'none';
      fmctx.globalAlpha = 1.0;
      fmctx.drawImage(userMask, 0, 0, targetW, targetH);

      // Feathering (Làm mờ biên)
      if (item.featherAmount > 0) {
        const blurCanvas = document.createElement('canvas'); blurCanvas.width = targetW; blurCanvas.height = targetH;
        const bctx = blurCanvas.getContext('2d')!;
        bctx.filter = `blur(${item.featherAmount}px)`;
        bctx.drawImage(featherMask, 0, 0);

        actx.globalCompositeOperation = 'destination-in';
        actx.drawImage(blurCanvas, 0, 0);
      } else {
        actx.globalCompositeOperation = 'destination-in';
        actx.drawImage(featherMask, 0, 0);
      }
    }

    fctx.drawImage(aiLayer, 0, 0);
    return finalCanvas.toDataURL('image/png');
  }, []);

  const updateItemBlending = async (itemId: string, updates: Partial<PaintItem>) => {
    setItems(prev => {
      const newItems = prev.map(it => it.id === itemId ? { ...it, ...updates } : it);
      const target = newItems.find(it => it.id === itemId);
      if (target && target.selectedResultIndex !== -1) {
        performBlending(target, target.selectedResultIndex).then(blended => {
          setItems(current => current.map(it => it.id === itemId ? {
            ...it,
            results: it.results.map((r, i) => i === it.selectedResultIndex ? blended : r)
          } : it));
        });
      }
      return newItems;
    });
  };

  const handleContinueEditing = () => {
    if (!activeItem || activeItem.selectedResultIndex === -1) return;
    const newSource = activeItem.results[activeItem.selectedResultIndex];

    if (displayCanvasRef.current && maskCanvasRef.current) {
      const dctx = displayCanvasRef.current.getContext('2d')!;
      const mctx = maskCanvasRef.current.getContext('2d')!;
      dctx.clearRect(0, 0, 99999, 99999);
      mctx.clearRect(0, 0, 99999, 99999);
    }

    setItems(prev => prev.map(it => it.id === activeItem.id ? {
      ...it, original: newSource, results: [], rawResults: [], selectedResultIndex: -1, undoStack: [], redoStack: [], mask: null
    } : it));

    setCanvasActive(false); setZoom(1); setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.2;
      const delta = e.deltaY > 0 ? 1 - zoomSpeed : 1 + zoomSpeed;
      setZoom(z => Math.min(Math.max(z * delta, 0.5), 25));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [currentIndex, activeItem?.selectedResultIndex]);

  const setupCanvas = useCallback(() => {
    if (activeItem && imageRef.current && displayCanvasRef.current && maskCanvasRef.current) {
      const img = imageRef.current;
      maskCanvasRef.current.width = img.naturalWidth;
      maskCanvasRef.current.height = img.naturalHeight;
      displayCanvasRef.current.width = img.clientWidth;
      displayCanvasRef.current.height = img.clientHeight;
      const mctx = maskCanvasRef.current.getContext('2d')!;
      const dctx = displayCanvasRef.current.getContext('2d')!;
      mctx.lineCap = 'round'; mctx.strokeStyle = '#FF0000';
      dctx.lineCap = 'round'; dctx.strokeStyle = '#FF0000';

      mctx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
      dctx.clearRect(0, 0, displayCanvasRef.current.width, displayCanvasRef.current.height);

      if (activeItem.undoStack.length > 0) {
        const last = new Image();
        last.onload = () => {
          mctx.drawImage(last, 0, 0);
          dctx.drawImage(last, 0, 0, displayCanvasRef.current!.width, displayCanvasRef.current!.height);
        };
        last.src = activeItem.undoStack[activeItem.undoStack.length - 1];
      }
    }
  }, [currentIndex, activeItem?.undoStack.length, canvasActive]);

  useEffect(() => { if (canvasActive) setupCanvas(); }, [setupCanvas, canvasActive]);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const newItem: PaintItem = {
          id: Math.random().toString(36).substr(2, 9),
          original: ev.target?.result as string,
          results: [],
          rawResults: [],
          selectedResultIndex: -1,
          undoStack: [],
          redoStack: [],
          mask: null,
          prompt: activeItem?.prompt || defaultPrompt || '',
          featherAmount: defaultFeather,
          blendOpacity: defaultOpacity,
          maskDilation: defaultDilation
        };
        setItems(prev => {
          const next = [...prev, newItem];
          if (currentIndex === -1) setCurrentIndex(0);
          return next;
        });
      };
      reader.readAsDataURL(file as Blob);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const saveToUndoStack = () => {
    if (maskCanvasRef.current && activeItem) {
      const state = maskCanvasRef.current.toDataURL();
      const newUndo = [...activeItem.undoStack, state];
      updateItemBlending(activeItem.id, { undoStack: newUndo, redoStack: [], mask: state });
    }
  };

  const handleUndo = () => {
    if (!activeItem || activeItem.undoStack.length === 0) return;
    const newUndo = [...activeItem.undoStack];
    const stateToRestore = newUndo.pop();
    const currentMask = maskCanvasRef.current?.toDataURL();

    const redoUpdates: any = { undoStack: newUndo };
    if (currentMask) redoUpdates.redoStack = [...activeItem.redoStack, currentMask];

    updateItemBlending(activeItem.id, redoUpdates);

    const mctx = maskCanvasRef.current?.getContext('2d');
    const dctx = displayCanvasRef.current?.getContext('2d');
    mctx?.clearRect(0, 0, 99999, 99999);
    dctx?.clearRect(0, 0, 99999, 99999);

    if (newUndo.length > 0) {
      const img = new Image();
      img.onload = () => {
        mctx?.drawImage(img, 0, 0);
        dctx?.drawImage(img, 0, 0, displayCanvasRef.current!.width, displayCanvasRef.current!.height);
      };
      img.src = newUndo[newUndo.length - 1];
    }
  };

  const startDrawing = (e: React.PointerEvent) => {
    if (isSpacePressed || !canvasActive || !activeItem || activeItem.selectedResultIndex !== -1) return;
    setIsDrawing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const rect = displayCanvasRef.current!.getBoundingClientRect();
    const scaleX = rect.width / displayCanvasRef.current!.width;
    const scaleY = rect.height / displayCanvasRef.current!.height;

    // Exact mapping eliminating CSS / zoom dependencies
    const x = (e.clientX - rect.left) / scaleX;
    const y = (e.clientY - rect.top) / scaleY;

    const dctx = displayCanvasRef.current!.getContext('2d')!;
    const mctx = maskCanvasRef.current!.getContext('2d')!;

    // Scaling the brush radius internally
    const bsD = brushSize / scaleX;
    const bsM = brushSize; // mask layer is 1:1

    dctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    mctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';

    dctx.beginPath(); dctx.moveTo(x, y); dctx.lineWidth = bsD; dctx.lineTo(x, y); dctx.stroke();
    mctx.beginPath(); mctx.moveTo(x, y); mctx.lineWidth = bsM; mctx.lineTo(x, y); mctx.stroke();
  };

  const draw = (e: React.PointerEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
    if (!isDrawing || isSpacePressed) return;

    const rect = displayCanvasRef.current!.getBoundingClientRect();
    const scaleX = rect.width / displayCanvasRef.current!.width;
    const scaleY = rect.height / displayCanvasRef.current!.height;

    // Exact mapping
    const x = (e.clientX - rect.left) / scaleX;
    const y = (e.clientY - rect.top) / scaleY;

    const dctx = displayCanvasRef.current!.getContext('2d')!;
    const mctx = maskCanvasRef.current!.getContext('2d')!;

    const bsD = brushSize / scaleX;
    const bsM = brushSize;

    dctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    mctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';

    dctx.lineWidth = bsD; dctx.lineTo(x, y); dctx.stroke();
    mctx.lineWidth = bsM; mctx.lineTo(x, y); mctx.stroke();
  };

  const stopDrawing = (e: React.PointerEvent) => {
    if (isDrawing) {
      setIsDrawing(false);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      saveToUndoStack();
    }
  };

  const handleApplyLocalGrain = async () => {
    const source = activeItem?.selectedResultIndex !== -1 ? activeItem?.rawResults[activeItem.selectedResultIndex] : activeItem?.original;
    if (!source || !activeItem) return;
    setLoading(true);
    try {
      const maskData = noiseTarget === 'mask' && activeItem?.mask ? activeItem.mask : null;
      const noisedB64 = await applyLocalNoise(source, noiseAmount, maskData, noiseProfile);

      const newRawResults = [noisedB64, ...activeItem.rawResults];
      const placeholderResults = [noisedB64, ...activeItem.results];

      setItems(prev => prev.map(it => it.id === activeItem.id ? {
        ...it, rawResults: newRawResults, results: placeholderResults, selectedResultIndex: 0
      } : it));

      const updatedItem = { ...activeItem, rawResults: newRawResults, selectedResultIndex: 0 };
      const blended = await performBlending(updatedItem, 0);
      setItems(prev => prev.map(it => it.id === activeItem.id ? {
        ...it, results: it.results.map((r, i) => i === 0 ? blended : r)
      } : it));

    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const processSingleItem = async (itemId: string, mode: 'edit' | 'upscale') => {
    const item = items.find(it => it.id === itemId);
    if (!item) return;
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, isProcessing: true } : it));

    try {
      const res = await gemini.processImage(
        mode === 'upscale' ? "Quantum Optical Super-Resolution reconstruction." : (activeItem?.prompt || "Precision reconstruction."),
        item.original, quality, refImage || undefined, `paint_${item.id}_${Date.now()}`,
        false, noiseAmount, item.mask, noiseProfile, '1:1', quantumIntensity, bgImage
      );

      if (res) {
        const newRawResults = [res, ...item.rawResults];
        const placeholderResults = [res, ...item.results];
        const updatedItem = { ...item, rawResults: newRawResults, selectedResultIndex: 0 };
        const blended = await performBlending(updatedItem, 0);

        setItems(prev => prev.map(it => it.id === itemId ? {
          ...it, rawResults: newRawResults, results: placeholderResults.map((r, i) => i === 0 ? blended : r), selectedResultIndex: 0, isProcessing: false
        } : it));
      }
    } catch (err: any) {
      console.error(err);
      setItems(prev => prev.map(it => it.id === itemId ? { ...it, isProcessing: false } : it));
    }
  };

  const handleStartBatch = async () => {
    if (loading || items.length === 0) return;
    setLoading(true);
    let i = 0;
    for (const item of items) {
      setCurrentIndex(i); // Update UI to show current item
      await processSingleItem(item.id, 'edit');
      await new Promise(r => setTimeout(r, 1000));
      i++;
    }
    setLoading(false);
  };

  const extractTypography = async () => {
    if (!activeItem) return;
    setLoading(true);
    try {
      toast.info("Đang dùng AI quét cấu hình font chữ...");
      const textNodes = await gemini.extractTypography(activeItem.original);
      if (textNodes.length > 0) {
        setItems(prev => prev.map(it => it.id === activeItem.id ? { ...it, detectedTexts: textNodes } : it));
        toast.success(`Đã quét được ${textNodes.length} cụm chữ.`);
      } else {
        toast.error("Không tìm thấy chữ nào trong độ phân tích của AI.");
      }
    } catch (err: any) {
      toast.error(`Lỗi quét: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleColorMatch = async () => {
    if (!activeItem || !refImage) {
      toast.error("Vui lòng chọn ảnh và tải lên ảnh STYLE MẪU cần lấy màu!");
      return;
    }
    setLoading(true);
    try {
      toast.info("Đang hút màu từ ảnh mẫu và mô phỏng Histogram 100%...");
      const currentImage = activeItem.selectedResultIndex !== -1 ? activeItem.results[activeItem.selectedResultIndex] : activeItem.original;
      const matchedB64 = await applyColorMatch(currentImage, refImage);

      const newResults = [...activeItem.results, matchedB64];
      const newRawResults = [...activeItem.rawResults, matchedB64];
      setItems(prev => prev.map(it => it.id === activeItem.id ? {
        ...it,
        results: newResults,
        rawResults: newRawResults,
        selectedResultIndex: newResults.length - 1
      } : it));

      toast.success("Ép màu Evoto Style hoàn tất!");
    } catch (err: any) {
      toast.error(`Lỗi ép màu: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const downloadSingle = async (item: PaintItem, format: 'psd' | 'png') => {
    if (format === 'png') {
      const link = document.createElement('a');
      link.href = item.results[item.selectedResultIndex !== -1 ? item.selectedResultIndex : 0];
      link.download = `MARIE_PAINT_${item.id}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    const layers: PsdLayerParams[] = [];
    if (bgImage) layers.push({ name: 'Background (User)', base64: bgImage });
    layers.push({ name: 'Original', base64: item.original });

    const aiResult = item.results[item.selectedResultIndex !== -1 ? item.selectedResultIndex : 0];
    if (aiResult) layers.push({ name: 'AI Result', base64: aiResult });

    const promise = createMultiLayerPsdBlob(layers, item.detectedTexts).then(blob => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `MARIE_PAINT_${item.id}.psd`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    });

    toast.promise(promise, {
      loading: 'Đang đóng gói file PSD đa layer...',
      success: 'Tải xuống PSD thành công!',
      error: 'Lỗi khi tạo file PSD.'
    });
  };

  const downloadAll = async (format: 'psd' | 'png') => {
    const completedItems = items.filter(it => it.results.length > 0);
    if (completedItems.length === 0) return;

    if (format === 'png') {
      for (const item of completedItems) {
        const link = document.createElement('a');
        link.href = item.results[item.selectedResultIndex !== -1 ? item.selectedResultIndex : 0];
        link.download = `MARIE_PAINT_${item.id}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        await new Promise(r => setTimeout(r, 400));
      }
      return;
    }

    let successCount = 0;

    const promise = (async () => {
      for (const item of completedItems) {
        const layers: PsdLayerParams[] = [];
        if (bgImage) layers.push({ name: 'Background (User)', base64: bgImage });
        layers.push({ name: 'Original', base64: item.original });

        const aiResult = item.results[item.selectedResultIndex !== -1 ? item.selectedResultIndex : 0];
        if (aiResult) layers.push({ name: 'AI Result', base64: aiResult });

        const blob = await createMultiLayerPsdBlob(layers, item.detectedTexts);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `MARIE_PAINT_${item.id}.psd`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        successCount++;
        await new Promise(r => setTimeout(r, 400));
      }
      return successCount;
    })();

    toast.promise(promise, {
      loading: `Đang xuất hàng loạt ${completedItems.length} file PSD...`,
      success: (data) => `Đã tải xuống thành công ${data} file PSD!`,
      error: 'Có lỗi xảy ra khi tạo danh sách file PSD.'
    });
  };

  const processImage = async (mode: 'edit' | 'upscale') => {
    if (!activeItem) return;
    setLoading(true);
    try {
      await processSingleItem(activeItem.id, mode);
      setCanvasActive(false);
    } catch (err: any) { toast.error(`LỖI: ${err.message}`); } finally { setLoading(false); }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6 animate-fadeIn max-w-[1800px] mx-auto h-full min-h-[calc(100vh-140px)]">
      {canvasActive && isHovering && activeItem?.selectedResultIndex === -1 && !loading && !isSpacePressed && (
        <div style={{ position: 'fixed', left: mousePos.x, top: mousePos.y, width: brushSize, height: brushSize, transform: 'translate(-50%, -50%)', border: '2px solid white', backgroundColor: 'rgba(255, 0, 0, 0.4)', pointerEvents: 'none', zIndex: 9999, borderRadius: '50%' }} />
      )}

      {/* Sidebar Control */}
      <div className="w-full lg:w-96 flex flex-col gap-6 flex-shrink-0">
        <div className="glass-effect p-6 rounded-3xl border border-slate-700 shadow-2xl space-y-6 sticky top-6">
          <div className="flex items-center justify-between">
            {/* Used dynamic title prop here */}
            <h3 className="text-xl font-bold text-blue-400 uppercase tracking-tighter">{title}</h3>
            <span className="bg-red-600/20 text-red-400 text-[8px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest">V4.5 SUPREME</span>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => fileInputRef.current?.click()}
              className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-slate-900/40 border-slate-700 hover:border-blue-500 hover:bg-blue-500/5 transition-all group"
            >
              <Images className="w-4 h-4 text-slate-500 group-hover:text-blue-400 transition-colors" />
              <span className="text-[7px] text-slate-500 group-hover:text-blue-400 font-black uppercase tracking-widest transition-colors text-center leading-tight px-1">THÊM<br />HÌNH</span>
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => bgFileInputRef.current?.click()}
              className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-slate-900/40 border-slate-700 hover:border-emerald-500 hover:bg-emerald-500/5 transition-all group"
            >
              {bgImage ? <img src={bgImage} className="w-8 h-8 rounded-lg object-cover shadow-lg" /> : <Layers className="w-4 h-4 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
              <span className="text-[7px] text-slate-500 group-hover:text-emerald-400 font-black uppercase tracking-widest transition-colors truncate w-full px-1 text-center leading-tight">THÊM<br />NỀN</span>
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => refFileInputRef.current?.click()}
              className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-slate-900/40 border-slate-700 hover:border-purple-500 hover:bg-purple-500/5 transition-all group"
            >
              {refImage ? <img src={refImage} className="w-8 h-8 rounded-lg object-cover shadow-lg" /> : <Palette className="w-4 h-4 text-slate-500 group-hover:text-purple-400 transition-colors" />}
              <span className="text-[7px] text-slate-500 group-hover:text-purple-400 font-black uppercase tracking-widest transition-colors text-center leading-tight px-1">STYLE<br />MẪU</span>
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleColorMatch}
              disabled={loading || !activeItem || !refImage}
              className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-slate-900/40 border-slate-700 hover:border-pink-500 hover:bg-pink-500/5 transition-all group disabled:opacity-30 disabled:hover:border-slate-700"
            >
              <Wand2 className="w-4 h-4 text-slate-500 group-hover:text-pink-400 transition-colors" />
              <span className="text-[7px] text-slate-500 group-hover:text-pink-400 font-black uppercase tracking-widest transition-colors text-center leading-tight px-1 shadow-pink-500 drop-shadow-md">ÉP MÀU<br />100%</span>
            </motion.button>
          </div>
          <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" accept="image/*" multiple />
          <input type="file" ref={bgFileInputRef} onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = ev => setBgImage(ev.target?.result as string);
              reader.readAsDataURL(file as Blob);
            }
          }} className="hidden" accept="image/*" />
          <input type="file" ref={refFileInputRef} onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = ev => setRefImage(ev.target?.result as string);
              reader.readAsDataURL(file as Blob);
            }
          }} className="hidden" accept="image/*" />

          <textarea
            value={activeItem ? activeItem.prompt : defaultPrompt}
            onChange={(e) => {
              const newPrompt = e.target.value;
              if (activeItem) {
                setItems(prev => prev.map(it => it.id === activeItem.id ? { ...it, prompt: newPrompt } : it));
              } else {
                setDefaultPrompt(newPrompt);
              }
            }}
            disabled={activeItem === null && items.length > 0}
            placeholder="Nhập yêu cầu tại đây..."
            className="w-full h-24 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-blue-500/30 transition-all shadow-inner disabled:opacity-50"
          />

          <div className="p-4 bg-slate-950/80 rounded-2xl border border-blue-500/20 space-y-4">
            <div className="flex justify-between items-center">
              <h4 className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Cường độ Quantum</h4>
              <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${quantumIntensity > 500 ? 'bg-red-500 text-white animate-pulse' : 'bg-blue-500/20 text-blue-400'}`}>{quantumIntensity}%</span>
            </div>
            <input type="range" min="0" max="1000" step="10" value={quantumIntensity} onChange={(e) => setQuantumIntensity(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
          </div>

          <div className="p-4 bg-slate-950/80 rounded-2xl border border-blue-500/20 space-y-4">
            <h4 className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center justify-between">Engine Blending V4.5 <Layers className="w-3.5 h-3.5 ml-1" /></h4>

            <div className="space-y-2">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Độ giãn Mask (Dilation)</span><span className="text-red-400">{activeItem ? activeItem.maskDilation : defaultDilation}px</span></div>
              <input type="range" min="0" max="500" value={activeItem ? activeItem.maskDilation : defaultDilation} onChange={(e) => {
                const val = parseInt(e.target.value);
                if (activeItem) updateItemBlending(activeItem.id, { maskDilation: val });
                else setDefaultDilation(val);
              }} className="w-full h-1.5 bg-slate-800 rounded-lg accent-red-500" />
              <p className="text-[7px] text-slate-500 uppercase">Tăng để hiện phần hình bị thiếu (đầu, chân...) trọn vẹn.</p>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Feathering DNA</span><span className="text-blue-400">{activeItem ? activeItem.featherAmount : defaultFeather}px</span></div>
              <input type="range" min="0" max="500" value={activeItem ? activeItem.featherAmount : defaultFeather} onChange={(e) => {
                const val = parseInt(e.target.value);
                if (activeItem) updateItemBlending(activeItem.id, { featherAmount: val });
                else setDefaultFeather(val);
              }} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
              <p className="text-[7px] text-slate-500 uppercase">Làm mềm phần viền ảnh ghép để hòa vào ảnh gốc mượt mà nhất có thể.</p>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Opacity OVERDRIVE</span><span className="text-blue-400">{activeItem ? activeItem.blendOpacity : defaultOpacity}px</span></div>
              <input type="range" min="0" max="500" value={activeItem ? activeItem.blendOpacity : defaultOpacity} onChange={(e) => {
                const val = parseInt(e.target.value);
                if (activeItem) updateItemBlending(activeItem.id, { blendOpacity: val });
                else setDefaultOpacity(val);
              }} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
              <p className="text-[7px] text-slate-500 uppercase">100% là mức chuẩn. Vượt 100% sẽ dập Alpha cường độ mạnh để ép phần ghép hiển thị đặc trị.</p>
            </div>
          </div>

          <div className="p-4 bg-slate-900/60 rounded-2xl border border-slate-800 space-y-4">
            <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Noise Engine</span><span className="text-blue-400 uppercase">{noiseProfile.toUpperCase()}</span></div>
            <div className="flex gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
              {(['digital', 'film', 'coarse', 'quantum'] as NoiseProfile[]).map(p => (
                <button key={p} onClick={() => setNoiseProfile(p)} className={`flex-1 py-1.5 rounded-md text-[7px] font-black transition-all ${noiseProfile === p ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500'}`}>
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Cường độ Noise</span><span className="text-blue-400">{noiseAmount}%</span></div>
              <input type="range" min="0" max="100" value={noiseAmount} onChange={(e) => setNoiseAmount(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
              <p className="text-[7px] text-slate-500 uppercase mt-1">Làm nhiễu hạt phần ảnh AI sinh ra để đồng bộ với chất ảnh tự nhiên máy ảnh.</p>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[8px] font-black text-slate-500 uppercase">Phạm vi:</span>
              <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                <button onClick={() => setNoiseTarget('global')} className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'global' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>TOÀN BỘ</button>
                <button onClick={() => setNoiseTarget('mask')} className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'mask' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>VÙNG MASK</button>
              </div>
            </div>
            <button onClick={handleApplyLocalGrain} disabled={loading || noiseAmount === 0 || !activeItem} className="w-full py-2.5 bg-slate-800 border border-slate-700 text-blue-400 rounded-xl text-[9px] font-black uppercase hover:bg-slate-700 transition-all disabled:opacity-30">
              Thêm Noise (Kết Quả Mới)
            </button>
          </div>

          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <button disabled={loading || !activeItem} onClick={() => processImage('edit')} className="bg-blue-600 text-white font-black py-4 rounded-2xl text-[9px] uppercase shadow-xl transition-all active:scale-95">
                XỬ LÝ EDIT
              </button>
              <button disabled={loading || !activeItem} onClick={() => processImage('upscale')} className="bg-slate-900 border border-purple-500/40 text-purple-400 font-black py-4 rounded-2xl text-[9px] uppercase shadow-xl transition-all active:scale-95">
                QUANTUM {quality}
              </button>
            </div>

            <button disabled={loading || items.length === 0} onClick={handleStartBatch} className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl text-[10px] uppercase shadow-2xl transition-all active:scale-95 flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />} BẮT ĐẦU BATCH ({items.length})
            </button>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button onClick={() => downloadAll('png')} className="py-3 bg-slate-900/60 border border-slate-700/50 rounded-xl text-[9px] font-black text-slate-300 uppercase hover:bg-slate-800 transition-all flex items-center justify-center gap-2"><Download className="w-3.5 h-3.5" /> Tải All (PNG)</button>
              <button onClick={() => downloadAll('psd')} className="py-3 bg-blue-900/20 border border-blue-500/30 rounded-xl text-[9px] font-black text-blue-400 uppercase hover:bg-blue-500/30 transition-all flex items-center justify-center gap-2"><Layers className="w-3.5 h-3.5" /> Tải All (PSD)</button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button onClick={extractTypography} disabled={loading || !activeItem} className="py-3 bg-fuchsia-900/20 border border-fuchsia-500/30 rounded-xl text-[9px] font-black text-fuchsia-400 uppercase hover:bg-fuchsia-500/30 transition-all flex items-center justify-center gap-2"><Type className="w-3.5 h-3.5" /> Quét Chữ (Typos)</button>
              <button onClick={() => { setItems([]); setCurrentIndex(-1); }} className="py-3 bg-red-900/10 border border-red-500/20 rounded-xl text-[9px] font-black text-red-500/80 uppercase hover:bg-red-500/20 hover:text-red-500 transition-all flex items-center justify-center gap-2"><Trash2 className="w-3.5 h-3.5" /> Xóa toàn bộ</button>
            </div>
          </div>

          {activeItem && activeItem.results.length > 0 && (
            <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2 pt-2 border-t border-slate-800">
              {activeItem.results.map((res, idx) => (
                <button key={idx} onClick={() => updateItemBlending(activeItem.id, { selectedResultIndex: idx })} className={`flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition-all ${activeItem.selectedResultIndex === idx ? 'border-blue-500 scale-105' : 'border-slate-800 opacity-40'}`}><img src={res} className="w-full h-full object-cover" /></button>
              ))}
              <button onClick={() => updateItemBlending(activeItem.id, { selectedResultIndex: -1 })} className={`flex-shrink-0 w-14 h-14 rounded-xl border-2 border-dashed flex items-center justify-center text-[10px] font-black ${activeItem.selectedResultIndex === -1 ? 'border-blue-500 text-blue-400' : 'border-slate-800 text-slate-600'}`}>GỐC</button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-6">
        <div ref={containerRef} onMouseDown={e => { if (e.button === 1 || isSpacePressed || activeItem?.selectedResultIndex !== -1) { setIsPanning(true); setPanStart({ x: e.clientX - offset.x, y: e.clientY - offset.y }) } }} onMouseMove={e => { setMousePos({ x: e.clientX, y: e.clientY }); if (isPanning) { setOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }) } }} onMouseUp={() => setIsPanning(false)} onMouseEnter={() => setIsHovering(true)} onMouseLeave={() => setIsHovering(false)} className={`flex-1 glass-effect rounded-[3rem] relative overflow-hidden flex flex-col items-center justify-center border border-slate-700 bg-slate-950/40 min-h-[500px] shadow-inner ${canvasActive && activeItem?.selectedResultIndex === -1 && !isSpacePressed ? 'cursor-none' : 'cursor-default'}`}>
          {currentImage ? (
            <div style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`, transition: isPanning || isDrawing ? 'none' : 'transform 0.15s' }} className="relative inline-block rounded-2xl bg-black shadow-[0_50px_100px_rgba(0,0,0,0.8)]">
              <img ref={imageRef} src={showOriginal ? activeItem?.original : currentImage} className="max-h-[75vh] w-auto block select-none pointer-events-none rounded-2xl" />
              <canvas ref={displayCanvasRef} onPointerDown={startDrawing} onPointerMove={draw} onPointerUp={stopDrawing} className={`absolute inset-0 z-10 w-full h-full rounded-2xl touch-none ${canvasActive && activeItem?.selectedResultIndex === -1 ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} />
              <canvas ref={maskCanvasRef} className="hidden" />

              {/* Text Edit Overlay */}
              {activeItem?.detectedTexts && activeItem.detectedTexts.map((txt) => (
                <input
                  key={txt.id}
                  value={txt.text}
                  onChange={(e) => {
                    const newText = e.target.value;
                    setItems(prev => prev.map(it => it.id === activeItem.id ? {
                      ...it,
                      detectedTexts: it.detectedTexts?.map(t => t.id === txt.id ? { ...t, text: newText } : t)
                    } : it));
                  }}
                  className="absolute z-20 bg-transparent outline-none border border-dashed border-white/30 hover:border-blue-500 focus:border-blue-500 focus:bg-black/60 transition-colors px-1 font-bold whitespace-nowrap"
                  style={{
                    left: `${(txt.x > 1 ? txt.x / 1536 : txt.x) * 100}%`,
                    top: `${(txt.y > 1 ? txt.y / 1536 : txt.y) * 100}%`,
                    color: txt.hexColor,
                    // If height is max-h-[75vh], and we guess the aspect ratio, 
                    // To be safe against absolute pixel returns from Gemini, normalize it:
                    fontSize: `calc(${(txt.fontSize > 1 ? txt.fontSize / 1536 : txt.fontSize) * 100}% * (min(75vh, 100vw) / 100))`,
                    fontFamily: txt.fontFamily,
                    transform: 'translateY(-20%)', // subtle optical adjustment for top-left anchor vs font baseline
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="opacity-20 flex flex-col items-center gap-4 animate-pulse"><Palette className="w-24 h-24" /><p className="text-[12px] font-black uppercase tracking-widest">MARIE PAINT ENGINE V4.5</p></div>
          )}

          {activeItem && (
            <div className="absolute top-10 right-10 flex flex-col gap-3 z-30">
              <button onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} className="px-6 py-4 bg-black/80 backdrop-blur-xl text-amber-500 rounded-2xl text-[10px] font-black uppercase border border-amber-500/30 shadow-2xl transition-all">So sánh gốc</button>
              {activeItem.selectedResultIndex !== -1 && (
                <>
                  <button onClick={handleContinueEditing} className="px-6 py-4 bg-blue-600/90 backdrop-blur-xl text-white rounded-2xl text-[10px] font-black uppercase border border-blue-400/30 shadow-2xl transition-all hover:bg-blue-500 flex items-center justify-center gap-2 group"><StepForward className="w-4 h-4 group-hover:translate-x-1 transition-transform" />Làm tiếp</button>
                  <div className="flex flex-col gap-2">
                    <button onClick={() => downloadSingle(activeItem, 'png')} className="px-4 py-2.5 bg-slate-800 rounded-xl flex items-center justify-center text-white text-[9px] font-black shadow-xl hover:bg-slate-700 self-end uppercase border border-slate-600">PNG <Download className="w-3.5 h-3.5 ml-2" /></button>
                    <button onClick={() => downloadSingle(activeItem, 'psd')} className="px-4 py-2.5 bg-blue-600 rounded-xl flex items-center justify-center text-white text-[9px] font-black shadow-xl hover:bg-blue-500 self-end uppercase border border-blue-400/30">PSD <Layers className="w-3.5 h-3.5 ml-2" /></button>
                  </div>
                </>
              )}
            </div>
          )}

          {activeItem && activeItem.selectedResultIndex === -1 && (
            <div className="absolute bottom-10 flex gap-4 z-30">
              <button onClick={() => setCanvasActive(!canvasActive)} className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase shadow-2xl transition-all ${canvasActive ? 'bg-red-500 text-white' : 'bg-white text-black hover:scale-105'}`}>
                {canvasActive ? 'Hủy Mask' : 'Vẽ DNA Mask'}
              </button>
              {canvasActive && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <button onClick={handleUndo} className="w-14 h-14 bg-slate-900/80 backdrop-blur-md rounded-2xl flex items-center justify-center text-white border border-slate-700 shadow-xl hover:bg-slate-800 transition-colors"><Undo className="w-5 h-5" /></button>
                    <button onClick={() => { updateItemBlending(activeItem.id, { undoStack: [], redoStack: [], mask: null }); setupCanvas(); }} className="w-14 h-14 bg-slate-900/80 backdrop-blur-md rounded-2xl flex items-center justify-center text-red-500 border border-slate-700 shadow-xl hover:bg-red-500/10 transition-colors"><Trash2 className="w-5 h-5" /></button>

                    <div className="flex items-center gap-2 bg-slate-900/80 backdrop-blur-md px-3 rounded-2xl border border-slate-700 shadow-xl h-14">
                      <button onClick={() => setIsEraser(false)} className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase transition-all ${!isEraser ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:bg-slate-800'}`}>CỌ VẼ</button>
                      <button onClick={() => setIsEraser(true)} className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase transition-all ${isEraser ? 'bg-red-500 text-white shadow' : 'text-slate-500 hover:bg-slate-800'}`}>TẨY MASK</button>
                    </div>

                    <div className="flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-6 rounded-2xl border border-slate-700 shadow-xl h-14">
                      <span className="text-[9px] font-black text-slate-500 uppercase">Cọ Resize ({brushSize}px)</span>
                      <input type="range" min="5" max="250" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} className="w-32 h-1.5 accent-red-500" />
                    </div>
                  </div>
                  <div className="text-center"><span className="text-blue-400 text-[9px] font-black uppercase bg-black/60 px-4 py-1.5 rounded-full backdrop-blur-md border border-slate-700 shadow-lg inline-block">Mẹo: Giữ Phím SPACE + Nhấn Chuột Trái để di chuyển và Cuộn Chuột để thu phóng ảnh</span></div>
                </motion.div>
              )}
            </div>
          )}

          {loading && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95 backdrop-blur-3xl animate-fadeIn">
              <Loader2 className="w-16 h-16 text-blue-500 animate-spin" />
            </div>
          )}
        </div>

        {/* Batch Tray */}
        {items.length > 0 && (
          <div className="glass-effect rounded-[2rem] p-4 flex gap-4 overflow-x-auto custom-scrollbar border border-slate-700/50">
            {items.map((item, idx) => (
              <div key={item.id} className="relative flex-shrink-0 group">
                <button
                  onClick={() => { setCurrentIndex(idx); setZoom(1); setOffset({ x: 0, y: 0 }); setCanvasActive(false); }}
                  className={`w-20 h-20 rounded-2xl overflow-hidden border-2 transition-all block ${currentIndex === idx ? 'border-blue-500 ring-4 ring-blue-500/20' : 'border-slate-800 opacity-60 hover:opacity-100'}`}
                >
                  <img src={item.original} className="w-full h-full object-cover" />
                  {item.isProcessing && <div className="absolute inset-0 bg-black/60 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-white" /></div>}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const willDeleteCurrent = currentIndex === idx;
                    const prevItems = [...items];
                    setItems(prev => prev.filter((_, i) => i !== idx));
                    if (willDeleteCurrent) {
                      setCurrentIndex(-1);
                      setCanvasActive(false);
                    } else if (currentIndex > idx) {
                      setCurrentIndex(currentIndex - 1);
                    }
                  }}
                  className="absolute -top-1 -right-1 z-30 w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                {item.results.length > 0 && <span className="absolute bottom-1 right-1 bg-blue-600 text-white text-[8px] px-1.5 py-0.5 rounded-md font-black">{item.results.length}</span>}
              </div>
            ))}
            <button onClick={() => fileInputRef.current?.click()} className="w-20 h-20 flex-shrink-0 rounded-2xl border-2 border-dashed border-slate-700 flex items-center justify-center text-slate-600 hover:text-blue-400 hover:border-blue-500 transition-all"><Plus className="w-6 h-6" /></button>
          </div>
        )}
      </div>
    </div>
  );
};
