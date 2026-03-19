
import React, { useState, useEffect } from 'react';
import { Tab } from './types';
import { Header } from './components/Header';
import { MariePaint } from './components/MariePaint';
import { Chat } from './components/Chat';
import { Analyze } from './components/Analyze';
import { DesignExtractor } from './components/DesignExtractor';
import { BulkGenerator } from './components/BulkGenerator';
import { checkApiKey, openKeySelector } from './services/gemini';
import { Toaster } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>(Tab.VIP);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    const verifyKey = async () => {
      const exists = await checkApiKey();
      setHasKey(exists);
    };
    verifyKey();
  }, []);

  const handleOpenKey = async () => {
    await openKeySelector();
    const exists = await checkApiKey();
    setHasKey(exists);
  };

  const renderTab = () => {
    switch (activeTab) {
      case Tab.VIP: return <MariePaint key="vip" title="MARIE VIP" />;
      case Tab.BULK: return <BulkGenerator key="bulk" />;
      case Tab.CHAT: return <Chat key="chat" />;
      case Tab.ANALYZE: return <Analyze key="analyze" />;
      case Tab.DESIGN: return <DesignExtractor key="design" />;
      default: return <MariePaint key="vip-default" title="MARIE VIP" />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0f1a]">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        hasKey={hasKey}
        onOpenKey={handleOpenKey}
      />

      <main className="flex-1 overflow-y-auto custom-scrollbar relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="w-full h-full"
          >
            {renderTab()}
          </motion.div>
        </AnimatePresence>
      </main>

      <Toaster theme="dark" position="bottom-right" richColors toastOptions={{
        className: 'glass-effect border-slate-700 !bg-slate-900/80 !text-slate-200'
      }} />

      <footer className="py-6 px-10 glass-effect border-t border-slate-800/50 flex flex-col md:flex-row justify-between items-center gap-6 text-[9px] text-slate-500 uppercase tracking-[0.2em] font-black">
        <div className="flex items-center gap-3">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
          </span>
          MARIE V5.5 Triple-Engine Operational
        </div>
        <div className="flex items-center gap-8">
          <span className="hover:text-blue-400 cursor-pointer transition-colors">Pixel-Lock Supreme</span>
          <span className="hover:text-amber-400 cursor-pointer transition-colors">VIP-V2-V3 Active</span>
          <span className="text-slate-600">© 2025 MARIE AI STUDIO</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
