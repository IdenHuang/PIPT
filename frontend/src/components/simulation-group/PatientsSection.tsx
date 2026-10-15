import type { ReactNode } from 'react';
import { Search, Edit, Trash2, Plus, Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UI_COLORS } from '@/lib/colors';
import type { OrganizationLabels } from '@/services/instructorService';

export interface PatientsSectionProps {
  patients: any[];
  profilePictures: Record<string, string>;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onEditPatient: (patientId: string) => void;
  onDeletePatient: (patientId: string) => void;
  onCreatePatient: () => void;
  onTogglePatientVoice: (patientId: string, enabled: boolean) => void;
  labels: OrganizationLabels;
  enableVoiceForAll: boolean;
  onToggleVoice: (enabled: boolean) => void;
  children?: ReactNode;
}

export function PatientsSection({
  patients,
  searchQuery,
  onSearchChange,
  onEditPatient,
  onDeletePatient,
  onCreatePatient,
  onTogglePatientVoice,
  labels,
  enableVoiceForAll,
  onToggleVoice,
  children,
}: PatientsSectionProps) {
  const { aiPersona: aiPersonaLabel } = labels;

  const filteredPatients = patients.filter(patient =>
    (patient.name || patient.patient_name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" style={{ color: UI_COLORS.text.muted }} />
        <Input
          placeholder={`Search by ${aiPersonaLabel} Name`}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10 py-6 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Patient Table */}
      <div className="border rounded-lg overflow-hidden" style={{ borderColor: UI_COLORS.border.default }}>
        {/* Table Header */}
        <div className="grid grid-cols-[2fr_80px_100px_80px_2fr] gap-4 px-6 py-4" style={{ backgroundColor: UI_COLORS.background.tableHeader }}>
          <div className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
            Patient Name
          </div>
          <div className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
            Age
          </div>
          <div className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
            Gender
          </div>
          <div className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
            Voice
          </div>
          <div className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
            Actions
          </div>
        </div>

        {/* Table Rows */}
        {filteredPatients.map((patient) => {
          const voiceEnabled = patient.voice_enabled !== false;
          const pid = patient.id || patient.patient_id;
          return (
          <div
            key={pid}
            className="grid grid-cols-[2fr_80px_100px_80px_2fr] gap-4 px-6 py-4 border-t items-center"
            style={{ borderColor: UI_COLORS.border.default }}
          >
            <div className="text-base flex items-center gap-2" style={{ color: UI_COLORS.text.heading }}>
              {patient.name || patient.patient_name}
              {patient.mode === 'interview_practice' && (
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                  style={{ backgroundColor: UI_COLORS.badge.interviewPracticeBg, color: UI_COLORS.badge.interviewPracticeText }}
                >
                  Interview Practice
                </span>
              )}
              {patient.mode === 'conversation_only' && (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                    style={{ backgroundColor: UI_COLORS.badge.interviewPracticeBg, color: UI_COLORS.badge.interviewPracticeText }}
                  >
                    Conversation Only
                  </span>
                )}
            </div>
            <div className="text-base" style={{ color: UI_COLORS.text.heading }}>
              {patient.age || patient.patient_age}
            </div>
            <div className="text-base" style={{ color: UI_COLORS.text.heading }}>
              {patient.gender || patient.patient_gender}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={voiceEnabled}
                onClick={() => onTogglePatientVoice(pid, !voiceEnabled)}
                className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                style={{
                  backgroundColor: voiceEnabled ? UI_COLORS.toggle.active : UI_COLORS.toggle.inactive
                }}
                title={voiceEnabled ? 'Voice enabled — click to disable' : 'Voice disabled — click to enable'}
              >
                <span
                  className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                  style={{
                    transform: voiceEnabled ? 'translateX(18px)' : 'translateX(2px)'
                  }}
                />
              </button>
              {voiceEnabled
                ? <Mic className="w-4 h-4" style={{ color: UI_COLORS.toggle.active }} />
                : <MicOff className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
              }
            </div>
            <div className="flex items-center gap-3">
              <Button
                onClick={() => onEditPatient(pid)}
                className="px-6 py-2 text-sm font-medium transition-colors"
                style={{
                  backgroundColor: UI_COLORS.button.primary,
                  color: UI_COLORS.button.text
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
              >
                <Edit className="w-4 h-4 mr-1" />
                Edit
              </Button>
              <button
                onClick={() => onDeletePatient(pid)}
                className="p-2 rounded transition-colors"
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: 'transparent'
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <Trash2 className="w-5 h-5" style={{ color: UI_COLORS.text.body }} />
              </button>
            </div>
          </div>
          );
        })}
      </div>

      {/* Create New Patient Button */}
      <Button
        onClick={onCreatePatient}
        className="px-6 py-6 text-base font-medium transition-colors"
        style={{
          backgroundColor: UI_COLORS.button.primary,
          color: UI_COLORS.button.text
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
      >
        <Plus className="w-5 h-5 mr-2" />
        Create New Patient
      </Button>

      {/* Enable Voice for All Patients */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enableVoiceForAll}
          onClick={() => onToggleVoice(!enableVoiceForAll)}
          className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{
            backgroundColor: enableVoiceForAll ? UI_COLORS.toggle.active : UI_COLORS.toggle.inactive
          }}
        >
          <span
            className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
            style={{
              transform: enableVoiceForAll ? 'translateX(22px)' : 'translateX(2px)'
            }}
          />
        </button>
        <span
          className="text-sm font-medium"
          style={{ color: UI_COLORS.text.body }}
        >
          Enable voice conversations for all patients
        </span>
      </div>
      {children}
    </div>
  );
}
