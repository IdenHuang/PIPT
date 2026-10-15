import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import { UI_COLORS } from '@/lib/colors';
import { studentService } from '@/services/studentService';
import {
  validateDTPSubmission,
  validateRecommendationSubmission,
  addListEntry,
  removeListEntry,
} from '@/lib/bankUtils';
import type { RecommendationEntry } from '@/lib/bankUtils';

interface ConcludeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  simulationGroupId: string;
  patientId: string;
  onConcluded: (dtpSubmission: string[], recommendationSubmission: { recommendation: string; rationale: string }[]) => void;
  mode?: 'interview_practice' | 'full_assessment' | 'conversation_only';
}

export function ConcludeModal({
  open,
  onOpenChange,
  sessionId,
  simulationGroupId,
  patientId,
  onConcluded,
  mode = 'full_assessment',
}: ConcludeModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [dtpEntries, setDtpEntries] = useState<string[]>(['']);
  const [recommendationEntries, setRecommendationEntries] = useState<RecommendationEntry[]>([
    { recommendation: '', rationale: '' },
  ]);
  const [dtpValidationError, setDtpValidationError] = useState('');
  const [recValidationError, setRecValidationError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const resetState = useCallback(() => {
    setStep(1);
    setDtpEntries(['']);
    setRecommendationEntries([{ recommendation: '', rationale: '' }]);
    setDtpValidationError('');
    setRecValidationError('');
    setSubmitting(false);
  }, []);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetState();
    }
    onOpenChange(isOpen);
  };

  // ─── Step 1: DTP Handlers ───────────────────────────────────────────────────

  const handleDtpChange = (index: number, value: string) => {
    setDtpEntries((prev) => prev.map((entry, i) => (i === index ? value : entry)));
    if (dtpValidationError) setDtpValidationError('');
  };

  const handleAddDtp = () => {
    setDtpEntries((prev) => addListEntry(prev));
  };

  const handleRemoveDtp = (index: number) => {
    setDtpEntries((prev) => removeListEntry(prev, index));
  };

  const handleNext = () => {
    if (!validateDTPSubmission(dtpEntries)) {
      setDtpValidationError('Please enter at least one Drug Therapy Problem before continuing.');
      return;
    }
    setDtpValidationError('');
    setStep(2);
  };

  // ─── Step 2: Recommendation Handlers ───────────────────────────────────────

  const handleRecommendationChange = (index: number, field: keyof RecommendationEntry, value: string) => {
    setRecommendationEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry))
    );
    if (recValidationError) setRecValidationError('');
  };

  const handleAddRecommendation = () => {
    setRecommendationEntries((prev) => addListEntry(prev));
  };

  const handleRemoveRecommendation = (index: number) => {
    setRecommendationEntries((prev) => removeListEntry(prev, index));
  };

  const handleBack = () => {
    setRecValidationError('');
    setStep(1);
  };

  const handleSubmit = async () => {
    if (!validateRecommendationSubmission(recommendationEntries)) {
      setRecValidationError('Please enter at least one recommendation before submitting.');
      return;
    }
    setRecValidationError('');
    setSubmitting(true);

    try {
      await studentService.concludeWithSubmissions({
        sessionId,
        simulationGroupId,
        patientId,
        dtpSubmission: {
          entries: dtpEntries.filter((e) => e.trim().length > 0),
        },
        recommendationSubmission: {
          entries: recommendationEntries.filter((e) => e.recommendation.trim().length > 0),
        },
      });
      const submittedDtps = dtpEntries.filter((e) => e.trim().length > 0);
      const submittedRecs = recommendationEntries.filter((e) => e.recommendation.trim().length > 0);
      resetState();
      onOpenChange(false);
      onConcluded(submittedDtps, submittedRecs);
    } catch {
      setRecValidationError('Failed to submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInterviewPracticeConclude = async () => {
    setSubmitting(true);
    try {
      const result = await studentService.concludeInteraction(simulationGroupId, patientId, sessionId, null);
      if (!result.success) {
        setRecValidationError('Failed to conclude. Please try again.');
        return;
      }
      resetState();
      onOpenChange(false);
      onConcluded([], []);
    } catch {
      setRecValidationError('Failed to conclude. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ color: UI_COLORS.text.heading }}>
            Conclude Interaction
          </DialogTitle>
          {mode === 'full_assessment' && (
            <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>
              Step {step} of 2
            </p>
          )}
        </DialogHeader>

        {mode === 'interview_practice' && (
          <div className="space-y-4 py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to conclude this interview? Your session will be marked as complete and an AI debrief will be generated based on your conversation.
            </p>

            {recValidationError && (
              <p className="text-sm" style={{ color: UI_COLORS.status.error }}>
                {recValidationError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t" style={{ borderColor: UI_COLORS.border.default }}>
              <Button
                onClick={() => handleOpenChange(false)}
                variant="outline"
                style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleInterviewPracticeConclude}
                loading={submitting}
                style={{
                  backgroundColor: UI_COLORS.button.primary,
                  color: UI_COLORS.button.text,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
              >
                Conclude Interview
              </Button>
            </div>
          </div>
        )}

        {mode === 'full_assessment' && step === 1 && (
          <div className="space-y-4 py-4">
            <div>
              <h3 className="text-base font-medium mb-1" style={{ color: UI_COLORS.text.heading }}>
                Drug Therapy Problems (DTPs)
              </h3>
              <p className="text-sm mb-4" style={{ color: UI_COLORS.text.muted }}>
                Enter the drug therapy problems you identified during this interaction.
              </p>
            </div>

            <div className="space-y-3">
              {dtpEntries.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={entry}
                    onChange={(e) => handleDtpChange(index, e.target.value)}
                    placeholder={`DTP ${index + 1}`}
                    className="flex-1"
                    style={{
                      borderColor: UI_COLORS.border.default,
                      backgroundColor: UI_COLORS.background.white,
                    }}
                  />
                  {dtpEntries.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveDtp(index)}
                      aria-label={`Remove DTP ${index + 1}`}
                      className="shrink-0"
                    >
                      <Trash2 className="h-4 w-4" style={{ color: UI_COLORS.status.error }} />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={handleAddDtp}
              className="w-full"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add another DTP
            </Button>

            {dtpValidationError && (
              <p className="text-sm" style={{ color: UI_COLORS.status.error }}>
                {dtpValidationError}
              </p>
            )}

            <div className="flex justify-end pt-4 border-t" style={{ borderColor: UI_COLORS.border.default }}>
              <Button
                onClick={handleNext}
                style={{
                  backgroundColor: UI_COLORS.button.primary,
                  color: UI_COLORS.button.text,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {mode === 'full_assessment' && step === 2 && (
          <div className="space-y-4 py-4">
            <div>
              <h3 className="text-base font-medium mb-1" style={{ color: UI_COLORS.text.heading }}>
                Recommendations & Rationale
              </h3>
              <p className="text-sm mb-4" style={{ color: UI_COLORS.text.muted }}>
                Enter your recommendations and the rationale for each.
              </p>
            </div>

            <div className="space-y-4">
              {recommendationEntries.map((entry, index) => (
                <div
                  key={index}
                  className="relative rounded-md border p-4"
                  style={{ borderColor: UI_COLORS.border.default }}
                >
                  {recommendationEntries.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveRecommendation(index)}
                      aria-label={`Remove recommendation ${index + 1}`}
                      className="absolute top-2 right-2"
                    >
                      <Trash2 className="h-4 w-4" style={{ color: UI_COLORS.status.error }} />
                    </Button>
                  )}
                  <div className="space-y-3 pr-8">
                    <div>
                      <label
                        className="block text-sm font-medium mb-1"
                        style={{ color: UI_COLORS.text.heading }}
                      >
                        Recommendation {index + 1}
                      </label>
                      <textarea
                        value={entry.recommendation}
                        onChange={(e) => handleRecommendationChange(index, 'recommendation', e.target.value)}
                        placeholder="Enter your recommendation..."
                        className="w-full px-3 py-2 rounded-md border resize-none text-sm"
                        rows={2}
                        style={{
                          borderColor: UI_COLORS.border.default,
                          backgroundColor: UI_COLORS.background.white,
                          color: UI_COLORS.text.heading,
                        }}
                      />
                    </div>
                    <div>
                      <label
                        className="block text-sm font-medium mb-1"
                        style={{ color: UI_COLORS.text.heading }}
                      >
                        Rationale
                      </label>
                      <textarea
                        value={entry.rationale}
                        onChange={(e) => handleRecommendationChange(index, 'rationale', e.target.value)}
                        placeholder="Enter your rationale..."
                        className="w-full px-3 py-2 rounded-md border resize-none text-sm"
                        rows={2}
                        style={{
                          borderColor: UI_COLORS.border.default,
                          backgroundColor: UI_COLORS.background.white,
                          color: UI_COLORS.text.heading,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={handleAddRecommendation}
              className="w-full"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add another recommendation
            </Button>

            {recValidationError && (
              <p className="text-sm" style={{ color: UI_COLORS.status.error }}>
                {recValidationError}
              </p>
            )}

            <div
              className="flex justify-between pt-4 border-t"
              style={{ borderColor: UI_COLORS.border.default }}
            >
              <Button
                onClick={handleBack}
                variant="outline"
                style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
              >
                Back
              </Button>
              <Button
                onClick={handleSubmit}
                loading={submitting}
                style={{
                  backgroundColor: UI_COLORS.button.primary,
                  color: UI_COLORS.button.text,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
              >
                Submit
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
