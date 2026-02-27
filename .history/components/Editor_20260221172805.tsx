
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { gemini, optimizeReferenceImage, applyLocalNoise, NoiseProfile, ImageQuality, getNearestGeminiRatio } from '../services/gemini';

export const Editor: React.FC = () => {
  const [image, setImage] = useState<string | null>(null);
  const [refImage, setRefImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [quality, setQuality] = useState<ImageQuality>('4K');
  const [numVariants, setNumVariants] = useState<number>(1);
  const [noiseAmount, setNoiseAmount] = useState<number>(0);
  const [noiseTarget, setNoiseTarget] = useState<'global' | 'mask'>('global');
  const [noiseProfile, setNoiseProfile] = useState<NoiseProfile>('digital');
  
  const [results, setResults] = useState<string[]>([]);
  const [rawResults, setRawResults] = useState<string[]>([]); 
  const [selectedResultIndex, setSelectedResultIndex] = useState<number>(-1);

  // Dynamic Blending States
  const [featherAmount, setFeatherAmount] = useState<number>(15);
  const [blendOpacity, setBlendOpacity] = useState<number>(100);

  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(40);
  const [isEraser, setIsEraser] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [canvasActive, setCanvasActive] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  
  const [isDraggingMain, setIsDraggingMain] = useState(false);
  const [isEyedropperActive, setIsEyedropperActive] = useState(false);
  const [pickedColor, setPickedColor] = useState<string | null>(null);

  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null); 
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);    
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentResult = selectedResultIndex >= 0 ? results[selectedResultIndex] : null;

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
  }, [image, currentResult]);

  const updateBlending = useCallback(async () => {
    if (selectedResultIndex === -1 || !rawResults[selectedResultIndex] || !image) return;

    const rawAiB64 = rawResults[selectedResultIndex];
    const originalImg = new Image(); originalImg.src = image; await new Promise(r => originalImg.onload = r);
    const aiImg = new Image(); aiImg.src = rawAiB64; await new Promise(r => aiImg.onload = r);

    const targetW = originalImg.naturalWidth;
    const targetH = originalImg.naturalHeight;

    const finalCanvas = document.createElement('canvas'); finalCanvas.width = targetW; finalCanvas.height = targetH;
    const fctx = finalCanvas.getContext('2d')!;
    fctx.drawImage(originalImg, 0, 0);

    const maskB64 = (undoStack.length > 0) ? undoStack[undoStack.length - 1] : null;
    const aiLayer = document.createElement('canvas'); aiLayer.width = targetW; aiLayer.height = targetH;
    const actx = aiLayer.getContext('2d')!;
    actx.globalAlpha = blendOpacity / 100;
    
    const aiSize = aiImg.width;
    let rW, rH, oX, oY;
    if (targetW > targetH) { rW = aiSize; rH = (targetH * aiSize) / targetW; oX = 0; oY = (aiSize - rH) / 2; }
    else { rH = aiSize; rW = (targetW * aiSize) / targetH; oY = 0; oX = (aiSize - rW) / 2; }
    actx.drawImage(aiImg, oX, oY, rW, rH, 0, 0, targetW, targetH);

    if (maskB64) {
      const featherMask = document.createElement('canvas'); featherMask.width = targetW; featherMask.height = targetH;
      const fmctx = featherMask.getContext('2d')!;
      fmctx.filter = `blur(${featherAmount}px)`;
      const userMask = new Image(); userMask.src = maskB64; await new Promise(r => userMask.onload = r);
      fmctx.drawImage(userMask, 0, 0, targetW, targetH);
      actx.globalCompositeOperation = 'destination-in';
      actx.drawImage(featherMask, 0, 0);
    }
    fctx.drawImage(aiLayer, 0, 0);

    setResults(prev => {
      const newRes = [...prev];
      newRes[selectedResultIndex] = finalCanvas.toDataURL('image/png');
      return newRes;
    });
  }, [selectedResultIndex, rawResults, image, featherAmount, blendOpacity, undoStack]);

  useEffect(() => {
    if (selectedResultIndex !== -1) updateBlending();
  }, [featherAmount, blendOpacity, selectedResultIndex, updateBlending]);

  const setupCanvas = useCallback(() => {
    if (image && imageRef.current && displayCanvasRef.current && maskCanvasRef.current) {
      const img = imageRef.current;
      maskCanvasRef.current.width = img.naturalWidth;
      maskCanvasRef.current.height = img.naturalHeight;
      displayCanvasRef.current.width = img.clientWidth;
      displayCanvasRef.current.height = img.clientHeight;
      const mctx = maskCanvasRef.current.getContext('2d')!;
      const dctx = displayCanvasRef.current.getContext('2d')!;
      mctx.lineCap='round'; mctx.strokeStyle='#FF0000';
      dctx.lineCap='round'; dctx.strokeStyle='#FF0000';
      if (undoStack.length > 0) {
        const last = new Image(); last.onload = () => {
          mctx.drawImage(last, 0, 0);
          dctx.drawImage(last, 0, 0, displayCanvasRef.current!.width, displayCanvasRef.current!.height);
        }; last.src = undoStack[undoStack.length - 1];
      }
    }
  }, [image, undoStack]);

  useEffect(() => { setupCanvas(); }, [setupCanvas]);

  const saveToUndoStack = useCallback(() => {
    if (maskCanvasRef.current) {
      const state = maskCanvasRef.current.toDataURL();
      setUndoStack(prev => [...prev, state]);
      setRedoStack([]);
    }
  }, []);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const current = maskCanvasRef.current?.toDataURL();
    const newUndo = [...undoStack];
    const stateToRestore = newUndo.pop();
    if (current) setRedoStack(prev => [...prev, current]);
    setUndoStack(newUndo);
    const mctx = maskCanvasRef.current?.getContext('2d');
    const dctx = displayCanvasRef.current?.getContext('2d');
    mctx?.clearRect(0, 0, 99999, 99999);
    dctx?.clearRect(0, 0, 99999, 99999);
    if (stateToRestore) {
      const img = new Image();
      img.onload = () => {
        if (maskCanvasRef.current && displayCanvasRef.current) {
          mctx?.drawImage(img, 0, 0);
          dctx?.drawImage(img, 0, 0, displayCanvasRef.current.width, displayCanvasRef.current.height);
        }
      };
      img.src = stateToRestore;
    }
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const newRedo = [...redoStack];
    const stateToRestore = newRedo.pop()!;
    const current = maskCanvasRef.current?.toDataURL();
    if (current) setUndoStack(prev => [...prev, current]);
    setRedoStack(newRedo);
    const mctx = maskCanvasRef.current?.getContext('2d');
    const dctx = displayCanvasRef.current?.getContext('2d');
    const img = new Image();
    img.onload = () => {
      if (maskCanvasRef.current && displayCanvasRef.current) {
        mctx?.clearRect(0, 0, 99999, 99999);
        dctx?.clearRect(0, 0, 99999, 99999);
        mctx?.drawImage(img, 0, 0);
        dctx?.drawImage(img, 0, 0, displayCanvasRef.current.width, displayCanvasRef.current.height);
      }
    };
    img.src = stateToRestore;
  };

  const pickColor = (e: any) => {
    if (!imageRef.current) return;
    const rect = displayCanvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    const tempCanvas = document.createElement('canvas');
    const img = imageRef.current;
    tempCanvas.width = img.naturalWidth;
    tempCanvas.height = img.naturalHeight;
    const ctx = tempCanvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const px = Math.floor(x * scaleX);
    const py = Math.floor(y * scaleY);
    const pixel = ctx.getImageData(px, py, 1, 1).data;
    const hex = "#" + ("000000" + ((pixel[0] << 16) | (pixel[1] << 8) | pixel[2]).toString(16)).slice(-6);
    setPickedColor(hex.toUpperCase());
    setIsEyedropperActive(false); 
  };

  const handleContainerMouseDown = (e: React.MouseEvent) => {
    if (isEyedropperActive) { pickColor(e); return; }
    if (!canvasActive || currentResult || isSpacePressed) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
    }
  };

  const handleContainerMouseMove = (e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
    if (isPanning) setOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
  };

  const handleContainerMouseUp = () => setIsPanning(false);

  const startDrawing = (e: React.PointerEvent) => {
    if (isEyedropperActive || isSpacePressed || !canvasActive || currentResult) return;
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
    const source = currentResult || image;
    if (!source) return;
    setLoading(true);
    try {
      const maskData = noiseTarget === 'mask' && undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
      const noisedB64 = await applyLocalNoise(source, noiseAmount, maskData, noiseProfile);
      setResults(prev => [noisedB64, ...prev]);
      setRawResults(prev => [noisedB64, ...prev]);
      setSelectedResultIndex(0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const processImage = async (mode: 'edit' | 'upscale') => {
    if (!image) return;
    setLoading(true);
    try {
      const maskData = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
      const ratio = getNearestGeminiRatio(imageRef.current!.naturalWidth, imageRef.current!.naturalHeight);
      const res = await gemini.processImage(
        mode === 'upscale' ? "Quantum Optical Super-Resolution reconstruction." : (prompt || "Precision reconstruction."),
        image, quality, refImage || undefined, `editor_${Date.now()}`,
        false, noiseAmount, maskData, noiseProfile, ratio
      );
      if (res) {
        setRawResults(prev => [res, ...prev]);
        setResults(prev => [res, ...prev]); 
        setSelectedResultIndex(0);
        setCanvasActive(false);
        setFeatherAmount(15);
        setBlendOpacity(100);
      }
    } catch (err: any) {
      alert(`LỖI: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6 animate-fadeIn max-w-[1800px] mx-auto h-full min-h-[calc(100vh-140px)]">
      {canvasActive && isHovering && !currentResult && !loading && !isSpacePressed && (
        <div style={{ position: 'fixed', left: mousePos.x, top: mousePos.y, width: brushSize, height: brushSize, transform: 'translate(-50%, -50%)', border: '2px solid white', backgroundColor: 'rgba(255, 0, 0, 0.4)', pointerEvents: 'none', zIndex: 9999, borderRadius: '50%' }} />
      )}

      <div className="w-full lg:w-96 flex flex-col gap-6 flex-shrink-0">
        <div className="glass-effect p-6 rounded-3xl border border-slate-700 shadow-2xl space-y-6 sticky top-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-blue-400 uppercase tracking-tighter">MARIE PIXEL-LOCK</h3>
            <span className="bg-blue-600/20 text-blue-400 text-[8px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest">V3.5 QUANTUM</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
             <button onClick={() => fileInputRef.current?.click()} className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center gap-1 bg-slate-900/40 border-slate-700 hover:border-blue-500 transition-all">
              {image ? <img src={image} className="w-10 h-10 rounded-lg object-cover" /> : <i className="fa-solid fa-image text-slate-500"></i>}
              <span className="text-[8px] text-slate-500 font-black uppercase">ÁNH GỐC RAW</span>
            </button>
            <button onClick={() => refFileInputRef.current?.click()} className="py-4 border-2 border-dashed rounded-2xl flex flex-col items-center gap-1 bg-slate-900/40 border-slate-700 hover:border-purple-500 transition-all">
              {refImage ? <img src={refImage} className="w-10 h-10 rounded-lg object-cover" /> : <i className="fa-solid fa-palette text-slate-500"></i>}
              <span className="text-[8px] text-slate-500 font-black uppercase">MẪU MÀU</span>
            </button>
          </div>
          <input type="file" ref={fileInputRef} onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = ev => { setImage(ev.target?.result as string); setResults([]); setRawResults([]); setSelectedResultIndex(-1); setUndoStack([]); setRedoStack([]); };
              reader.readAsDataURL(file);
            }
          }} className="hidden" accept="image/*" />
          <input type="file" ref={refFileInputRef} onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = ev => setRefImage(ev.target?.result as string);
              reader.readAsDataURL(file);
            }
          }} className="hidden" accept="image/*" />

          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Yêu cầu sửa..." className="w-full h-24 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-blue-500/30 transition-all shadow-inner" />

          {results.length > 0 && (
             <div className="p-4 bg-slate-950/80 rounded-2xl border border-blue-500/20 space-y-4 animate-slideUp">
                <h4 className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center justify-between">Hòa trộn năng động <i className="fa-solid fa-layer-group"></i></h4>
                 <div className="space-y-2">
                   <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Feathering</span><span className="text-blue-400">{featherAmount}px</span></div>
                   <input type="range" min="0" max="100" value={featherAmount} onChange={(e) => setFeatherAmount(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
                   <p className="text-[7px] text-slate-500 uppercase">Làm mềm đường biên hòa trộn để trông tự nhiên hơn, áp dụng khi mask.</p>
                </div>
                <div className="space-y-2">
                   <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>Opacity</span><span className="text-blue-400">{blendOpacity}%</span></div>
                   <input type="range" min="0" max="100" value={blendOpacity} onChange={(e) => setBlendOpacity(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
                   <p className="text-[7px] text-slate-500 uppercase">Độ trong suốt của kết quả AI đè lên ảnh gốc. Giảm để hòa trộn nhẹ nhàng.</p>
                </div>
             </div>
          )}

          <div className="p-4 bg-slate-900/60 rounded-2xl border border-slate-800 space-y-4">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>NOISE PROFILE</span><span className="text-blue-400 uppercase">{noiseProfile === 'digital' ? 'DIGITAL' : noiseProfile === 'film' ? 'FILM' : 'COARSE'}</span></div>
              <div className="flex gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
                {(['digital', 'film', 'coarse'] as NoiseProfile[]).map(p => (
                  <button key={p} onClick={() => setNoiseProfile(p)} className={`flex-1 py-1.5 rounded-md text-[7px] font-black transition-all ${noiseProfile === p ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500'}`}>
                    {p === 'digital' ? 'SHARP' : p === 'film' ? 'ORGANIC' : 'COARSE'}
                  </button>
                ))}
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase"><span>INTENSITY</span><span className="text-blue-400">{noiseAmount}%</span></div>
                <input type="range" min="0" max="100" value={noiseAmount} onChange={(e) => setNoiseAmount(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-800 rounded-lg accent-blue-500" />
                <p className="text-[7px] text-slate-500 uppercase mt-1">Dùng để tạo độ nhiễu hạt (grain) khớp với ảnh gốc, tránh cảm giác bọc nilon của AI.</p>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[8px] font-black text-slate-500 uppercase">PHẠM VI:</span>
                <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                  <button onClick={() => setNoiseTarget('global')} className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'global' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>TOÀN BỘ</button>
                  <button onClick={() => setNoiseTarget('mask')} className={`flex-1 py-1.5 rounded-md text-[8px] font-black transition-all ${noiseTarget === 'mask' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>VÙNG CHỌN</button>
                </div>
              </div>

              <button onClick={handleApplyLocalGrain} disabled={loading || noiseAmount === 0 || !image} className="w-full py-2.5 bg-slate-800 border border-slate-700 text-blue-400 rounded-xl text-[9px] font-black uppercase hover:bg-slate-700 transition-all disabled:opacity-30">
                CHỈ THÊM NOISE (CỤC BỘ)
              </button>
          </div>

          {image && !currentResult && (
            <div className={`p-4 rounded-2xl border transition-all ${canvasActive ? 'bg-red-500/10 border-red-500/40' : 'bg-slate-800/40 border-slate-700'}`}>
              <div className="flex items-center justify-between mb-3">
                 <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DNA Masking</span>
                 <button onClick={() => setCanvasActive(!canvasActive)} className={`w-10 h-5 rounded-full relative transition-all ${canvasActive ? 'bg-red-500' : 'bg-slate-700'}`}>
                   <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${canvasActive ? 'left-5.5' : 'left-0.5'}`}></div>
                 </button>
              </div>
              {canvasActive && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex gap-2">
                    <button onClick={handleUndo} disabled={undoStack.length === 0} className="flex-1 py-1.5 bg-slate-900 border border-slate-700 rounded text-[8px] font-black uppercase text-slate-400">UNDO</button>
                    <button onClick={handleRedo} disabled={redoStack.length === 0} className="flex-1 py-1.5 bg-slate-900 border border-slate-700 rounded text-[8px] font-black uppercase text-slate-400">REDO</button>
                  </div>
                  <div className="flex justify-between items-center bg-slate-950 p-1 rounded-lg border border-slate-700/50">
                    <button onClick={() => setIsEraser(false)} className={`flex-1 py-1.5 rounded text-[8px] font-black uppercase transition-all ${!isEraser ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}>CỌ VẼ</button>
                    <button onClick={() => setIsEraser(true)} className={`flex-1 py-1.5 rounded text-[8px] font-black uppercase transition-all ${isEraser ? 'bg-red-500 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}>CỤC TẨY</button>
                  </div>
                  <div className="flex justify-between items-center text-[8px] font-black text-slate-500 uppercase"><span>Brush Size</span> <span>{brushSize}px</span></div>
                  <input type="range" min="5" max="250" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-700 rounded-lg accent-red-500" />
                  <p className="text-[7px] text-slate-500 uppercase mt-1">Bấm SPACE + Cuộn chuột để Thu phóng. Dùng cọ vẽ bôi vào vùng muốn AI sửa.</p>
                  <button onClick={() => { setUndoStack([]); setRedoStack([]); setupCanvas(); }} className="w-full py-2 text-[8px] font-black uppercase text-red-500 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-colors">Reset Mask</button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center px-1">
              <span className="text-[9px] font-black text-slate-500 uppercase">VARIANTS</span>
              <div className="flex gap-2">
                {[1, 2, 4].map(n => (
                  <button key={n} onClick={() => setNumVariants(n)} className={`w-6 h-6 rounded flex items-center justify-center text-[9px] font-black border transition-all ${numVariants === n ? 'bg-blue-600 border-blue-400 text-white' : 'border-slate-800 text-slate-500'}`}>{n}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['1K', '2K', '4K', '6K'] as ImageQuality[]).map(q => (
                <button key={q} onClick={() => setQuality(q)} className={`py-2 rounded-xl text-[10px] font-black border transition-all relative ${quality === q ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'border-slate-700 text-slate-500'}`}>
                  {q}
                  {q === '6K' && <span className="absolute -top-2 -right-1 bg-red-500 text-white text-[6px] px-1 rounded-full animate-pulse shadow-lg">ULTRA</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <button disabled={loading || !image} onClick={() => processImage('edit')} className="w-full bg-blue-600 text-white font-black py-4 rounded-2xl text-[10px] uppercase shadow-xl transition-all active:scale-95">
              {loading ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-sparkles mr-2"></i>} XỬ LÝ EDIT
            </button>
            <button disabled={loading || !image} onClick={() => processImage('upscale')} className="w-full bg-slate-900 border border-purple-500/40 text-purple-400 font-black py-4 rounded-2xl text-[10px] uppercase shadow-xl transition-all active:scale-95">
              {loading ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-expand mr-2"></i>} QUANTUM UPSCALE {quality}
            </button>
          </div>

          {results.length > 0 && (
             <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2 pt-2 border-t border-slate-800">
               {results.map((res, idx) => (
                 <button key={idx} onClick={() => setSelectedResultIndex(idx)} className={`flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition-all ${selectedResultIndex === idx ? 'border-blue-500 scale-105' : 'border-slate-800 opacity-40'}`}><img src={res} className="w-full h-full object-cover" /></button>
               ))}
             </div>
          )}
        </div>
      </div>

      <div ref={containerRef} onMouseDown={handleContainerMouseDown} onMouseMove={handleContainerMouseMove} onMouseUp={handleContainerMouseUp} onMouseEnter={()=>setIsHovering(true)} onMouseLeave={()=>setIsHovering(false)} className={`flex-1 glass-effect rounded-[3rem] relative overflow-hidden flex flex-col items-center justify-center border border-slate-700 bg-slate-950/40 min-h-[700px] shadow-inner ${canvasActive && !currentResult ? 'cursor-none' : 'cursor-default'}`}>
         {image ? (
           <div style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`, transition: isPanning||isDrawing ? 'none' : 'transform 0.15s' }} className="relative inline-block rounded-2xl overflow-hidden bg-black shadow-[0_50px_100px_rgba(0,0,0,0.8)]">
              <img ref={imageRef} src={showOriginal ? image : (currentResult ? currentResult : image)} className="max-h-[85vh] w-auto block select-none pointer-events-none" />
              <canvas ref={displayCanvasRef} onPointerDown={startDrawing} onPointerMove={draw} onPointerUp={stopDrawing} className={`absolute inset-0 z-10 w-full h-full touch-none ${canvasActive && !currentResult ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} />
              <canvas ref={maskCanvasRef} className="hidden" />
           </div>
         ) : (
           <div className="opacity-20 flex flex-col items-center gap-4 animate-pulse"><i className="fa-solid fa-cube text-8xl"></i><p className="text-[12px] font-black uppercase tracking-widest">MARIE PIXEL DNA ENGINE</p></div>
         )}

         {image && (
           <div className="absolute top-10 right-10 flex flex-col gap-3 z-30">
              <button onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} className="px-6 py-4 bg-black/80 backdrop-blur-xl text-amber-500 rounded-2xl text-[10px] font-black uppercase border border-amber-500/30 shadow-2xl transition-all">So sánh gốc</button>
              {currentResult && (
                <a href={currentResult} download={`MARIE_PRO_${Date.now()}.png`} className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-xl hover:bg-blue-500"><i className="fa-solid fa-download"></i></a>
              )}
           </div>
         )}

         {loading && <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95 backdrop-blur-3xl animate-fadeIn"><div className="w-16 h-16 border-t-2 border-blue-500 rounded-full animate-spin"></div></div>}
      </div>
    </div>
  );
};
