import React from "react";
import { Check, X } from "lucide-react";

export function PerformanceSection() {
  return (
    <section className="w-full bg-[#FDFCF9] py-24 border-y border-gray-100">
      <div className="max-w-5xl mx-auto px-6 md:px-12">
        {/* Header */}
        <div className="mb-12">
          <p className="text-[#7c3aed] text-xs font-bold tracking-[0.15em] uppercase mb-4">
            Why Tallei
          </p>
          <h2 className="text-5xl md:text-[4.5rem] font-serif text-[#1c1917] mb-6 leading-[1.05] tracking-tight">
            Fast. Invisible.<br />
            <span className="italic font-light text-[#4c4643]">Just works.</span>
          </h2>
          <p className="text-[#4c4643] text-lg max-w-2xl font-medium">
            No dashboards. No config. Tallei runs quietly in the background.
          </p>
        </div>

        {/* 3 Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-gray-200 bg-white mb-16 shadow-sm rounded-sm">
          {/* Card 1 */}
          <div className="p-8 border-b md:border-b-0 md:border-r border-gray-200">
            <h3 className="text-[2.75rem] font-serif text-[#1c1917] mb-3 leading-none tracking-tight">&lt;300ms</h3>
            <p className="font-bold text-sm text-[#1c1917] mb-2">Blazingly fast</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              No spinner. No wait. Memory that feels like nothing.
            </p>
          </div>

          {/* Card 2 */}
          <div className="p-8 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col justify-between">
            <div>
              <h3 className="text-[2.75rem] font-serif text-[#1c1917] mb-3 leading-none tracking-tight">Any AI</h3>
              <p className="font-bold text-sm text-[#1c1917] mb-2">Your tools, your choice</p>
              <p className="text-sm text-gray-500 leading-relaxed mb-6">
                All in sync. Always.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <img src="/chatgpt.svg" alt="ChatGPT" className="w-5 h-5 opacity-80" />
              <span className="text-gray-300 font-bold text-sm">+</span>
              <img src="/claude.svg" alt="Claude" className="w-5 h-5 opacity-80" />
              <span className="text-gray-300 font-bold text-sm">+</span>
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-blue-400 fill-current opacity-90"><path d="M12 0L15.5 8.5L24 12L15.5 15.5L12 24L8.5 15.5L0 12L8.5 8.5L12 0Z"/></svg>
              <span className="text-xs text-gray-400 ml-1 font-medium">+ more</span>
            </div>
          </div>

          {/* Card 3 */}
          <div className="p-8 flex flex-col justify-between">
            <div>
              <h3 className="text-[2.75rem] font-serif text-[#1c1917] mb-3 leading-none tracking-tight">Zero</h3>
              <p className="font-bold text-sm text-[#1c1917] mb-2">Zero setup</p>
              <p className="text-sm text-gray-500 leading-relaxed mb-6">
                Minutes to connect. Nothing to maintain.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <img src="/chatgpt.svg" alt="ChatGPT" className="w-5 h-5 opacity-80" />
              <span className="text-gray-300 font-bold text-sm">+</span>
              <img src="/claude.svg" alt="Claude" className="w-5 h-5 opacity-80" />
              <span className="text-gray-300 font-bold text-sm">+</span>
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-blue-400 fill-current opacity-90"><path d="M12 0L15.5 8.5L24 12L15.5 15.5L12 24L8.5 15.5L0 12L8.5 8.5L12 0Z"/></svg>
            </div>
          </div>
        </div>

        {/* Comparison Table */}
        <div className="grid grid-cols-1 md:grid-cols-2 border border-gray-200 overflow-hidden shadow-sm rounded-sm">
          
          {/* Column 1: Without Tallei */}
          <div className="bg-[#f4f4f5] border-b md:border-b-0 md:border-r border-gray-200">
            <div className="p-7 border-b border-gray-200">
              <h4 className="font-bold text-[#1c1917] mb-1.5 text-sm">Without Tallei</h4>
              <p className="text-[10px] font-bold text-gray-400 tracking-widest uppercase mb-4">The Status Quo</p>
              <div className="flex items-center gap-2">
                <img src="/chatgpt.svg" alt="ChatGPT" className="w-4 h-4 opacity-40 grayscale" />
                <span className="text-gray-300 font-bold text-xs">+</span>
                <img src="/claude.svg" alt="Claude" className="w-4 h-4 opacity-40 grayscale" />
                <span className="text-gray-300 font-bold text-xs">+</span>
                <svg viewBox="0 0 24 24" className="w-3 h-3 text-gray-400 fill-current opacity-40"><path d="M12 0L15.5 8.5L24 12L15.5 15.5L12 24L8.5 15.5L0 12L8.5 8.5L12 0Z"/></svg>
                <span className="text-[11px] text-gray-400 ml-1.5 font-medium">— each isolated</span>
              </div>
            </div>
            <ul className="flex flex-col">
              <li className="px-7 py-5 border-b border-gray-200/60 flex items-start gap-3 text-[13px] text-gray-500 font-medium">
                <X size={16} className="text-gray-400 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Start over every session</span>
              </li>
              <li className="px-7 py-5 border-b border-gray-200/60 flex items-start gap-3 text-[13px] text-gray-500 font-medium">
                <X size={16} className="text-gray-400 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Decisions disappear at end of session</span>
              </li>
              <li className="px-7 py-5 border-b border-gray-200/60 flex items-start gap-3 text-[13px] text-gray-500 font-medium">
                <X size={16} className="text-gray-400 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Re-explain yourself every time</span>
              </li>
              <li className="px-7 py-5 border-b border-gray-200/60 flex items-start gap-3 text-[13px] text-gray-500 font-medium">
                <X size={16} className="text-gray-400 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Days of engineering to connect tools</span>
              </li>
              <li className="px-7 py-5 flex items-start gap-3 text-[13px] text-gray-500 font-medium">
                <X size={16} className="text-gray-400 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Files trapped in one tool</span>
              </li>
            </ul>
          </div>
          
          {/* Column 2: With Tallei */}
          <div className="bg-[#eff4ff]">
            <div className="p-7 border-b border-indigo-100">
              <h4 className="font-bold text-[#5b21b6] mb-1.5 text-sm">With Tallei</h4>
              <p className="text-[10px] font-bold text-indigo-400 tracking-widest uppercase mb-4">How it should work</p>
              <div className="flex items-center gap-2">
                <img src="/chatgpt.svg" alt="ChatGPT" className="w-4 h-4 opacity-90" />
                <span className="text-indigo-300 font-bold text-xs">+</span>
                <img src="/claude.svg" alt="Claude" className="w-4 h-4 opacity-90" />
                <span className="text-indigo-300 font-bold text-xs">+</span>
                <svg viewBox="0 0 24 24" className="w-3 h-3 text-blue-500 fill-current opacity-90"><path d="M12 0L15.5 8.5L24 12L15.5 15.5L12 24L8.5 15.5L0 12L8.5 8.5L12 0Z"/></svg>
                <span className="text-[11px] text-indigo-400 ml-1.5 font-medium">— all in sync</span>
              </div>
            </div>
            <ul className="flex flex-col">
              <li className="px-7 py-4 border-b border-indigo-100 flex flex-col gap-1.5">
                <div className="flex items-start gap-3 text-[13px] text-[#1c1917] font-medium">
                  <Check size={16} className="text-indigo-600 shrink-0 mt-0.5 stroke-[2.5]" /> 
                  <span>Context follows you — tool to tool</span>
                </div>
                <div className="flex items-center gap-2 ml-7 mt-0.5">
                  <img src="/chatgpt.svg" alt="ChatGPT" className="w-3.5 h-3.5 opacity-60 grayscale" />
                  <img src="/claude.svg" alt="Claude" className="w-3.5 h-3.5 opacity-60 grayscale" />
                  <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 text-blue-500 fill-current opacity-60 grayscale"><path d="M12 0L15.5 8.5L24 12L15.5 15.5L12 24L8.5 15.5L0 12L8.5 8.5L12 0Z"/></svg>
                </div>
              </li>
              <li className="px-7 py-5 border-b border-indigo-100 flex items-start gap-3 text-[13px] text-[#1c1917] font-medium">
                <Check size={16} className="text-indigo-600 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Everything remembered, every time</span>
              </li>
              <li className="px-7 py-5 border-b border-indigo-100 flex items-start gap-3 text-[13px] text-[#1c1917] font-medium">
                <Check size={16} className="text-indigo-600 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Your profile travels with you</span>
              </li>
              <li className="px-7 py-5 border-b border-indigo-100 flex items-start gap-3 text-[13px] text-[#1c1917] font-medium">
                <Check size={16} className="text-indigo-600 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Live in minutes. No engineering.</span>
              </li>
              <li className="px-7 py-5 flex items-start gap-3 text-[13px] text-[#1c1917] font-medium">
                <Check size={16} className="text-indigo-600 shrink-0 mt-0.5 stroke-[2.5]" /> 
                <span>Surfaces everywhere, automatically</span>
              </li>
            </ul>
          </div>
          
        </div>
      </div>
    </section>
  );
}
