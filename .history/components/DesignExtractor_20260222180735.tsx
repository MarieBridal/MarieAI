
import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
    Camera, Download, Loader2, Layers, Type, ImagePlus, Trash2,
    Scan, Wand2, FileImage, ChevronRight, X
} from 'lucide-react';
import { gemini } from '../services/gemini';
import { createMultiLayerPsdBlob, PsdLayerParams } from '../services/psdExport';

// ─── Types ───────────────────────────────────────────────────────────────────
interface DesignZone {
    id: string;
    type: 'photo' | 'text';
    x: number;   // 0–1 relative to image
    y: number;
    w: number;
    h: number;
    label: string;
    content?: string; // for text zones
    fontSize?: number;
    hexColor?: string;
    fontFamily?: string;
    replacementImage?: string; // user-dropped photo for this zone
}

interface ExtractedLayout {
    zones: DesignZone[];
    rawJson: string;
}

// ─── Gemini Helper ───────────────────────────────────────────────────────────
async function analyzeDesignLayout(imageB64: string): Promise<DesignZone[]> {
    const ai = (gemini as any).getClient
        ? (gemini as any)
        : null;

    const prompt = `You are a professional UI/UX design analyst.
Look at this design template carefully.
Identify ALL distinct zones:
1. PHOTO zones – areas that contain a main photo/image that a user would want to swap out (background image, portrait photos, inset boxes, collage frames, etc.).
2. TEXT zones – any text element (headlines, subtitles, taglines, watermarks, logos that contain letters).

For EACH zone output a JSON object with these exact keys:
- "id": short unique slug e.g. "bg_photo", "headline", "sub_portrait_1"
- "type": "photo" or "text"
- "x": left edge position 0.0 to 1.0 (fraction of total image width)
- "y": top edge position 0.0 to 1.0 (fraction of total image height)
- "w": width as fraction 0.0 to 1.0
- "h": height as fraction 0.0 to 1.0
- "label": short human-readable name for this zone in Vietnamese, e.g. "Ảnh Nền Chính", "Tiêu Đề", "Ảnh Phụ Trái"
- "content": (only for text types) the EXACT text string visible
- "fontSize": (only for text types) approximate font size relative to image height 0.01 to 0.2
- "hexColor": (only for text types) dominant hex color of the text e.g. "#C9A84C"
- "fontFamily": (only for text types) approximate CSS font family e.g. "serif", "sans-serif"

Return ONLY a valid JSON array. No markdown, no extra commentary.
Example: [{"id":"bg_photo","type":"photo","x":0,"y":0,"w":1,"h":0.55,"label":"Ảnh Nền Chính"},{"id":"headline","type":"text","x":0.1,"y":0.6,"w":0.8,"h":0.08,"label":"Tiêu Đề","content":"HAUTE Couture Vibe","fontSize":0.07,"hexColor":"#C9A84C","fontFamily":"serif"}]`;

    const cleanB64 = imageB64.startsWith('data:')
        ? imageB64.split(',')[1]
        : imageB64;

    const res = await (gemini as any).withRetry
        ? await (gemini as any).withRetry(() =>
            (gemini as any).getClient().models.generateContent({
                model: 'gemini-3-pro-preview',
                contents: { parts: [{ inlineData: { data: cleanB64, mimeType: 'image/jpeg' } }, { text: prompt }] },
                config: { temperature: 0.1 }
            })
        )
        : await (gemini as any).analyzeImage(imageB64, prompt);

    const txt = typeof res === 'string' ? res : (typeof res?.text === 'function' ? res.text() : res?.text || '[]');
    const match = String(txt).match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI không trả về JSON hợp lệ. Thử lại nhé!');
    return JSON.parse(match[0]) as DesignZone[];
}

