
import React from 'react';
import { Tab } from '../types';
import { Sparkles, Crown, Brain, Microscope, User, Camera } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '../utils';

interface HeaderProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  hasKey: boolean;
  onOpenKey: () => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab, hasKey, onOpenKey }) => {
  return (
    <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 glass-effect border-b border-white/5 backdrop-blur-2xl">
      <div className="flex items-center gap-3 group cursor-pointer">
        <motion.div
          whileHover={{ scale: 1.05, rotate: 5 }}
          whileTap={{ scale: 0.95 }}
          className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-blue-500/20"
        >
          <Sparkles className="w-5 h-5 text-white" />
        </motion.div>
        <div>
          <h1 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-slate-400 tracking-tighter">
            MARIE AI
          </h1>
          <p className="text-[9px] text-blue-400 uppercase tracking-[0.3em] font-black">Pixel-Lock Supreme V5.5</p>
        </div>
      </div>

      <nav className="hidden lg:flex items-center gap-1 bg-slate-900/60 p-1.5 rounded-2xl border border-white/5 shadow-inner">
        {[
          { id: Tab.VIP, icon: Crown, label: 'Marie VIP', color: 'from-amber-400 to-orange-600', shadow: 'shadow-amber-900/40' },
          { id: Tab.CHAT, icon: Brain, label: 'Trợ Lý', color: 'from-blue-500 to-indigo-600', shadow: 'shadow-blue-900/40' },
          { id: Tab.ANALYZE, icon: Microscope, label: 'Phân Tích', color: 'from-blue-500 to-indigo-600', shadow: 'shadow-blue-900/40' },
          { id: Tab.DESIGN, icon: Camera, label: 'Design PSD', color: 'from-violet-500 to-purple-600', shadow: 'shadow-violet-900/40' },
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as Tab)}
              className={cn(
                "relative px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 overflow-hidden",
                isActive ? "text-white" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="active-tab-indicator"
                  className={cn("absolute inset-0 bg-gradient-to-r shadow-xl", tab.color, tab.shadow)}
                  initial={false}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Icon className={cn("w-4 h-4", isActive ? "text-white" : "text-slate-400")} />
                {tab.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-4">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onOpenKey}
          className={cn(
            "text-[10px] font-black px-4 py-2 rounded-full border transition-all uppercase flex items-center gap-2",
            hasKey
              ? "bg-slate-800 text-slate-400 border-white/10"
              : "bg-amber-500 text-white border-amber-400 shadow-lg shadow-amber-500/20 animate-bounce"
          )}
        >
          <Crown className="w-3.5 h-3.5" />
          {hasKey ? 'Key Active' : 'Active Pro Key'}
        </motion.button>
        <motion.div
          whileHover={{ scale: 1.05, backgroundColor: "rgba(255,255,255,0.1)" }}
          whileTap={{ scale: 0.95 }}
          className="w-10 h-10 rounded-2xl bg-slate-800 border border-white/10 flex items-center justify-center shadow-inner cursor-pointer"
        >
          <User className="text-slate-400 w-4 h-4" />
        </motion.div>
      </div>
    </header>
  );
};
