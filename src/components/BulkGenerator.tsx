
import { useState, useRef, useEffect, useCallback } from 'react';
import React from 'react';
import { createPortal } from 'react-dom';
import { gemini, optimizeReferenceImage, applyLocalNoise, NoiseProfile, ImageQuality } from '../services/gemini';
import { clipImageWithMask } from '../utils/imageProcessor';
import { PsdLayerParams, createMultiLayerPsdBlob } from '../services/psdExport';
import { toast } from 'sonner';

interface BulkItem {
  id: string;
  file: File; // Giữ File gốc, chỉ đọc base64 khi cần xử lý
  original: string; // Blob URL cho hiển thị full-size preview
  thumbnail: string; // Base64 nhỏ (~300px) cho grid
  results: string[];
  rawResults: string[]; // Lưu trữ ảnh AI thô để hòa trộn lại
  status: 'pending' | 'processing' | 'completed' | 'error';
  error?: string;
  mask: string | null;
  selectedResultIndex: number;
  featherAmount: number;
  blendOpacity: number;
}

// Đọc full base64 từ File chỉ khi cần xử lý AI (on-demand, không giữ trong state)
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Lỗi đọc file'));
    reader.readAsDataURL(file);
  });
}

// Tạo thumbnail nhỏ bằng createImageBitmap (KHÔNG chặn main thread)
async function createThumbnail(file: File, maxSize: number = 200): Promise<string> {
  try {
    // createImageBitmap decode ảnh off main thread - không gây lag
    const bitmap = await createImageBitmap(file, {
      resizeWidth: maxSize,
      resizeHeight: maxSize,
      resizeQuality: 'low'
    });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.5);
  } catch {
    // Fallback nếu browser không hỗ trợ resize option
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.5);
  }
}

