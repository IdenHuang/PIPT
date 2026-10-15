import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UI_COLORS } from '@/lib/colors';
import { useNotification } from '@/components/notifications';

interface Patient {
  id: string;
  name: string;
}

interface AddPatientSpecificQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patients: Patient[];
  onSave: (question: {
    patientId: string;
    title: string;
    keyQuestion: string;
    clinicalIntent: string;
    evaluationCriteria: string;
    required: boolean;
  }) => void;
}

export function AddPatientSpecificQuestionDialog({ 
  open, 
  onOpenChange, 
  patients,
  onSave 
}: AddPatientSpecificQuestionDialogProps) {
  const { showNotification } = useNotification();
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [title, setTitle] = useState('');
  const [keyQuestion, setKeyQuestion] = useState('');
  const [clinicalIntent, setClinicalIntent] = useState('');
  const [evaluationCriteria, setEvaluationCriteria] = useState('');
  const [required, setRequired] = useState(false);

  const handleSave = () => {
    if (!selectedPatientId) {
      showNotification({ message: 'Please select a patient.', type: 'warning' });
      return;
    }
    
    if (!title.trim() || !keyQuestion.trim()) {
      showNotification({ message: 'Please fill in at least the Title and Key Question fields.', type: 'warning' });
      return;
    }

    onSave({
      patientId: selectedPatientId,
      title: title.trim(),
      keyQuestion: keyQuestion.trim(),
      clinicalIntent: clinicalIntent.trim(),
      evaluationCriteria: evaluationCriteria.trim(),
      required,
    });

    // Reset form
    setSelectedPatientId('');
    setTitle('');
    setKeyQuestion('');
    setClinicalIntent('');
    setEvaluationCriteria('');
    setRequired(false);
    onOpenChange(false);
  };

  const handleCancel = () => {
    // Reset form
    setSelectedPatientId('');
    setTitle('');
    setKeyQuestion('');
    setClinicalIntent('');
    setEvaluationCriteria('');
    setRequired(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ color: UI_COLORS.text.heading }}>
            Add New Patient-Specific Question
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Patient Selection */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.heading }}>
              Select Patient
            </label>
            <select
              value={selectedPatientId}
              onChange={(e) => setSelectedPatientId(e.target.value)}
              className="w-full px-3 py-2 rounded-md border"
              style={{
                borderColor: UI_COLORS.border.default,
                backgroundColor: UI_COLORS.background.white,
                color: UI_COLORS.text.heading,
              }}
            >
              <option value="">-- Select a patient --</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
          </div>

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
        <div className="flex justify-end gap-3 pt-4 border-t" style={{ borderColor: UI_COLORS.border.default }}>
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
            onClick={handleSave}
            style={{
              backgroundColor: UI_COLORS.button.primary,
              color: UI_COLORS.button.text,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
          >
            Save Question
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
