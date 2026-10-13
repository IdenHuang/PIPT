import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UI_COLORS } from '@/lib/colors';
import { useNotification } from '@/components/notifications';

interface AddQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionType: 'global' | 'patientSpecific';
  existingTags?: string[];
  /**
   * Persist the question. May return a promise: a rejection keeps the dialog open
   * with the entered values and surfaces the rejection message inline.
   */
  onSave: (question: {
    title: string;
    keyQuestion: string;
    clinicalIntent: string;
    evaluationCriteria: string;
    required: boolean;
    tags?: string[];
  }) => void | Promise<void>;
}

export function AddQuestionDialog({ open, onOpenChange, questionType, existingTags = [], onSave }: AddQuestionDialogProps) {
  const { showNotification } = useNotification();
  const [title, setTitle] = useState('');
  const [keyQuestion, setKeyQuestion] = useState('');
  const [clinicalIntent, setClinicalIntent] = useState('');
  const [evaluationCriteria, setEvaluationCriteria] = useState('');
  const [required, setRequired] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Filter suggestions: match input, exclude already-added tags
  const suggestions = existingTags.filter(
    t => t.toLowerCase().includes(tagInput.toLowerCase()) && !tags.includes(t)
  );

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
        tagInputRef.current && !tagInputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags(prev => [...prev, trimmed]);
    }
    setTagInput('');
    setShowSuggestions(false);
  };

  const handleRemoveTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  };

  const handleSave = async () => {
    if (!title.trim() || !keyQuestion.trim()) {
      showNotification({ message: 'Please fill in at least the Title and Key Question fields.', type: 'warning' });
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      // A rejecting onSave means the save did not happen — keep the dialog open
      // with the entered values so nothing the user typed is lost.
      await onSave({
        title: title.trim(),
        keyQuestion: keyQuestion.trim(),
        clinicalIntent: clinicalIntent.trim(),
        evaluationCriteria: evaluationCriteria.trim(),
        required,
        tags,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save question.');
      return;
    } finally {
      setSaving(false);
    }

    // Reset form
    setTitle('');
    setKeyQuestion('');
    setClinicalIntent('');
    setEvaluationCriteria('');
    setRequired(false);
    setTagInput('');
    setTags([]);
    setSaveError(null);
    onOpenChange(false);
  };

  const handleCancel = () => {
    // Reset form
    setSaveError(null);
    setTitle('');
    setKeyQuestion('');
    setClinicalIntent('');
    setEvaluationCriteria('');
    setRequired(false);
    setTagInput('');
    setTags([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ color: UI_COLORS.text.heading }}>
            Add New {questionType === 'global' ? 'Global' : 'Patient-Specific'} Question
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Title
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Chest Pain Characterization"
              maxLength={150}
              className="w-full"
              style={{
                borderColor: UI_COLORS.border.default,
                backgroundColor: UI_COLORS.background.white,
              }}
            />
          </div>

          {/* Key Question */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Key Question
            </label>
            <textarea
              value={keyQuestion}
              onChange={(e) => setKeyQuestion(e.target.value)}
              placeholder="e.g., Assess the characteristics of the patient's chest pain, including onset, duration, severity, quality and radiation."
              className="w-full px-3 py-2 rounded-md border resize-none"
              rows={3}
              maxLength={5000}
              style={{
                borderColor: UI_COLORS.border.default,
                backgroundColor: UI_COLORS.background.white,
                color: UI_COLORS.text.heading,
              }}
            />
          </div>

          {/* Clinical Intent */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Clinical Intent
            </label>
            <textarea
              value={clinicalIntent}
              onChange={(e) => setClinicalIntent(e.target.value)}
              placeholder="e.g., This question evaluates the student's ability to gather essential details about the chest pain..."
              className="w-full px-3 py-2 rounded-md border resize-none"
              rows={4}
              maxLength={5000}
              style={{
                borderColor: UI_COLORS.border.default,
                backgroundColor: UI_COLORS.background.white,
                color: UI_COLORS.text.heading,
              }}
            />
          </div>

          {/* Evaluation Criteria */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Evaluation Criteria
            </label>
            <textarea
              value={evaluationCriteria}
              onChange={(e) => setEvaluationCriteria(e.target.value)}
              placeholder="e.g., The student attempts to identify at least 3-4 of the following core characteristics..."
              className="w-full px-3 py-2 rounded-md border resize-none"
              rows={5}
              maxLength={5000}
              style={{
                borderColor: UI_COLORS.border.default,
                backgroundColor: UI_COLORS.background.white,
                color: UI_COLORS.text.heading,
              }}
            />
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Tags
            </label>
            <p className="text-xs mb-2" style={{ color: UI_COLORS.text.muted }}>
              Add tags for filtering (e.g. Health, Physio, Mental Health). Press Enter or comma to add.
            </p>
            <div className="relative">
              <div className="flex gap-2 mb-2">
                <Input
                  ref={tagInputRef}
                  value={tagInput}
                  onChange={(e) => {
                    setTagInput(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag(tagInput);
                    }
                  }}
                  placeholder="Type a tag..."
                  className="flex-1"
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={showSuggestions && suggestions.length > 0}
                  aria-controls="tag-suggestions"
                  aria-autocomplete="list"
                  style={{
                    borderColor: UI_COLORS.border.default,
                    backgroundColor: UI_COLORS.background.white,
                  }}
                />
                <Button
                  type="button"
                  onClick={() => addTag(tagInput)}
                  variant="outline"
                  style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
                >
                  Add
                </Button>
              </div>
              {showSuggestions && tagInput.length > 0 && suggestions.length > 0 && (
                <div
                  ref={suggestionsRef}
                  id="tag-suggestions"
                  role="listbox"
                  className="absolute z-50 w-full max-h-40 overflow-y-auto rounded-md border shadow-md"
                  style={{
                    backgroundColor: UI_COLORS.background.white,
                    borderColor: UI_COLORS.border.default,
                    top: '100%',
                    marginTop: '-0.5rem',
                  }}
                >
                  {suggestions.map(tag => (
                    <button
                      key={tag}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="w-full text-left px-3 py-2 text-sm cursor-pointer hover:bg-gray-100 transition-colors border-0 bg-transparent"
                      style={{ color: UI_COLORS.text.heading }}
                      onClick={() => addTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tags.map(tag => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full"
                    style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="ml-1 hover:text-red-600 transition-colors bg-transparent border-0 cursor-pointer p-0"
                      aria-label={`Remove tag ${tag}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Required Toggle */}
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                className="sr-only peer"
              />
              <div
                className="w-11 h-6 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 transition-colors"
                style={{
                  backgroundColor: required ? UI_COLORS.button.primary : UI_COLORS.background.tableHeader,
                }}
              >
                <div
                  className="absolute top-[2px] left-[2px] bg-white rounded-full h-5 w-5 transition-transform"
                  style={{
                    transform: required ? 'translateX(20px)' : 'translateX(0)',
                  }}
                />
              </div>
            </label>
            <span className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>
              Required for Case Completion
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="pt-4 border-t" style={{ borderColor: UI_COLORS.border.default }}>
          {saveError && (
            <p className="text-sm mb-3" role="alert" style={{ color: UI_COLORS.text.error }}>
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button
              onClick={handleCancel}
              variant="outline"
              style={{
                borderColor: UI_COLORS.border.default,
                color: UI_COLORS.text.heading,
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                backgroundColor: UI_COLORS.button.primary,
                color: UI_COLORS.button.text,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
            >
              {saving ? 'Saving...' : 'Save Question'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