// ─── Helper: render a placeholder canvas ─────────────────────────────────────
function createPlaceholderCanvas(w: number, h: number, label: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;

    // Background
    ctx.fillStyle = '#1a233a';
    ctx.fillRect(0, 0, w, h);

    // Dashed border
    ctx.setLineDash([12, 8]);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, w - 8, h - 8);

    // Camera icon (SVG-drawn manually)
    const cx = w / 2;
    const cy = h / 2 - h * 0.05;
    const iconSize = Math.min(w, h) * 0.18;

    ctx.fillStyle = '#3b82f6';
    // Body of camera
    ctx.beginPath();
    ctx.roundRect(cx - iconSize, cy - iconSize * 0.6, iconSize * 2, iconSize * 1.2, iconSize * 0.15);
    ctx.fill();

    // Lens
    ctx.fillStyle = '#1a233a';
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize * 0.38, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Viewfinder bump
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.roundRect(cx - iconSize * 0.35, cy - iconSize * 0.9, iconSize * 0.7, iconSize * 0.35, 4);
    ctx.fill();

    // Label
    const fs = Math.max(11, Math.min(w * 0.06, 20));
    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + iconSize * 1.05);

    return c;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/jpeg', 0.7);
}

// ─── Main Component ─────────────────────────────────────────────────────────
export const DesignExtractor: React.FC = () => {
    const [templateB64, setTemplateB64] = useState<string | null>(null);
    const [templateDims, setTemplateDims] = useState({ w: 1, h: 1 });
    const [zones, setZones] = useState<DesignZone[]>([]);
    const [loading, setLoading] = useState(false);
    const [activeZone, setActiveZone] = useState<string | null>(null);
    const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
    const fileRef = useRef<HTMLInputElement>(null);
    const zonePhotoRef = useRef<HTMLInputElement>(null);

    // Load template image
    const handleFileSelect = useCallback((file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const b64 = e.target?.result as string;
            const img = new Image();
            img.onload = () => {
                setTemplateDims({ w: img.width, h: img.height });
                setTemplateB64(b64);
                setZones([]);
                setStep('upload');
            };
            img.src = b64;
        };
        reader.readAsDataURL(file);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith('image/')) handleFileSelect(file);
    }, [handleFileSelect]);

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFileSelect(file);
    };

    // AI scan
    const handleScan = async () => {
        if (!templateB64) return;
        setLoading(true);
        try {
            toast.info('AI đang đọc vỡ cấu trúc design...');
            const extracted = await analyzeDesignLayout(templateB64);
            setZones(extracted);
            setStep('preview');
            toast.success(`Tìm thấy ${extracted.length} vùng! Bạn có thể thay ảnh hoặc xuất PSD ngay.`);
        } catch (err: any) {
            toast.error(`Lỗi phân tích: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    // Replace photo in a zone
    const handleZonePhotoReplace = (zoneId: string) => {
        setActiveZone(zoneId);
        zonePhotoRef.current?.click();
    };

    const handleZonePhotoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeZone) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const b64 = ev.target?.result as string;
            setZones(prev => prev.map(z => z.id === activeZone ? { ...z, replacementImage: b64 } : z));
            toast.success('Đã thay ảnh vào vùng!');
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    // Export PSD
    const handleExportPSD = async () => {
        if (!templateB64 || zones.length === 0) return;
        setLoading(true);
        try {
            const layers: PsdLayerParams[] = [];

            // Layer 1: original template as base reference
            layers.push({ name: 'Template Gốc (Reference)', base64: templateB64 });

            // Build layers per zone (bottom → top)
            const photoZones = zones.filter(z => z.type === 'photo');
            const textZones = zones.filter(z => z.type === 'text');

            for (const zone of photoZones) {
                const zW = Math.round(zone.w * templateDims.w);
                const zH = Math.round(zone.h * templateDims.h);
                if (zone.replacementImage) {
                    // User supplied a real photo — use it
                    layers.push({ name: zone.label, base64: zone.replacementImage });
                } else {
                    // Generate a placeholder canvas
                    const canvas = createPlaceholderCanvas(Math.max(zW, 100), Math.max(zH, 100), zone.label);
                    layers.push({ name: zone.label, base64: canvasToDataUrl(canvas) });
                }
            }

            for (const zone of textZones) {
                // Text nodes are embedded via the psdExport text system
                layers.push({
                    name: zone.label,
                    base64: templateB64, // use tiny transparent proxy — text node carries the real data
                });
            }

            // Build detectedTexts for embedded text layers
            const detectedTexts = textZones.map(z => ({
                id: z.id,
                text: z.content || '',
                x: z.x + z.w / 2,
                y: z.y + z.h / 2,
                fontSize: z.fontSize || 0.05,
                hexColor: z.hexColor || '#FFFFFF',
                fontFamily: z.fontFamily || 'sans-serif'
            }));

            const blob = await createMultiLayerPsdBlob(layers, detectedTexts);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `MARIE_DESIGN_${Date.now()}.psd`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast.success('Xuất PSD thành công! Mở bằng Photoshop để chỉnh sửa.');
            setStep('done');
        } catch (err: any) {
            toast.error(`Lỗi xuất PSD: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const photoZones = zones.filter(z => z.type === 'photo');
    const textZones = zones.filter(z => z.type === 'text');

    // ─── Render ─────────────────────────────────────────────────────────────
    return (
        <div className="min-h-[calc(100vh-12rem)] flex flex-col lg:flex-row gap-6 p-6 max-w-[1600px] mx-auto" style={{ paddingBottom: '2rem' }}>

            {/* Hidden file inputs */}
            <input ref={fileRef} type="file" accept="image/*" onChange={handleFileInput} className="hidden" />
            <input ref={zonePhotoRef} type="file" accept="image/*" onChange={handleZonePhotoFile} className="hidden" />

            {/* ─── Left Panel ──────────────────────────────────────────────── */}
            <div className="w-full lg:w-[320px] flex-shrink-0 flex flex-col gap-4">

                {/* Header */}
                <div className="p-5 rounded-2xl bg-gradient-to-br from-violet-900/40 to-indigo-900/30 border border-violet-500/20">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center shadow-lg">
                            <Scan className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-sm font-black text-white uppercase tracking-wider">Design Extractor</h2>
                            <p className="text-[10px] text-violet-300 uppercase">AI Template Decoder</p>
                        </div>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">Kéo thả ảnh mẫu design vào đây. AI sẽ tự động phân tích và bóc toàn bộ cấu trúc ra thành file <span className="text-violet-300 font-bold">PSD có thể thay ảnh &amp; chữ</span>.</p>
                </div>

                {/* Upload zone */}
                <div
                    onDrop={handleDrop}
                    onDragOver={e => e.preventDefault()}
                    onClick={() => fileRef.current?.click()}
                    className="relative flex flex-col items-center justify-center gap-3 p-8 rounded-2xl border-2 border-dashed border-violet-500/30 bg-slate-900/40 hover:border-violet-400/60 hover:bg-violet-950/20 transition-all cursor-pointer group"
                    style={{ minHeight: 160 }}
                >
                    {templateB64 ? (
                        <>
                            <img src={templateB64} className="w-full rounded-xl object-contain max-h-48" alt="Template" />
                            <span className="text-[10px] text-violet-300 font-bold uppercase">Click để thay ảnh mẫu khác</span>
                        </>
                    ) : (
                        <>
                            <div className="w-14 h-14 rounded-2xl bg-violet-900/50 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <ImagePlus className="w-7 h-7 text-violet-400" />
                            </div>
                            <div className="text-center">
                                <p className="text-sm font-black text-slate-300">Kéo thả ảnh mẫu</p>
                                <p className="text-[10px] text-slate-500 mt-1">JPG / PNG / WEBP</p>
                            </div>
                        </>
                    )}
                </div>

                {/* Scan button */}
                <button
                    onClick={handleScan}
                    disabled={!templateB64 || loading}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-black text-sm uppercase shadow-xl hover:from-violet-500 hover:to-indigo-500 transition-all active:scale-95 disabled:opacity-40 flex items-center justify-center gap-2"
                >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                    {loading ? 'AI Đang Phân Tích...' : 'Bắt Đầu Phân Tích AI'}
                </button>

                {/* Zones summary */}
                {zones.length > 0 && (
                    <AnimatePresence>
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="space-y-3"
                        >
                            {/* Photo zones */}
                            {photoZones.length > 0 && (
                                <div className="p-4 rounded-2xl bg-slate-900/60 border border-blue-500/20 space-y-2">
                                    <h3 className="text-[10px] font-black text-blue-400 uppercase flex items-center gap-2">
                                        <Camera className="w-3.5 h-3.5" /> Vùng Ảnh ({photoZones.length})
                                    </h3>
                                    {photoZones.map(z => (
                                        <div key={z.id} className="flex items-center gap-2">
                                            <div
                                                className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 overflow-hidden flex-shrink-0 cursor-pointer hover:border-blue-500 transition-all"
                                                onClick={() => handleZonePhotoReplace(z.id)}
                                                title="Click để thay ảnh"
                                            >
                                                {z.replacementImage
                                                    ? <img src={z.replacementImage} className="w-full h-full object-cover" />
                                                    : <div className="w-full h-full flex items-center justify-center"><Camera className="w-4 h-4 text-slate-500" /></div>
                                                }
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-bold text-slate-300 truncate">{z.label}</p>
                                                <p className="text-[9px] text-slate-500">{z.replacementImage ? '✅ Đã thay ảnh' : 'Click icon để thay ảnh'}</p>
                                            </div>
                                            {z.replacementImage && (
                                                <button onClick={() => setZones(prev => prev.map(pz => pz.id === z.id ? { ...pz, replacementImage: undefined } : pz))} className="text-slate-600 hover:text-red-400 transition-colors">
                                                    <X className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Text zones */}
                            {textZones.length > 0 && (
                                <div className="p-4 rounded-2xl bg-slate-900/60 border border-amber-500/20 space-y-2">
                                    <h3 className="text-[10px] font-black text-amber-400 uppercase flex items-center gap-2">
                                        <Type className="w-3.5 h-3.5" /> Vùng Chữ ({textZones.length})
                                    </h3>
                                    {textZones.map(z => (
                                        <div key={z.id} className="flex items-start gap-2">
                                            <div className="w-4 h-4 mt-0.5 flex-shrink-0">
                                                <div className="w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: z.hexColor || '#fff' }} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-bold text-slate-300 truncate">{z.label}</p>
                                                <p className="text-[9px] text-amber-300/80 truncate italic">{z.content}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Export PSD */}
                            <button
                                onClick={handleExportPSD}
                                disabled={loading}
                                className="w-full py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-cyan-600 text-white font-black text-sm uppercase shadow-xl hover:from-blue-500 hover:to-cyan-500 transition-all active:scale-95 disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                Xuất File PSD ({zones.length} Layers)
                            </button>
                        </motion.div>
                    </AnimatePresence>
                )}
            </div>

            {/* ─── Right Panel: Design Preview with Zone Overlays ─────────────── */}
            <div className="flex-1 flex flex-col gap-4">
                <div className="text-[10px] font-black text-slate-500 uppercase flex items-center gap-2">
                    <FileImage className="w-4 h-4" /> Bản Xem Trước Phân Tích
                    {step === 'preview' && <span className="text-violet-400 ml-auto animate-pulse">● LIVE PREVIEW</span>}
                </div>

                <div
                    className="flex-1 rounded-3xl bg-slate-950 border border-slate-800 overflow-hidden relative flex items-center justify-center"
                    style={{ minHeight: 500 }}
                >
                    {!templateB64 ? (
                        <div className="flex flex-col items-center gap-4 text-slate-600">
                            <Layers className="w-16 h-16" />
                            <p className="text-sm font-black uppercase">Tải ảnh design mẫu lên để bắt đầu</p>
                            <p className="text-[11px]">AI sẽ tự identify: ảnh nền, ảnh phụ, tiêu đề, tagline, logo...</p>
                        </div>
                    ) : (
                        <div className="relative w-full h-full flex items-center justify-center p-4">
                            <div className="relative inline-block max-w-full max-h-full" style={{ aspectRatio: `${templateDims.w}/${templateDims.h}`, maxHeight: 'calc(100vh - 280px)' }}>
                                <img
                                    src={templateB64}
                                    className="w-full h-full object-contain rounded-2xl shadow-2xl"
                                    alt="Design template"
                                />

                                {/* Zone overlays */}
                                {zones.map(z => {
                                    const zoneColor = z.type === 'photo' ? 'rgba(59,130,246,0.3)' : 'rgba(251,191,36,0.2)';
                                    const borderColor = z.type === 'photo' ? '#3b82f6' : '#f59e0b';
                                    return (
                                        <motion.div
                                            key={z.id}
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            transition={{ delay: 0.05 }}
                                            onClick={() => z.type === 'photo' && handleZonePhotoReplace(z.id)}
                                            style={{
                                                position: 'absolute',
                                                left: `${z.x * 100}%`,
                                                top: `${z.y * 100}%`,
                                                width: `${z.w * 100}%`,
                                                height: `${z.h * 100}%`,
                                                background: zoneColor,
                                                border: `2px solid ${borderColor}`,
                                                borderRadius: 6,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexDirection: 'column',
                                                cursor: z.type === 'photo' ? 'pointer' : 'default',
                                                backdropFilter: z.replacementImage ? 'none' : 'blur(0px)',
                                                overflow: 'hidden',
                                            }}
                                            title={z.label}
                                        >
                                            {z.type === 'photo' && z.replacementImage ? (
                                                <img src={z.replacementImage} className="w-full h-full object-cover" alt={z.label} />
                                            ) : z.type === 'photo' ? (
                                                <>
                                                    <Camera className="w-5 h-5 text-blue-300 drop-shadow mb-1" />
                                                    <span className="text-[8px] font-black text-white/80 bg-blue-900/60 px-2 py-0.5 rounded-full text-center leading-tight">{z.label}</span>
                                                </>
                                            ) : (
                                                <span
                                                    className="font-black text-center px-1 pointer-events-none select-none drop-shadow-md"
                                                    style={{
                                                        color: z.hexColor || '#fff',
                                                        fontSize: `clamp(8px, ${z.fontSize ? z.fontSize * 100 : 3}cqmin, 32px)`,
                                                        fontFamily: z.fontFamily || 'serif',
                                                        textShadow: '0 1px 6px rgba(0,0,0,0.8)',
                                                    }}
                                                >
                                                    {z.content}
                                                </span>
                                            )}
                                        </motion.div>
                                    );
                                })}

                                {/* Scanning overlay */}
                                {loading && (
                                    <motion.div
                                        className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl"
                                        style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                    >
                                        <Loader2 className="w-10 h-10 text-violet-400 animate-spin" />
                                        <p className="text-sm font-black text-white uppercase tracking-widest">AI Đang Quét...</p>
                                        <p className="text-[11px] text-violet-300">Phân tích bố cục và xác định vùng ảnh/chữ</p>
                                    </motion.div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Legend */}
                {zones.length > 0 && (
                    <div className="flex gap-6 text-[10px] font-black text-slate-500 uppercase">
                        <span className="flex items-center gap-2"><span className="w-3 h-3 rounded border-2 border-blue-500 bg-blue-500/20 inline-block" /> Vùng Ảnh — Click để Thay</span>
                        <span className="flex items-center gap-2"><span className="w-3 h-3 rounded border-2 border-amber-500 bg-amber-500/10 inline-block" /> Vùng Chữ — Sẽ thành Text Layer trong PSD</span>
                    </div>
                )}
            </div>
        </div>
    );
};