export const BulkGenerator: React.FC = () => {
  const [items, setItems] = useState<BulkItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [refImage, setRefImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<ImageQuality>('4K');
  const [numVariants, setNumVariants] = useState<number>(1);
  const [noiseAmount, setNoiseAmount] = useState<number>(0);
  const [noiseTarget, setNoiseTarget] = useState<'global' | 'mask'>('global');
  const [noiseProfile, setNoiseProfile] = useState<NoiseProfile>('digital');
  const [processing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, loading: false });
  const [mode, setMode] = useState<'edit' | 'upscale'>('edit');
  const [isChainedDNA, setIsChainedDNA] = useState(true);

  const [isDraggingBulk, setIsDraggingBulk] = useState(false);
  const [showOriginalInPreview, setShowOriginalInPreview] = useState(false);

  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isPreviewPanning, setIsPreviewPanning] = useState(false);
  const [previewPanStart, setPreviewPanStart] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  const [editingItem, setEditingItem] = useState<BulkItem | null>(null);
  const [brushSize, setBrushSize] = useState(40);
  const [isEraser, setIsEraser] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isHoveringModal, setIsHoveringModal] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const modalCanvasRef = useRef<HTMLCanvasElement>(null);
  const modalDisplayCanvasRef = useRef<HTMLCanvasElement>(null);
  const modalImgRef = useRef<HTMLImageElement>(null);

  const bulkInspectionContainerRef = useRef<HTMLDivElement>(null);
  const modalEditorZoneRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (cursorRef.current && editingItem && isHoveringModal && !isSpacePressed) {
        cursorRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
      }
    };
    window.addEventListener('pointermove', handleMove);
    return () => window.removeEventListener('pointermove', handleMove);
  }, [editingItem, isHoveringModal, isSpacePressed]);

  const bulkInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  const selectedItem = items.find(it => it.id === selectedItemId) || items[0];

  useEffect(() => {
    const container = bulkInspectionContainerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.25;
      const delta = e.deltaY > 0 ? 1 - zoomSpeed : 1 + zoomSpeed;
      setPreviewZoom(z => Math.min(Math.max(z * delta, 0.8), 25));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [items.length]);

  useEffect(() => {
    const container = modalEditorZoneRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.2;
      const delta = e.deltaY > 0 ? 1 - zoomSpeed : 1 + zoomSpeed;
      setZoom(z => Math.min(Math.max(z * delta, 0.5), 15));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [editingItem]);

  useEffect(() => {
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
  }, [selectedItemId]);

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

  /**
   * Bộ máy re-blend cho Bulk Item
   */
  const reblendItem = useCallback(async (itemId: string, feather: number, opacity: number, resultIdx: number) => {
    const item = items.find(it => it.id === itemId);
    if (!item || resultIdx === -1 || !item.rawResults[resultIdx]) return;

    const originalImg = new Image(); originalImg.src = item.original; await new Promise(r => originalImg.onload = r);
    const aiImg = new Image(); aiImg.src = item.rawResults[resultIdx]; await new Promise(r => aiImg.onload = r);

    const targetW = originalImg.naturalWidth;
    const targetH = originalImg.naturalHeight;

    const finalCanvas = document.createElement('canvas'); finalCanvas.width = targetW; finalCanvas.height = targetH;
    const fctx = finalCanvas.getContext('2d')!;
    fctx.drawImage(originalImg, 0, 0);

    if (item.mask) {
      const aiLayer = document.createElement('canvas'); aiLayer.width = targetW; aiLayer.height = targetH;
      const actx = aiLayer.getContext('2d')!;
      actx.globalAlpha = opacity / 100;

      const aiSize = aiImg.width;
      let rW, rH, oX, oY;
      if (targetW > targetH) { rW = aiSize; rH = (targetH * aiSize) / targetW; oX = 0; oY = (aiSize - rH) / 2; }
      else { rH = aiSize; rW = (targetW * aiSize) / targetH; oY = 0; oX = (aiSize - rW) / 2; }
      actx.drawImage(aiImg, oX, oY, rW, rH, 0, 0, targetW, targetH);

      const fm = document.createElement('canvas'); fm.width = targetW; fm.height = targetH;
      const fmctx = fm.getContext('2d')!;
      fmctx.filter = `blur(${feather}px)`;
      const maskImg = new Image(); maskImg.src = item.mask; await new Promise(r => maskImg.onload = r);
      fmctx.drawImage(maskImg, 0, 0, targetW, targetH);

      actx.globalCompositeOperation = 'destination-in';
      actx.drawImage(fm, 0, 0);
      fctx.drawImage(aiLayer, 0, 0);
    } else {
      fctx.globalAlpha = opacity / 100;
      const aiSize = aiImg.width;
      let rW, rH, oX, oY;
      if (targetW > targetH) { rW = aiSize; rH = (targetH * aiSize) / targetW; oX = 0; oY = (aiSize - rH) / 2; }
      else { rH = aiSize; rW = (targetW * aiSize) / targetH; oY = 0; oX = (aiSize - rW) / 2; }
      fctx.drawImage(aiImg, oX, oY, rW, rH, 0, 0, targetW, targetH);
    }

    const blended = finalCanvas.toDataURL('image/png');
    setItems(prev => prev.map(it => it.id === itemId ? {
      ...it, results: it.results.map((r, i) => i === resultIdx ? blended : r)
    } : it));
  }, [items]);

  const handleFiles = async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setUploadProgress({ current: 0, total: imageFiles.length, loading: true });
    // Xử lý từng file, yield giữa mỗi file để trình duyệt không đứng
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      setUploadProgress(prev => ({ ...prev, current: i + 1 }));
      try {
        // Yield cho browser render giữa mỗi file (20ms đủ cho 1 frame)
        await new Promise(r => setTimeout(r, 20));
        const thumbnail = await createThumbnail(file);
        const blobUrl = URL.createObjectURL(file);
        const newItem: BulkItem = {
          id: Math.random().toString(36).substr(2, 9),
          file,
          original: blobUrl,
          thumbnail,
          results: [],
          rawResults: [],
          mask: null,
          status: 'pending',
          selectedResultIndex: -1,
          featherAmount: 15,
          blendOpacity: 100
        };
        setItems(prev => {
          const updated = [...prev, newItem];
          if (!selectedItemId) setSelectedItemId(newItem.id);
          return updated;
        });
      } catch (e) {
        console.warn('Bỏ qua file lỗi:', file.name, e);
      }
    }
    setUploadProgress({ current: 0, total: 0, loading: false });
  };

  const handleBulkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) handleFiles(Array.from(files));
    if (bulkInputRef.current) bulkInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBulk(false);
    const files = Array.from(e.dataTransfer.files) as File[];
    if (files.length > 0) handleFiles(files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBulk(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBulk(false);
  };

  const useResultAsSource = (id: string) => {
    setItems(prev => prev.map(it => {
      if (it.id === id && it.selectedResultIndex >= 0) {
        return { ...it, original: it.results[it.selectedResultIndex], results: [], rawResults: [], status: 'pending', mask: null, selectedResultIndex: -1 };
      }
      return it;
    }));
  };

  const discardResult = (id: string, index: number) => {
    setItems(prev => prev.map(it => {
      if (it.id === id) {
        const newResults = it.results.filter((_, i) => i !== index);
        const newRaw = it.rawResults.filter((_, i) => i !== index);
        return {
          ...it,
          results: newResults,
          rawResults: newRaw,
          status: newResults.length === 0 ? 'pending' : it.status,
          selectedResultIndex: newResults.length > 0 ? 0 : -1
        };
      }
      return it;
    }));
  };

  const downloadSingle = async (item: BulkItem, asPsd: boolean = false) => {
    if (item.selectedResultIndex < 0) return;

    if (!asPsd) {
      const link = document.createElement('a');
      link.href = item.results[item.selectedResultIndex];
      link.download = `MARIE_BULK_${item.id}_v${item.selectedResultIndex}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    // Export as PSD with Mask Isolation
    const layers: PsdLayerParams[] = [];
    layers.push({ name: 'Original', base64: item.original });

    const aiResult = item.results[item.selectedResultIndex];
    if (item.mask) {
      try {
        const img = new Image();
        img.src = item.original;
        await new Promise(r => img.onload = r);
        const clipped = await clipImageWithMask(aiResult, item.mask, img.width, img.height);
        layers.push({ name: 'AI Result (Isolated)', base64: clipped });
      } catch (e) {
        layers.push({ name: 'AI Result', base64: aiResult });
      }
    } else {
      layers.push({ name: 'AI Result', base64: aiResult });
    }

    try {
      const blob = await createMultiLayerPsdBlob(layers);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `MARIE_BULK_${item.id}.psd`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate PSD");
    }
  };

  const downloadAll = async (asPsd: boolean = false) => {
    const completedItems = items.filter(it => it.results.length > 0 && it.status === 'completed');
    if (completedItems.length === 0) return;

    if (!asPsd) {
      for (const item of completedItems) {
        await downloadSingle(item, false);
        await new Promise(r => setTimeout(r, 400));
      }
      return;
    }

    const promise = (async () => {
      let count = 0;
      for (const item of completedItems) {
        await downloadSingle(item, true);
        count++;
        await new Promise(r => setTimeout(r, 400));
      }
      return count;
    })();

    toast.promise(promise, {
      loading: `Gói ${completedItems.length} file PSD...`,
      success: (c) => `Tải thành công ${c} file PSD!`,
      error: 'Lỗi tải PSD hàng loạt'
    });
  };



  const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const optimized = await optimizeReferenceImage(ev.target?.result as string);
        setRefImage(optimized);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleBatchLocalGrain = async () => {
    if (processing || items.length === 0) return;
    setProcessing(true);
    for (const item of items) {
      const source = (item.results.length > 0 && item.selectedResultIndex >= 0)
        ? item.results[item.selectedResultIndex]
        : item.original;

      const noised = await applyLocalNoise(source, noiseAmount, noiseTarget === 'mask' ? item.mask : null, noiseProfile);

      setItems(prev => prev.map(it => it.id === item.id ? {
        ...it,
        results: [noised, ...it.results],
        rawResults: [noised, ...it.rawResults],
        selectedResultIndex: 0,
        status: 'completed'
      } : it));
      await new Promise(r => setTimeout(r, 100));
    }
    setProcessing(false);
  };

  const processSingleItem = async (index: number, retryCount: number = 0, customSalt?: string, chainedRef?: string): Promise<string[] | null> => {
    const item = items[index];
    setItems(prev => prev.map((it, idx) => idx === index ? { ...it, status: 'processing', error: undefined } : it));
    try {
      // Đọc full base64 ON-DEMAND chỉ khi cần xử lý AI
      const fullBase64 = await readFileAsBase64(item.file);

      // Xử lý TUẦN TỰ từng variant thay vì Promise.all (tránh overload RAM)
      const rawResponses: string[] = [];
      for (let vIdx = 0; vIdx < numVariants; vIdx++) {
        const res = await gemini.processImage(
          mode === 'upscale' ? "Quantum Optical Super-Res Reconstruction." : (prompt || "Precision reconstruction."),
          fullBase64, quality, chainedRef || refImage || undefined, customSalt || `BULK_${item.id}_${Date.now()}_v${vIdx}`,
          !!chainedRef, noiseAmount, noiseTarget === 'mask' ? item.mask : null, noiseProfile
        );
        if (res) rawResponses.push(res);
        // Delay nhỏ giữa các variant để trình duyệt "thở"
        if (vIdx < numVariants - 1) await new Promise(r => setTimeout(r, 500));
      }

      if (rawResponses.length > 0) {
        setItems(prev => prev.map((it, idx) => idx === index ? {
          ...it,
          rawResults: [...rawResponses, ...it.rawResults],
          results: [...rawResponses, ...it.results],
          status: 'completed',
          selectedResultIndex: 0
        } : it));
        return rawResponses;
      }
      return null;
    } catch (err: any) {
      if (retryCount < 1) { await new Promise(r => setTimeout(r, 2000)); return await processSingleItem(index, retryCount + 1, customSalt, chainedRef); }
      setItems(prev => prev.map((it, idx) => idx === index ? { ...it, status: 'error', error: err.message } : it));
      return null;
    }
  };

  const handleStartBatch = async () => {
    if (processing || items.length === 0) return;
    setProcessing(true);
    const pendingItems = items.filter(it => it.status !== 'completed' || it.results.length === 0);
    setBatchProgress({ current: 0, total: pendingItems.length || items.length });
    const batchSalt = `BATCH_${Date.now()}`;
    let lastRes: string | undefined = undefined;
    let processed = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'completed' || items[i].results.length === 0) {
        processed++;
        setBatchProgress({ current: processed, total: pendingItems.length });
        const results = await processSingleItem(i, 0, batchSalt, isChainedDNA ? lastRes : undefined);
        if (results && results.length > 0) lastRes = results[0];
        // Delay giữa các item để tránh overload
        await new Promise(r => setTimeout(r, 800));
      } else {
        lastRes = items[i].rawResults[items[i].selectedResultIndex] || undefined;
      }
    }
    setBatchProgress({ current: 0, total: 0 });
    setProcessing(false);
  };

  return (
    <div className="flex flex-col gap-6 p-6 animate-fadeIn max-w-[1800px] mx-auto min-h-screen">
      {editingItem && isHoveringModal && !isSpacePressed && typeof document !== 'undefined' && createPortal(
        <div ref={cursorRef} style={{ position: 'fixed', left: 0, top: 0, width: `${brushSize}px`, height: `${brushSize}px`, border: isEraser ? '2px solid rgba(255, 0, 0, 0.8)' : '2px solid white', boxShadow: '0 0 8px rgba(0,0,0,0.5)', backgroundColor: isEraser ? 'transparent' : `rgba(255, 0, 0, 0.4)`, pointerEvents: 'none', zIndex: 999999, borderRadius: '50%' }} />,
        document.body
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-3 space-y-6">
          <div className="glass-effect p-6 rounded-3xl border border-slate-700 shadow-2xl space-y-6">
            <h3 className="text-xl font-bold text-purple-400 uppercase tracking-tighter">MARIE BATCH CONTROL</h3>
            <div className="space-y-4">
              <div
                onClick={() => !uploadProgress.loading && bulkInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`w-full py-8 border-2 border-dashed rounded-2xl flex flex-col items-center gap-2 bg-slate-900/40 transition-all cursor-pointer ${isDraggingBulk ? 'border-blue-500 bg-blue-500/10 scale-[1.02]' : 'border-slate-700 hover:border-blue-500'}`}
              >
                {uploadProgress.loading ? (
                  <>
                    <svg className="animate-spin w-5 h-5 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                    <span className="text-[10px] text-blue-400 font-black uppercase">{uploadProgress.current}/{uploadProgress.total} đang tải...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5 text-slate-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" /></svg>
                    <span className="text-[10px] text-slate-400 font-black uppercase">Kéo thả hoặc bấm để thêm ảnh</span>
                  </>
                )}
              </div>
              <input type="file" ref={bulkInputRef} onChange={handleBulkUpload} className="hidden" accept="image/*" multiple />

              {/* Batch Blending Controls */}
              {selectedItem && selectedItem.results.length > 0 && (
                <div className="p-4 bg-slate-950/80 rounded-2xl border border-blue-500/20 space-y-4 animate-slideUp">
                  <h4 className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center justify-between">Hòa trộn Batch <i className="fa-solid fa-sliders"></i></h4>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px] font-black text-slate-500 uppercase"><span>Feathering</span><span className="text-blue-400">{selectedItem.featherAmount}px</span></div>
                    <input type="range" min="0" max="100" value={selectedItem.featherAmount} onChange={(e) => {
                      const val = parseInt(e.target.value);
                      setItems(prev => prev.map(it => it.id === selectedItem.id ? { ...it, featherAmount: val } : it));
                      reblendItem(selectedItem.id, val, selectedItem.blendOpacity, selectedItem.selectedResultIndex);
                    }} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px] font-black text-slate-500 uppercase"><span>Opacity</span><span className="text-blue-400">{selectedItem.blendOpacity}%</span></div>
                    <input type="range" min="0" max="100" value={selectedItem.blendOpacity} onChange={(e) => {
                      const val = parseInt(e.target.value);
                      setItems(prev => prev.map(it => it.id === selectedItem.id ? { ...it, blendOpacity: val } : it));
                      reblendItem(selectedItem.id, selectedItem.featherAmount, val, selectedItem.selectedResultIndex);
                    }} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
                  </div>
                </div>
              )}

              <div className="p-4 bg-slate-900/60 rounded-2xl border border-slate-800">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-[9px] text-slate-500 font-black uppercase">Style DNA</label>
                  <div className="flex items-center gap-2">
                    <span className="text-[8px] text-blue-400 font-black uppercase">Chained DNA</span>
                    <button onClick={() => setIsChainedDNA(!isChainedDNA)} className={`w-8 h-4 rounded-full relative transition-all ${isChainedDNA ? 'bg-blue-600' : 'bg-slate-700'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${isChainedDNA ? 'left-4.5' : 'left-0.5'}`}></div>
                    </button>
                  </div>
                </div>
                <button onClick={() => refInputRef.current?.click()} className={`w-full aspect-video rounded-xl border-2 border-dashed flex items-center justify-center overflow-hidden transition-all ${refImage ? 'border-purple-500' : 'border-slate-700 hover:border-purple-500'}`}>
                  {refImage ? <img src={refImage} className="w-full h-full object-cover" /> : <i className="fa-solid fa-palette text-slate-700"></i>}
                </button>
                <input type="file" ref={refInputRef} onChange={handleRefUpload} className="hidden" accept="image/*" />
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800">
                <button onClick={() => setMode('edit')} className={`flex-1 py-2 rounded-lg text-[9px] font-black ${mode === 'edit' ? 'bg-purple-600 text-white' : 'text-slate-500'}`}>EDIT</button>
                <button onClick={() => setMode('upscale')} className={`flex-1 py-2 rounded-lg text-[9px] font-black ${mode === 'upscale' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>UPSCALE</button>
              </div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Yêu cầu batch..." className="w-full h-24 bg-slate-950 border border-slate-800 rounded-xl p-4 text-[11px] outline-none focus:border-blue-500" />

              <div className="p-4 bg-slate-900/60 rounded-2xl border border-slate-800 space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase">
                    <span>Batch Noise Profile</span>
                  </div>
                  <div className="flex gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
                    {(['digital', 'film', 'coarse'] as NoiseProfile[]).map(p => (
                      <button
                        key={p}
                        onClick={() => setNoiseProfile(p)}
                        className={`flex-1 py-1.5 rounded-md text-[7px] font-black transition-all ${noiseProfile === p ? 'bg-purple-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                      >
                        {p === 'digital' ? 'SHARP' : p === 'film' ? 'ORGANIC' : 'COARSE'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase">
                    <span>Intensity</span>
                    <span className="text-purple-400">{noiseAmount}%</span>
                  </div>
                  <input
                    type="range" min="0" max="100" value={noiseAmount}
                    onChange={(e) => setNoiseAmount(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-slate-700 rounded-lg accent-purple-500"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[8px] font-black text-slate-500 uppercase">Phạm vi:</span>
                  <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                    <button
                      onClick={() => setNoiseTarget('global')}
                      className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'global' ? 'bg-purple-600 text-white' : 'text-slate-500'}`}
                    >
                      TOÀN BỘ
                    </button>
                    <button
                      onClick={() => setNoiseTarget('mask')}
                      className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'mask' ? 'bg-purple-600 text-white' : 'text-slate-500'}`}
                    >
                      VÙNG CHỌN
                    </button>
                  </div>
                </div>

                <button
                  onClick={handleBatchLocalGrain}
                  disabled={processing || noiseAmount === 0 || items.length === 0}
                  className="w-full py-2.5 bg-slate-800 border border-slate-700 text-purple-400 rounded-xl text-[9px] font-black uppercase hover:bg-slate-700 transition-all disabled:opacity-30"
                >
                  Batch Local Grain (0% AI)
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center px-1">
                  <span className="text-[9px] font-black text-slate-500 uppercase">Variants</span>
                  <div className="flex gap-2">
                    {[1, 2, 4].map(n => (
                      <button key={n} onClick={() => setNumVariants(n)} className={`w-6 h-6 rounded flex items-center justify-center text-[9px] font-black border transition-all ${numVariants === n ? 'bg-purple-600 border-purple-400 text-white' : 'border-slate-800 text-slate-500'}`}>{n}</button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['1K', '2K', '4K', '6K'] as ImageQuality[]).map(q => (
                    <button key={q} onClick={() => setQuality(q)} className={`flex-1 py-2 rounded-lg text-[9px] font-black border relative ${quality === q ? 'bg-white text-black' : 'border-slate-700 text-slate-500'}`}>
                      {q}
                      {q === '6K' && <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[5px] px-1 rounded-full shadow-md">ULTRA</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button disabled={processing || items.length === 0} onClick={handleStartBatch} className="bg-blue-600 text-white font-black py-4 rounded-xl text-[9px] uppercase shadow-xl disabled:opacity-50 transition-all hover:bg-blue-500">
                {processing ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                    {batchProgress.total > 0 ? `${batchProgress.current}/${batchProgress.total}` : '...'}
                  </span>
                ) : (
                  <span>▶ Chạy Batch</span>
                )}
              </button>
              <div className="flex bg-cyan-900/40 rounded-xl overflow-hidden shadow-xl border border-cyan-500/30">
                <button disabled={processing || items.filter(it => it.results.length > 0).length === 0} onClick={() => downloadAll(false)} className="flex-1 text-cyan-400 font-black py-4 text-[9px] uppercase disabled:opacity-50 transition-all hover:bg-cyan-500/20">
                  <i className="fa-solid fa-download"></i> Tải Ảnh
                </button>
                <div className="w-px bg-cyan-500/30"></div>
                <button disabled={processing || items.filter(it => it.results.length > 0).length === 0} onClick={() => downloadAll(true)} className="flex-1 text-blue-400 font-black py-4 text-[9px] uppercase disabled:opacity-50 transition-all hover:bg-blue-500/20">
                  <i className="fa-solid fa-layer-group"></i> Tải PSD
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="xl:col-span-4 space-y-4">
          <div className="flex items-center justify-between px-2">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Danh sách ({items.length})</span>
            <button onClick={() => setItems([])} className="text-[9px] font-black text-red-500 uppercase">Xóa hết</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-3 max-h-[calc(100vh-200px)] overflow-y-auto custom-scrollbar pr-2">
            {items.map((item, idx) => (
              <div key={item.id} onClick={() => setSelectedItemId(item.id)} className={`group glass-effect rounded-2xl border transition-all cursor-pointer overflow-hidden relative aspect-square ${selectedItemId === item.id ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-slate-800'}`}>
                <img src={(item.results.length > 0 && item.selectedResultIndex >= 0) ? item.results[item.selectedResultIndex] : item.thumbnail} className={`w-full h-full object-cover ${item.status === 'processing' ? 'blur-sm opacity-50' : ''}`} loading="lazy" />
                <button onClick={(e) => { e.stopPropagation(); if (selectedItemId === item.id) setSelectedItemId(null); setItems(prev => prev.filter(it => it.id !== item.id)) }} className="absolute top-2 left-2 z-30 w-6 h-6 rounded-full bg-red-600/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"><i className="fa-solid fa-xmark text-[10px]"></i></button>
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 px-2">
                  <button onClick={(e) => { e.stopPropagation(); setEditingItem(item); }} className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center shadow-lg"><i className="fa-solid fa-paintbrush text-[11px]"></i></button>
                  {item.results.length > 0 && (
                    <>
                      <button onClick={(e) => { e.stopPropagation(); downloadSingle(item, false); }} className="w-8 h-8 rounded-full bg-cyan-500 text-white flex items-center justify-center shadow-lg hover:bg-cyan-400 transition-colors" title="Tải ảnh PNG"><i className="fa-solid fa-download text-[11px]"></i></button>
                      <button onClick={(e) => { e.stopPropagation(); downloadSingle(item, true); }} className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-lg hover:bg-blue-500 transition-colors" title="Tải ảnh PSD (Tách Layer AI)"><i className="fa-solid fa-layer-group text-[11px]"></i></button>
                    </>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); processSingleItem(idx, 0, `RETRY_${Date.now()}`); }} className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg"><i className="fa-solid fa-rotate-right text-[11px]"></i></button>
                </div>
                {item.status === 'processing' && <div className="absolute inset-0 flex items-center justify-center"><i className="fa-solid fa-spinner animate-spin text-white"></i></div>}
                {item.results.length > 0 && <div className="absolute top-2 right-2 px-1.5 py-0.5 bg-green-500 rounded text-[7px] font-black text-white border border-white/20 uppercase">{item.results.length}v</div>}
              </div>
            ))}
          </div>
        </div>

        <div className="xl:col-span-5">
          <div ref={bulkInspectionContainerRef} className="glass-effect rounded-[2.5rem] border border-slate-700 bg-slate-950/40 p-6 h-[calc(100vh-140px)] flex flex-col gap-6 shadow-2xl relative overflow-hidden sticky top-24">
            {selectedItem ? (
              <>
                <div className="flex justify-between items-center z-20">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Inspection: #{items.findIndex(it => it.id === selectedItemId) + 1}</span>
                    <span className="text-[8px] text-slate-400 font-black uppercase px-1.5 py-0.5 bg-slate-800 rounded mt-1">Zoom: {Math.round(previewZoom * 100)}%</span>
                  </div>
                  <div className="flex gap-2">
                    {selectedItem.results.length > 0 && (
                      <>
                        <button onClick={() => useResultAsSource(selectedItem.id)} className="px-4 py-2 bg-blue-600 rounded-xl text-[9px] font-black uppercase text-white shadow-lg flex items-center gap-2">Lấy làm gốc</button>
                        <button onClick={() => discardResult(selectedItem.id, selectedItem.selectedResultIndex)} className="px-4 py-2 bg-slate-800 border border-red-500/20 rounded-xl text-[9px] font-black uppercase text-red-500">Hủy bản này</button>
                        <button onClick={() => downloadSingle(selectedItem)} className="px-4 py-2 bg-cyan-600 rounded-xl text-[9px] font-black uppercase text-white shadow-lg flex items-center gap-2"><i className="fa-solid fa-download"></i> Tải Xuống</button>
                      </>
                    )}
                    <button onMouseDown={() => setShowOriginalInPreview(true)} onMouseUp={() => setShowOriginalInPreview(false)} className="px-4 py-2 bg-slate-800 rounded-xl text-[9px] font-black uppercase text-amber-500 transition-all active:scale-95">So sánh</button>
                    <button onClick={() => processSingleItem(items.findIndex(it => it.id === selectedItemId), 0)} disabled={processing} className="px-4 py-2 bg-purple-600 rounded-xl text-[9px] font-black uppercase text-white flex items-center gap-2">Tạo thêm</button>
                  </div>
                </div>

                {selectedItem.results.length > 0 && (
                  <div className="z-20 flex gap-2 overflow-x-auto custom-scrollbar pb-1">
                    {selectedItem.results.map((res, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setItems(prev => prev.map(it => it.id === selectedItem.id ? { ...it, selectedResultIndex: idx } : it));
                        }}
                        className={`flex-shrink-0 w-12 h-12 rounded-lg border-2 transition-all ${selectedItem.selectedResultIndex === idx ? 'border-blue-500' : 'border-slate-800 opacity-50'}`}
                      >
                        <img src={res} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}

                <div onMouseDown={e => { if (isSpacePressed || e.button === 1) { setIsPreviewPanning(true); setPreviewPanStart({ x: e.clientX - previewOffset.x, y: e.clientY - previewOffset.y }) } }} onMouseMove={e => { if (isPreviewPanning) { setPreviewOffset({ x: e.clientX - previewPanStart.x, y: e.clientY - previewPanStart.y }) } }} onMouseUp={() => setIsPreviewPanning(false)} onMouseLeave={() => setIsPreviewPanning(false)} className={`flex-1 bg-black rounded-3xl overflow-hidden relative flex items-center justify-center ${isSpacePressed ? 'cursor-grab' : 'cursor-default'}`}>
                  <div style={{ transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewZoom})`, transition: isPreviewPanning ? 'none' : 'transform 0.1s' }} className="relative w-full h-full flex items-center justify-center">
                    <img src={(showOriginalInPreview || selectedItem.results.length === 0) ? selectedItem.original : selectedItem.results[selectedItem.selectedResultIndex]} className="max-h-full max-w-full object-contain select-none" draggable={false} />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center opacity-20"><i className="fa-solid fa-magnifying-glass text-6xl mb-4"></i><p className="text-[10px] font-black uppercase">Chọn hình ảnh</p></div>
            )}
          </div>
        </div>
      </div>

      {editingItem && (
        <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl bg-slate-900 rounded-[3rem] p-8 space-y-6 border border-slate-700 animate-slideUp">
            <div className="flex justify-between items-center"><h4 className="font-black uppercase text-sm text-red-500">Edit Mask</h4><button onClick={() => setEditingItem(null)} className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center hover:bg-red-500"><i className="fa-solid fa-xmark"></i></button></div>
            <div ref={modalEditorZoneRef} onMouseDown={e => { if (e.button === 1 || isSpacePressed) { setIsPanning(true); setPanStart({ x: e.clientX - offset.x, y: e.clientY - offset.y }) } }} onMouseMove={e => { if (isPanning) { setOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }) } }} onMouseUp={() => setIsPanning(false)} onMouseEnter={() => setIsHoveringModal(true)} onMouseLeave={() => { setIsPanning(false); setIsHoveringModal(false) }} className={`relative border border-slate-700 rounded-2xl overflow-hidden bg-black flex items-center justify-center h-[60vh] ${isPanning || isSpacePressed ? 'cursor-grab' : 'cursor-none'}`}>
              <div style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`, transition: isPanning || isDrawing ? 'none' : 'transform 0.1s' }}>
                <div className="relative inline-block">
                  <img ref={modalImgRef} src={editingItem.original} className="max-h-[50vh] select-none pointer-events-none" onLoad={() => { if (modalDisplayCanvasRef.current && modalCanvasRef.current && modalImgRef.current) { const img = modalImgRef.current; modalCanvasRef.current.width = img.naturalWidth; modalCanvasRef.current.height = img.naturalHeight; modalDisplayCanvasRef.current.width = img.clientWidth; modalDisplayCanvasRef.current.height = img.clientHeight; const dctx = modalDisplayCanvasRef.current.getContext('2d')!; dctx.lineCap = 'round'; dctx.strokeStyle = '#FF0000'; const mctx = modalCanvasRef.current.getContext('2d')!; mctx.lineCap = 'round'; mctx.strokeStyle = '#FF0000'; if (editingItem.mask) { const mi = new Image(); mi.onload = () => { dctx.drawImage(mi, 0, 0, img.clientWidth, img.clientHeight); mctx.drawImage(mi, 0, 0) }; mi.src = editingItem.mask } } }} />
                  <canvas
                    ref={modalDisplayCanvasRef}
                    onPointerDown={(e) => {
                      if (!isSpacePressed) {
                        setIsDrawing(true);
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        const rect = modalDisplayCanvasRef.current!.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / rect.width;
                        const ny = (e.clientY - rect.top) / rect.height;

                        const dctx = modalDisplayCanvasRef.current!.getContext('2d')!;
                        const mctx = modalCanvasRef.current!.getContext('2d')!;
                        const dX = nx * modalDisplayCanvasRef.current!.width;
                        const dY = ny * modalDisplayCanvasRef.current!.height;
                        const mX = nx * modalCanvasRef.current!.width;
                        const mY = ny * modalCanvasRef.current!.height;

                        const bsD = brushSize * (modalDisplayCanvasRef.current!.width / rect.width);
                        const bsM = brushSize * (modalCanvasRef.current!.width / rect.width);

                        dctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
                        mctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';

                        dctx.beginPath(); dctx.moveTo(dX, dY); dctx.lineWidth = bsD; dctx.lineTo(dX, dY); dctx.stroke();
                        mctx.beginPath(); mctx.moveTo(mX, mY); mctx.lineWidth = bsM; mctx.lineTo(mX, mY); mctx.stroke();
                      }
                    }}
                    onPointerMove={(e) => {
                      if (isDrawing && !isSpacePressed) {
                        const rect = modalDisplayCanvasRef.current!.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / rect.width;
                        const ny = (e.clientY - rect.top) / rect.height;

                        const dctx = modalDisplayCanvasRef.current!.getContext('2d')!;
                        const mctx = modalCanvasRef.current!.getContext('2d')!;
                        const dX = nx * modalDisplayCanvasRef.current!.width;
                        const dY = ny * modalDisplayCanvasRef.current!.height;
                        const mX = nx * modalCanvasRef.current!.width;
                        const mY = ny * modalCanvasRef.current!.height;

                        const bsD = brushSize * (modalDisplayCanvasRef.current!.width / rect.width);
                        const bsM = brushSize * (modalCanvasRef.current!.width / rect.width);

                        dctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
                        mctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';

                        dctx.lineWidth = bsD; dctx.lineTo(dX, dY); dctx.stroke();
                        mctx.lineWidth = bsM; mctx.lineTo(mX, mY); mctx.stroke();
                      }
                    }}
                    onPointerUp={(e) => {
                      setIsDrawing(false);
                      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                    }}
                    className={`absolute top-0 left-0 w-full h-full z-10 touch-none ${isSpacePressed ? 'pointer-events-none' : 'pointer-events-auto'}`}
                  />
                  <canvas ref={modalCanvasRef} className="hidden" />
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-6 pt-6 border-t border-slate-800">
              <div className="flex justify-between items-center w-full">
                <div className="flex items-center bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 shadow-2xl py-1 px-1 rounded-full gap-2">
                  <div className="flex bg-slate-950/50 rounded-full p-1 border border-slate-700/50 relative">
                    <div className={`absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-full transition-all duration-300 ${isEraser ? 'translate-x-[calc(100%+4px)] bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'translate-x-0 bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.5)]'}`}></div>
                    <button onClick={() => setIsEraser(false)} className={`relative z-10 px-6 py-2.5 rounded-full text-[9px] font-black uppercase transition-colors duration-300 ${!isEraser ? 'text-white' : 'text-slate-500 hover:text-white'}`}>CỌ VẼ</button>
                    <button onClick={() => setIsEraser(true)} className={`relative z-10 px-6 py-2.5 rounded-full text-[9px] font-black uppercase transition-colors duration-300 ${isEraser ? 'text-white' : 'text-slate-500 hover:text-white'}`}>CỤC TẨY</button>
                  </div>

                  <div className="w-px h-8 bg-slate-800 mx-2"></div>
                  <div className="flex items-center gap-4 px-4">
                    <span className="text-[10px] font-black text-slate-400 uppercase w-20">Size: {brushSize}px</span>
                    <input type="range" min="5" max="250" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} className="w-48 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all" />
                  </div>
                </div>
                <div className="flex justify-end gap-3 w-full">
                  <button onClick={() => { const dctx = modalDisplayCanvasRef.current!.getContext('2d')!; const mctx = modalCanvasRef.current!.getContext('2d')!; dctx.clearRect(0, 0, 99999, 99999); mctx.clearRect(0, 0, 99999, 99999) }} className="px-6 py-3 text-[10px] font-black text-red-500 border border-red-500/20 rounded-xl hover:bg-red-500/10 transition-colors bg-red-500/5">Xóa Mask</button>
                  <button onClick={() => { setItems(prev => prev.map(it => it.id === editingItem.id ? { ...it, mask: modalCanvasRef.current!.toDataURL() } : it)); setEditingItem(null) }} className="bg-blue-600 px-10 py-3 rounded-xl text-[10px] font-black text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20 transition-all">Lưu Mask</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
