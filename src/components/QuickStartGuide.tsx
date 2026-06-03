import { useState } from 'react';
import { HelpCircle, X, Lightbulb, FileText, Settings, Download } from 'lucide-react';

export function QuickStartGuide() {
  const [isOpen, setIsOpen] = useState(false);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 bg-indigo-600 text-white p-4 rounded-full shadow-lg hover:bg-indigo-700 transition-all hover:scale-110 z-50"
        title="Quick Start Guide"
      >
        <HelpCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 p-6 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Lightbulb className="w-8 h-8" />
              <div>
                <h2 className="text-xl font-bold">Quick Start Guide</h2>
                <p className="text-white/80 text-sm">Get started with ScriptForge AI</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh]">
          <div className="space-y-6">
            <GuideSection
              icon={<Settings className="w-5 h-5" />}
              title="1. Connect Your Groq API Key"
              content="First, get a free API key from console.groq.com and enter it in the API Key section. This allows the platform to use Groq's fast AI for script generation."
            />

            <GuideSection
              icon={<FileText className="w-5 h-5" />}
              title="2. Upload Sample Scripts"
              content={
                <>
                  <p className="mb-2">Upload 1-3 of your existing video scripts in Word format (.docx). The AI will learn:</p>
                  <ul className="list-disc list-inside text-sm space-y-1 text-slate-600">
                    <li>Your script structure and section format</li>
                    <li>Writing style and tone</li>
                    <li>How you mark visual cues and images</li>
                    <li>Transition phrases you use</li>
                    <li>Introduction and conclusion patterns</li>
                  </ul>
                </>
              }
            />

            <GuideSection
              icon={<FileText className="w-5 h-5" />}
              title="3. Format Your Sample Scripts"
              content={
                <>
                  <p className="mb-2">For best results, use consistent markers in your sample scripts:</p>
                  <div className="bg-slate-50 p-3 rounded-lg text-sm font-mono space-y-1">
                    <p><span className="text-indigo-600">[TITLE]</span> Main headings</p>
                    <p><span className="text-blue-600">[SUBTITLE]</span> Section headings</p>
                    <p><span className="text-green-600">[NARRATOR]</span> Voice-over text</p>
                    <p><span className="text-amber-600">[VISUAL]</span> Visual descriptions</p>
                    <p><span className="text-purple-600">[IMAGE]</span> Specific images/graphics</p>
                    <p><span className="text-rose-600">[TRANSITION]</span> Scene transitions</p>
                    <p><span className="text-slate-600">[TEXT]</span> On-screen text</p>
                  </div>
                </>
              }
            />

            <GuideSection
              icon={<FileText className="w-5 h-5" />}
              title="4. Provide Book Content"
              content="Paste relevant content from your textbook or source material. Include definitions, key concepts, formulas, examples - the more detail, the better the script."
            />

            <GuideSection
              icon={<Download className="w-5 h-5" />}
              title="5. Generate & Download"
              content="Click 'Generate Script' and watch the AI create a script in your format. Review the output, use the 'Refine' feature for adjustments, then download as a Word document."
            />
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200">
          <button
            onClick={() => setIsOpen(false)}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            Got it, let's start!
          </button>
        </div>
      </div>
    </div>
  );
}

interface GuideSectionProps {
  icon: React.ReactNode;
  title: string;
  content: React.ReactNode;
}

function GuideSection({ icon, title, content }: GuideSectionProps) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-indigo-600">
        {icon}
      </div>
      <div>
        <h3 className="font-semibold text-slate-800 mb-2">{title}</h3>
        <div className="text-slate-600">{content}</div>
      </div>
    </div>
  );
}
