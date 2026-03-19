
import React, { useState, useRef } from 'react';
import { gemini } from '../services/gemini';

export const Analyze: React.FC = () => {
  const [image, setImage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setImage(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const analyzeImage = async () => {
    if (!image) return;
    setLoading(true);
    try {
      const b64Data = image.split(',')[1];
      const result = await gemini.analyzeImage(b64Data);
      setAnalysis(result || 'Không thể phân tích ảnh.');
    } catch (error) {
      console.error(error);
      alert('Lỗi khi phân tích ảnh.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 animate-fadeIn grid grid-cols-1 md:grid-cols-2 gap-8">
      <div className="space-y-6">
        <div className="glass-effect p-6 rounded-3xl border-slate-700">
           <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
             <i className="fa-solid fa-camera text-purple-400"></i>
             Tải Ảnh Cần Phân Tích
           </h3>
           <button 
            onClick={() => fileInputRef.current?.click()}
            className="w-full aspect-video border-2 border-dashed border-slate-700 rounded-2xl flex flex-col items-center justify-center gap-3 hover:border-purple-500 hover:bg-purple-500/5 transition-all group overflow-hidden"
          >
            {image ? (
              <img src={image} className="h-full w-full object-contain" />
            ) : (
              <>
                <i className="fa-solid fa-images text-4xl text-slate-600 group-hover:text-purple-500"></i>
                <span className="text-sm text-slate-500">Kéo thả hoặc nhấn để chọn ảnh</span>
              </>
            )}
          </button>
          <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" accept="image/*" />
          
          <button
            disabled={loading || !image}
            onClick={analyzeImage}
            className="w-full mt-6 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl shadow-lg shadow-purple-500/20 transition-all flex items-center justify-center gap-2"
          >
            {loading ? <i className="fa-solid fa-circle-notch animate-spin"></i> : <i className="fa-solid fa-microchip"></i>}
            Phân Tích Thông Minh
          </button>
        </div>

        <div className="glass-effect p-6 rounded-3xl border-slate-700 opacity-60">
          <h4 className="font-semibold text-slate-300 mb-2">Gợi ý phân tích:</h4>
          <ul className="text-xs text-slate-400 space-y-2">
            <li>• Tìm lỗi bố cục trong thiết kế</li>
            <li>• Nhận diện bảng màu (Color Palette)</li>
            <li>• Trích xuất văn bản từ hình ảnh</li>
            <li>• Phân tích phong cách nghệ thuật</li>
          </ul>
        </div>
      </div>

      <div className="glass-effect p-8 rounded-3xl border-slate-700 min-h-[500px] flex flex-col">
        <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
          <i className="fa-solid fa-clipboard-list text-blue-400"></i>
          Kết Quả Phân Tích
        </h3>
        
        {!analysis && !loading && (
          <div className="flex-1 flex flex-col items-center justify-center opacity-30">
            <i className="fa-solid fa-magnifying-glass text-6xl mb-4"></i>
            <p>Kết quả sẽ hiển thị tại đây</p>
          </div>
        )}

        {loading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-purple-400 font-medium">Gemini đang quan sát...</p>
          </div>
        )}

        {analysis && !loading && (
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-4">
            <div className="prose prose-invert max-w-none text-slate-200 leading-relaxed whitespace-pre-wrap">
              {analysis}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
