import { useState } from 'react';
import { Header } from './components/Header';
import { ApiKeyInput } from './components/ApiKeyInput';
import { SampleUploader } from './components/SampleUploader';
import { ScriptGenerator } from './components/ScriptGenerator';
import { ScriptPreview } from './components/ScriptPreview';
import { FinalScriptImagePrompts } from './components/FinalScriptImagePrompts';
import { SampleTemplate } from './components/SampleTemplate';
import { QuickStartGuide } from './components/QuickStartGuide';
import { ParsedScript } from './types';
import { BookOpen, FileText, Sparkles, ArrowRight, CheckCircle } from 'lucide-react';

function App() {
  const [sampleScripts, setSampleScripts] = useState<ParsedScript[]>([]);
  const [generatedScript, setGeneratedScript] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentTopic, setCurrentTopic] = useState('');
  const [currentSubject, setCurrentSubject] = useState('');
  const [currentMeta, setCurrentMeta] = useState<{chapter?:string;topic?:string;learningObjective?:string;preserveAudioCues?:boolean}>({});
  const [isScriptOpen, setIsScriptOpen] = useState(false);
  const [, setApiKeySet] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* How It Works */}
        <div className="mb-8 bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
          <h2 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-amber-500" />
            How ScriptForge AI Works
          </h2>
          <div className="grid md:grid-cols-4 gap-4">
            <StepCard number={1} icon={<FileText className="w-6 h-6" />}
              title="Upload Format Sample"
              description="Upload your existing PicEd Word script so the AI learns your exact format"
              color="purple" />
            <StepCard number={2} icon={<BookOpen className="w-6 h-6" />}
              title="Add Book Content"
              description="Upload or paste textbook content — fields auto-fill from it"
              color="blue" />
            <StepCard number={3} icon={<Sparkles className="w-6 h-6" />}
              title="AI Generates Script"
              description="Groq AI creates a frame-by-frame script matching your format"
              color="amber" />
            <StepCard number={4} icon={<CheckCircle className="w-6 h-6" />}
              title="Download as Word"
              description="Download the exact same format — tables, fonts, colors — as your sample"
              color="green" />
          </div>
        </div>

        {/* API Key */}
        <div className="mb-8">
          <ApiKeyInput onKeySet={() => setApiKeySet(true)} />
        </div>

        {/* Sample Template */}
        <div className="mb-8">
          <SampleTemplate />
        </div>

        {/* Main Grid */}
        <div className={generatedScript ? 'max-w-4xl mx-auto space-y-8' : 'grid lg:grid-cols-2 gap-8'}>
          <div className="space-y-8">
            <SampleUploader
              sampleScripts={sampleScripts}
              onScriptsUpdate={setSampleScripts}
            />
            <ScriptGenerator
              sampleScripts={sampleScripts}
              onGenerate={(script, topic, subject, meta) => {
                setGeneratedScript(script);
                setCurrentTopic(topic);
                setCurrentSubject(subject);
                if (meta) setCurrentMeta(meta);
                setIsScriptOpen(true);
              }}
              isGenerating={isGenerating}
              setIsGenerating={setIsGenerating}
            />
            <FinalScriptImagePrompts
              topic={currentTopic}
              subject={currentSubject}
              sampleScripts={sampleScripts}
            />
          </div>

          {!generatedScript && (
          <div className="lg:sticky lg:top-8 lg:self-start">
            <ScriptPreview
              generatedScript={generatedScript}
              topic={currentTopic || 'Generated Script'}
              subject={currentSubject || 'Educational'}
              sampleScripts={sampleScripts}
              onRefine={setGeneratedScript}
              meta={currentMeta}
            />
          </div>
          )}
        </div>

        {generatedScript && isScriptOpen && (
          <div className="fixed inset-0 z-50 bg-slate-950/70 p-3 sm:p-6">
            <div className="mx-auto h-full max-w-[1600px]">
              <ScriptPreview
                generatedScript={generatedScript}
                topic={currentTopic || 'Generated Script'}
                subject={currentSubject || 'Educational'}
                sampleScripts={sampleScripts}
                onRefine={setGeneratedScript}
                meta={currentMeta}
                isFullscreen
                onMinimize={() => setIsScriptOpen(false)}
              />
            </div>
          </div>
        )}

        {generatedScript && !isScriptOpen && (
          <button
            type="button"
            onClick={() => setIsScriptOpen(true)}
            className="fixed bottom-24 right-6 z-40 flex items-center gap-2 rounded-xl bg-[#2C3E50] px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-[#34495E] transition-all"
          >
            <FileText className="w-4 h-4" />
            Open Generated Script
          </button>
        )}

        {/* Tips */}
        <div className="mt-12 bg-gradient-to-r from-[#2C3E50] to-[#34495E] rounded-2xl p-8 text-white">
          <h3 className="text-xl font-bold mb-4">💡 Tips for Best Results</h3>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <TipItem text="Upload your existing PicEd script as the format sample" />
              <TipItem text="The more book content you provide, the richer the generated script" />
              <TipItem text="Generated Word file uses the same tables, fonts, and colors as your original" />
            </div>
            <div className="space-y-3">
              <TipItem text="Fill in Chapter and Learning Objective for the best output" />
              <TipItem text="Use the Refine button to adjust content after generation" />
              <TipItem text="Each frame includes Audio Cues, Frame Type, Body Text, and Visual/Animation Instructions" />
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-16 py-8 border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm text-slate-500">
          <p>ScriptForge AI — Powered by Groq AI</p>
          <p className="mt-1">Generate PicEd-format educational video scripts from any textbook content</p>
        </div>
      </footer>

      <QuickStartGuide />
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────
interface StepCardProps {
  number: number; icon: React.ReactNode; title: string;
  description: string; color: 'purple' | 'blue' | 'amber' | 'green';
}
function StepCard({ number, icon, title, description, color }: StepCardProps) {
  const c = {
    purple: 'bg-purple-100 text-purple-600 border-purple-200',
    blue:   'bg-blue-100 text-blue-600 border-blue-200',
    amber:  'bg-amber-100 text-amber-600 border-amber-200',
    green:  'bg-green-100 text-green-600 border-green-200',
  };
  return (
    <div className="relative">
      <div className={`${c[color]} p-4 rounded-xl border`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="bg-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shadow-sm">{number}</span>
          {icon}
        </div>
        <h4 className="font-semibold mb-1">{title}</h4>
        <p className="text-sm opacity-80">{description}</p>
      </div>
      {number < 4 && (
        <div className="hidden md:block absolute top-1/2 -right-4 transform -translate-y-1/2">
          <ArrowRight className="w-6 h-6 text-slate-300" />
        </div>
      )}
    </div>
  );
}

function TipItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <CheckCircle className="w-5 h-5 text-white/80 flex-shrink-0 mt-0.5" />
      <span className="text-white/90">{text}</span>
    </div>
  );
}

export default App;
