import { useState, useCallback, useEffect } from 'react';
import { FileText, Image, Type, X, Loader2, Wand2, AlertCircle, Sparkles } from 'lucide-react';
import mammoth from 'mammoth';
import { BookContentSource } from '../types';
import { analyzeBookContent, ContentMetadata } from '../utils/contentAnalyzer';

interface BookContentInputProps {
  content: string;
  onContentChange: (content: string) => void;
  onMetadataDetected: (metadata: ContentMetadata) => void;
}

export function BookContentInput({ 
  content, 
  onContentChange, 
  onMetadataDetected,
}: BookContentInputProps) {
  const [inputMode, setInputMode] = useState<'text' | 'word' | 'image'>('text');
  const [uploadedSources, setUploadedSources] = useState<BookContentSource[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [lastAnalyzedContent, setLastAnalyzedContent] = useState('');

  // Analyze content when it changes (with debounce)
  useEffect(() => {
    if (content && content.length > 50 && content !== lastAnalyzedContent) {
      const timer = setTimeout(() => {
        const metadata = analyzeBookContent(content);
        onMetadataDetected(metadata);
        setLastAnalyzedContent(content);
      }, 500); // Debounce 500ms
      
      return () => clearTimeout(timer);
    }
  }, [content, lastAnalyzedContent, onMetadataDetected]);

  const handleWordUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    setIsProcessing(true);
    setError('');
    
    let extractedContent = '';
    const newSources: BookContentSource[] = [];
    
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.docx') && !file.name.endsWith('.doc')) {
        setError('Please upload Word documents (.docx or .doc files)');
        continue;
      }
      
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extractedContent += result.value + '\n\n';
        
        newSources.push({
          type: 'word',
          content: result.value,
          fileName: file.name,
        });
      } catch (err) {
        console.error('Error parsing Word document:', err);
        setError(`Failed to parse ${file.name}`);
      }
    }
    
    if (extractedContent) {
      const combinedContent = content ? `${content}\n\n${extractedContent}` : extractedContent;
      onContentChange(combinedContent.trim());
      setUploadedSources(current => [...current, ...newSources]);
      
      // Analyze the new content immediately
      const metadata = analyzeBookContent(combinedContent.trim());
      onMetadataDetected(metadata);
      setLastAnalyzedContent(combinedContent.trim());
    }
    
    setIsProcessing(false);
  }, [content, onContentChange, onMetadataDetected]);

  const handleImageUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    setIsProcessing(true);
    setError('');
    
    const newSources: BookContentSource[] = [];
    const imageNotes: string[] = [];
    
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        setError('Please upload image files (PNG, JPG, etc.)');
        continue;
      }
      
      // Convert image to base64 for display/reference
      const reader = new FileReader();
      
      await new Promise<void>((resolve) => {
        reader.onload = () => {
          const base64 = reader.result as string;
          newSources.push({
            type: 'image',
            content: base64,
            fileName: file.name,
          });
          
          imageNotes.push(`[Image uploaded: ${file.name}]\n(Please describe the key content from this image for script generation)`);
          
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }
    
    if (imageNotes.length > 0) {
      const combinedContent = [content.trim(), ...imageNotes].filter(Boolean).join('\n\n');
      onContentChange(combinedContent);
    }
    setUploadedSources(current => [...current, ...newSources]);
    setIsProcessing(false);
  }, [content, onContentChange]);

  const removeSource = (index: number) => {
    const newSources = [...uploadedSources];
    newSources.splice(index, 1);
    setUploadedSources(newSources);
  };

  const loadDemoContent = () => {
    const demoContent = `PHOTOSYNTHESIS

Photosynthesis is the process by which green plants, algae, and certain bacteria convert light energy into chemical energy. This process occurs mainly in the leaves of plants, specifically in organelles called chloroplasts.

THE PROCESS:
Photosynthesis can be summarized by the following equation:
6CO₂ + 6H₂O + Light Energy → C₆H₁₂O₆ + 6O₂

This means that carbon dioxide and water, in the presence of light energy, are converted into glucose (a sugar) and oxygen.

KEY COMPONENTS:
1. Chlorophyll - The green pigment in chloroplasts that absorbs light energy, primarily from the red and blue portions of the light spectrum.

2. Light-Dependent Reactions - These occur in the thylakoid membranes and require light. Water molecules are split, releasing oxygen and producing ATP and NADPH.

3. Light-Independent Reactions (Calvin Cycle) - These occur in the stroma and use ATP and NADPH to convert CO₂ into glucose.

FACTORS AFFECTING PHOTOSYNTHESIS:
- Light intensity: Increased light leads to faster photosynthesis, up to a saturation point
- Carbon dioxide concentration: Higher CO₂ levels increase the rate of photosynthesis
- Temperature: Optimal temperature range is 25-35°C for most plants
- Water availability: Water stress reduces photosynthesis

IMPORTANCE:
- Produces oxygen essential for aerobic respiration
- Creates glucose that forms the base of food chains
- Removes carbon dioxide from the atmosphere
- Produces organic compounds used for plant growth`;

    onContentChange(demoContent);
    
    // Analyze and auto-fill immediately
    const metadata = analyzeBookContent(demoContent);
    onMetadataDetected(metadata);
    setLastAnalyzedContent(demoContent);
  };

  return (
    <div className="space-y-4">
      {/* Input Mode Tabs */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-slate-700">
          Content from Books / Source Material
        </label>
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
          <button
            onClick={() => setInputMode('text')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              inputMode === 'text'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <Type className="w-4 h-4" />
            Type
          </button>
          <button
            onClick={() => setInputMode('word')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              inputMode === 'word'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <FileText className="w-4 h-4" />
            Word
          </button>
          <button
            onClick={() => setInputMode('image')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              inputMode === 'image'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <Image className="w-4 h-4" />
            Image
          </button>
        </div>
      </div>

      {/* Upload Area for Word/Image */}
      {(inputMode === 'word' || inputMode === 'image') && (
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center hover:border-indigo-400 hover:bg-slate-50 transition-all">
          <input
            type="file"
            accept={inputMode === 'word' ? '.docx,.doc' : 'image/*'}
            multiple
            onChange={(e) => inputMode === 'word' ? handleWordUpload(e.target.files) : handleImageUpload(e.target.files)}
            className="hidden"
            id={`${inputMode}-upload`}
          />
          <label htmlFor={`${inputMode}-upload`} className="cursor-pointer">
            {isProcessing ? (
              <div className="flex flex-col items-center">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-2" />
                <p className="text-slate-600">Processing...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className={`p-3 rounded-full mb-2 ${inputMode === 'word' ? 'bg-blue-100' : 'bg-purple-100'}`}>
                  {inputMode === 'word' ? (
                    <FileText className="w-6 h-6 text-blue-600" />
                  ) : (
                    <Image className="w-6 h-6 text-purple-600" />
                  )}
                </div>
                <p className="font-medium text-slate-700 mb-1">
                  {inputMode === 'word' 
                    ? 'Upload Word documents with book content'
                    : 'Upload images from textbooks'
                  }
                </p>
                <p className="text-sm text-slate-500">
                  {inputMode === 'word'
                    ? 'Text will be extracted and settings auto-filled'
                    : 'Add descriptions for image content'
                  }
                </p>
              </div>
            )}
          </label>
        </div>
      )}

      {/* Uploaded Sources List */}
      {uploadedSources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {uploadedSources.map((source, index) => (
            <div
              key={index}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
                source.type === 'word' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
              }`}
            >
              {source.type === 'word' ? (
                <FileText className="w-4 h-4" />
              ) : (
                <Image className="w-4 h-4" />
              )}
              <span className="truncate max-w-[150px]">{source.fileName}</span>
              <button
                onClick={() => removeSource(index)}
                className="hover:bg-white/50 rounded-full p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Image Previews */}
      {uploadedSources.filter(s => s.type === 'image').length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {uploadedSources
            .filter(s => s.type === 'image')
            .map((source, index) => (
              <div key={index} className="relative group">
                <img
                  src={source.content}
                  alt={source.fileName}
                  className="w-full h-24 object-cover rounded-lg"
                />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
                  <span className="text-white text-xs px-2 text-center truncate">
                    {source.fileName}
                  </span>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Text Area */}
      <div className="relative">
        <textarea
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          placeholder={
            inputMode === 'text'
              ? 'Paste the relevant content from your textbook or source material here. Include key concepts, definitions, formulas, examples, and any important details you want covered in the video script...\n\nTopic, Subject, Audience, and Duration will be auto-detected from this content.'
              : inputMode === 'word'
              ? 'Extracted text from Word documents will appear here. Settings will be auto-filled based on content...'
              : 'Describe the content from uploaded images here. Include key concepts visible in the images...'
          }
          rows={8}
          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all resize-none"
        />
        
        {/* Demo Content Button */}
        <button
          onClick={loadDemoContent}
          className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 transition-colors"
        >
          <Wand2 className="w-3 h-3" />
          Load Demo
        </button>
      </div>

      {/* Auto-detection indicator */}
      {content && content.length > 50 && (
        <div className="flex items-center gap-2 text-xs text-green-600 bg-green-50 px-3 py-2 rounded-lg">
          <Sparkles className="w-4 h-4" />
          <span>Topic, Subject, Audience & Duration are auto-detected from your content</span>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      <p className="text-xs text-slate-500">
        {inputMode === 'text' && 'The more detailed content you provide, the better the generated script will be. Settings are auto-filled based on your content.'}
        {inputMode === 'word' && 'Upload Word documents (.docx) containing textbook content. Topic, Subject, Audience & Duration will be auto-detected.'}
        {inputMode === 'image' && 'Upload images of textbook pages. Please describe the key content visible in each image.'}
      </p>
    </div>
  );
}
