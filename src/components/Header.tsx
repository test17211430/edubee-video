import { FileText, Sparkles } from 'lucide-react';

export function Header() {
  return (
    <header className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 text-white py-6 px-4 shadow-lg">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-white/20 p-2 rounded-xl backdrop-blur-sm">
            <FileText className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              ScriptForge AI
              <Sparkles className="w-5 h-5 text-yellow-300" />
            </h1>
            <p className="text-sm text-white/80">Educational Video Script Generator</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-4 text-sm">
          <span className="bg-white/20 px-3 py-1 rounded-full">Powered by Groq AI</span>
        </div>
      </div>
    </header>
  );
}
