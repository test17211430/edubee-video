import { useState } from 'react';
import { FileText, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import { PHOTOSYNTHESIS_SAMPLE_SCRIPT } from '../data/photosynthesisSample';

const SAMPLE_TEMPLATE = PHOTOSYNTHESIS_SAMPLE_SCRIPT;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

export function SampleTemplate() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyText(SAMPLE_TEMPLATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gradient-to-br from-slate-50 to-indigo-50 rounded-2xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-white/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="bg-indigo-100 p-2 rounded-lg">
            <FileText className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="text-left">
            <h3 className="font-semibold text-slate-800">Sample Script Format (PicEd Style)</h3>
            <p className="text-sm text-slate-500">View the expected video script format with frame-by-frame structure</p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-5 h-5 text-slate-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-slate-400" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-slate-200">
          <div className="p-4 bg-white/50 border-b border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-slate-600 font-medium">
                Script Format Structure:
              </p>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-300 transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4 text-green-600" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy Template
                  </>
                )}
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-purple-100 text-purple-700 px-2 py-1 rounded">Video Details</div>
              <div className="bg-blue-100 text-blue-700 px-2 py-1 rounded">Notes to Editor</div>
              <div className="bg-green-100 text-green-700 px-2 py-1 rounded">Frame-by-Frame</div>
              <div className="bg-amber-100 text-amber-700 px-2 py-1 rounded">Audio + Visual</div>
            </div>
          </div>
          <div className="p-4 max-h-96 overflow-y-auto">
            <pre className="text-sm text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">
              {SAMPLE_TEMPLATE}
            </pre>
          </div>
          <div className="p-4 bg-amber-50 border-t border-amber-200">
            <p className="text-sm text-amber-800">
              <strong>Key Elements:</strong> Video Details table, Notes to Video Editor, Frame Types (Title Screen, Wide, Wide with Image, Null, Summary), Audio Cues column, Frame column, Visualization/Text column with Image URLs
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
