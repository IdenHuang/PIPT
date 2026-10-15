import { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { ArrowLeft, Search, Camera, Trash2, Upload, Plus, Eye, CheckCircle, Loader2, XCircle, FileText, Mic, MessageSquareText, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import UserAvatar from '@/components/UserAvatar';
import VoicePreview from '@/components/prompt-playground/VoicePreview';
import { UI_COLORS, SIMULATION_GROUP_COLOR_PALETTE } from '@/lib/colors';
import type { UsePatientEditorReturn } from '@/hooks/usePatientEditor';
import { instructorService, type OrganizationLabels, type GlobalRubricQuestion, type CaseMaterial, type UploadedFileInfo } from '@/services/instructorService';
import { useNotification } from '@/components/notifications';
import type { DTPAssignment } from '@/services/dtpBankService';
import type { RecommendationAssignment } from '@/services/recommendationsBankService';

export interface EditPatientPanelProps {
  patientEditor: UsePatientEditorReturn;
  profilePictures: Record<string, string>;
  onBack: () => void;
  labels: OrganizationLabels;
  groupId: string;
  globalRubricQuestions: GlobalRubricQuestion[];
  onSavePatient: () => Promise<void>;
  onSaveCaseQuestion: (patientId: string, question: GlobalRubricQuestion) => void;
  onDeleteCaseQuestion: (patientId: string, questionId: string) => void;
  // DTP/Rec patient-specific authoring
  onCreatePatientDTP?: (patientId: string, data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => Promise<void>;
  onUpdatePatientDTP?: (dtpId: string, data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => Promise<void>;
  onDeletePatientDTP?: (patientId: string, groupDtpId: string) => Promise<void>;
  patientDTPs?: DTPAssignment[];
  groupDTPs?: DTPAssignment[];
  onCreatePatientRecommendation?: (patientId: string, data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string }) => Promise<void>;
  onUpdatePatientRecommendation?: (recommendationId: string, data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string }) => Promise<void>;
  onDeletePatientRecommendation?: (patientId: string, groupRecommendationId: string) => Promise<void>;
  patientRecommendations?: RecommendationAssignment[];
  groupRecommendations?: RecommendationAssignment[];
  onLoadPatientDTPs?: (patientId: string) => void;
  onLoadPatientRecommendations?: (patientId: string) => void;
}

export function EditPatientPanel({
  patientEditor,
  profilePictures,
  onBack,
  labels,
  groupId: _groupId,
  globalRubricQuestions,
  onSavePatient,
  onSaveCaseQuestion,
  onDeleteCaseQuestion,
  onUpdatePatientDTP,
  onDeletePatientDTP,
  patientDTPs = [],
  groupDTPs = [],
  onUpdatePatientRecommendation,
  onDeletePatientRecommendation,
  patientRecommendations = [],
  groupRecommendations = [],
  onLoadPatientDTPs,
  onLoadPatientRecommendations,
}: EditPatientPanelProps) {
  const [caseQuestionSearchQuery, setCaseQuestionSearchQuery] = useState('');
  const [globalRubricSearchQuery, setGlobalRubricSearchQuery] = useState('');
  const [materialSearchQuery, setMaterialSearchQuery] = useState('');

  const filteredCaseQuestions = patientEditor.caseSpecificQuestions.filter(q =>
    q.title.toLowerCase().includes(caseQuestionSearchQuery.toLowerCase())
  );

  const filteredMaterials = patientEditor.caseMaterials.filter(m =>
    m.title.toLowerCase().includes(materialSearchQuery.toLowerCase())
  );

  const filteredGlobalRubric = globalRubricQuestions.filter(q =>
    q.title.toLowerCase().includes(globalRubricSearchQuery.toLowerCase())
  );

  return (
    <div className="flex h-full">
      {/* Edit Patient Sidebar */}
      <aside
        className="flex flex-col border-r overflow-y-auto"
        style={{
          backgroundColor: UI_COLORS.background.white,
          borderRightWidth: '1px',
          borderRightStyle: 'solid',
          borderRightColor: UI_COLORS.border.default,
          width: '16rem',
          minWidth: '16rem',
        }}
      >
        <div className="p-6">
          <button
            onClick={onBack}
            className="flex items-center gap-2 mb-4 text-sm transition-colors"
            style={{
              color: UI_COLORS.text.body,
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
            onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
          >
            <ArrowLeft className="w-4 h-4" />
            Back to All {labels.aiPersonaPlural}
          </button>
          <h2 className="text-xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
            {patientEditor.selectedPatientForEdit === 'new' ? `Create ${labels.aiPersona}` : `Edit ${labels.aiPersona}`}
          </h2>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {[
            { tab: 'info' as const, label: 'Patient Information' },
            { tab: 'questions' as const, label: 'Case-specific Key Questions' },
            { tab: 'dtps' as const, label: 'Patient-Specific DTPs' },
            { tab: 'recommendations' as const, label: 'Patient-Specific Recommendations' },
            { tab: 'materials' as const, label: 'Physical Assessment Materials' },
          ].map(({ tab, label }) => (
            <button
              key={tab}
              onClick={() => patientEditor.handleEditPatientTabSwitch(tab)}
              className="w-full text-left px-4 py-3 rounded-lg font-medium transition-colors"
              style={{
                backgroundColor: patientEditor.editPatientTab === tab ? UI_COLORS.background.tableHeader : 'transparent',
                color: UI_COLORS.text.heading,
                border: 'none',
                cursor: 'pointer'
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Edit Patient Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto" style={{ padding: patientEditor.editPatientTab === 'questions' || patientEditor.editPatientTab === 'materials' || patientEditor.editPatientTab === 'dtps' || patientEditor.editPatientTab === 'recommendations' ? '0' : '2rem' }}>
          {patientEditor.editPatientTab === 'info' && (
            <InfoTab
              patientEditor={patientEditor}
              profilePictures={profilePictures}
              labels={labels}
              onSavePatient={onSavePatient}
            />
          )}

          {patientEditor.editPatientTab === 'questions' && (
            <QuestionsTab
              patientEditor={patientEditor}
              caseQuestionSearchQuery={caseQuestionSearchQuery}
              onCaseQuestionSearchChange={setCaseQuestionSearchQuery}
              filteredCaseQuestions={filteredCaseQuestions}
              globalRubricSearchQuery={globalRubricSearchQuery}
              onGlobalRubricSearchChange={setGlobalRubricSearchQuery}
              filteredGlobalRubric={filteredGlobalRubric}
              onSaveCaseQuestion={onSaveCaseQuestion}
              onDeleteCaseQuestion={onDeleteCaseQuestion}
            />
          )}

          {patientEditor.editPatientTab === 'dtps' && (
            <PatientDTPsTab
              patientEditor={patientEditor}
              patientDTPs={patientDTPs}
              groupDTPs={groupDTPs}
              onUpdatePatientDTP={onUpdatePatientDTP}
              onDeletePatientDTP={onDeletePatientDTP}
              onLoadPatientDTPs={onLoadPatientDTPs}
            />
          )}

          {patientEditor.editPatientTab === 'recommendations' && (
            <PatientRecommendationsTab
              patientEditor={patientEditor}
              patientRecommendations={patientRecommendations}
              groupRecommendations={groupRecommendations}
              onUpdatePatientRecommendation={onUpdatePatientRecommendation}
              onDeletePatientRecommendation={onDeletePatientRecommendation}
              onLoadPatientRecommendations={onLoadPatientRecommendations}
            />
          )}

          {patientEditor.editPatientTab === 'materials' && (
            <MaterialsTab
              patientEditor={patientEditor}
              materialSearchQuery={materialSearchQuery}
              onMaterialSearchChange={setMaterialSearchQuery}
              filteredMaterials={filteredMaterials}
            />
          )}
        </div>
      </div>
    </div>
  );
}


/* ─── Info Tab ─── */

function InfoTab({
  patientEditor,
  profilePictures,
  labels,
  onSavePatient,
}: {
  patientEditor: UsePatientEditorReturn;
  profilePictures: Record<string, string>;
  labels: OrganizationLabels;
  onSavePatient: () => Promise<void>;
}) {
  const [previewFile, setPreviewFile] = useState<UploadedFileInfo | null>(null);

  // Photos and file uploads attach to a saved patient (persona_id). For a new
  // patient we can auto-save on first upload, but only once the required
  // identity fields are present — so gate those controls until then.
  const isNewPatient = patientEditor.selectedPatientForEdit === 'new';
  const requiredFieldsComplete =
    patientEditor.editPatientName.trim() !== '' &&
    patientEditor.editPatientAge.trim() !== '' &&
    parseInt(patientEditor.editPatientAge) > 0 &&
    patientEditor.editPatientGender.trim() !== '';
  const canAttachAssets = !isNewPatient || requiredFieldsComplete;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Photo Delete Confirmation Dialog */}
      <Dialog open={patientEditor.photoDeletePending} onOpenChange={(open) => { if (!open) patientEditor.cancelPhotoDelete(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Remove Photo</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove this photo?
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button onClick={patientEditor.cancelPhotoDelete} variant="outline" style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={patientEditor.confirmPhotoDelete} style={{ backgroundColor: '#ef4444', color: '#fff' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}>Remove</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* File Delete Confirmation Dialog */}
      <Dialog open={patientEditor.fileDeletePending.pending} onOpenChange={(open) => { if (!open) patientEditor.cancelFileDelete(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Delete File</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to delete "<span className="font-medium">{patientEditor.fileDeletePending.filename}</span>"? This will also remove its embeddings.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button onClick={patientEditor.cancelFileDelete} variant="outline" style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={patientEditor.confirmFileDelete} style={{ backgroundColor: '#ef4444', color: '#fff' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
      <div>
        <h3 className="text-2xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
          {patientEditor.editPatientName.trim() || (isNewPatient ? `Create ${labels.aiPersona}` : `Edit ${labels.aiPersona}`)}
        </h3>
        <p className="text-sm mt-1" style={{ color: UI_COLORS.text.muted }}>
          {isNewPatient ? `New ${labels.aiPersona.toLowerCase()} information` : `Editing ${labels.aiPersona.toLowerCase()}`}
        </p>
      </div>

      {/* Patient Name */}
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
          Patient Name <span style={{ color: UI_COLORS.text.error }}>*</span>
        </label>
        <Input
          value={patientEditor.editPatientName}
          onChange={(e) => patientEditor.setEditPatientName(e.target.value)}
          maxLength={100}
          className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Patient Age */}
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
          Patient Age <span style={{ color: UI_COLORS.text.error }}>*</span>
        </label>
        <Input
          type="number"
          min="0"
          max="100"
          value={patientEditor.editPatientAge}
          onChange={(e) => {
            const value = e.target.value;
            if (value === '' || (/^\d+$/.test(value) && parseInt(value) >= 0 && parseInt(value) <= 100)) {
              patientEditor.setEditPatientAge(value);
            }
          }}
          onKeyDown={(e) => {
            if (!/[0-9]/.test(e.key) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) {
              e.preventDefault();
            }
          }}
          className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Gender */}
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
          Gender <span style={{ color: UI_COLORS.text.error }}>*</span>
        </label>
        <Input
          value={patientEditor.editPatientGender}
          onChange={(e) => patientEditor.setEditPatientGender(e.target.value)}
          maxLength={50}
          className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Voice */}
      <div>
        <VoicePreview
          value={patientEditor.editPatientVoiceId}
          onChange={(voiceId) => patientEditor.setEditPatientVoiceId(voiceId)}
        />
      </div>

      {/* ─── Prompt Section ─── */}
      <div className="space-y-5">
        {/* Text Prompt */}
        <div
          className="rounded-lg p-4"
          style={{
            border: '1px solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white,
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <MessageSquareText className="w-4 h-4" style={{ color: UI_COLORS.promptMode.textIcon }} />
            <label className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>
              Text Prompt
            </label>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: UI_COLORS.promptMode.textBadgeBg, color: UI_COLORS.promptMode.textBadgeText }}
            >
              Text mode
            </span>
          </div>
          <p className="text-xs mb-3" style={{ color: UI_COLORS.text.muted }}>
            Character brief for the text model. Include identity, emotional state, information reveal rules, and conditional logic. Structure and bullet points are fine here.
          </p>
          <textarea
            value={patientEditor.editPatientPrompt}
            onChange={(e) => patientEditor.setEditPatientPrompt(e.target.value)}
            className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
            style={{
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: UI_COLORS.border.default,
              outlineColor: UI_COLORS.border.medium,
              minHeight: '140px',
            }}
            placeholder="Leave empty to use the default persona prompt. The AI will use only information from uploaded documents without inventing symptoms or history."
          />
          <div className="flex justify-end mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const defaultPrompt = await instructorService.getDefaultPersonaPrompt();
                if (defaultPrompt) {
                  patientEditor.setEditPatientPrompt(defaultPrompt);
                }
              }}
            >
              Load Default Prompt
            </Button>
          </div>
          <PromptGuidanceToggle mode="text" />
        </div>

        {/* Voice Prompt */}
        <div
          className="rounded-lg p-4"
          style={{
            border: '1px solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white,
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Mic className="w-4 h-4" style={{ color: UI_COLORS.promptMode.voiceIcon }} />
            <label className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>
              Voice Prompt
            </label>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: UI_COLORS.promptMode.voiceBadgeBg, color: UI_COLORS.promptMode.voiceBadgeText }}
            >
              Voice mode
            </span>
          </div>
          <p className="text-xs mb-3" style={{ color: UI_COLORS.text.muted }}>
            Instructions for the voice model describing how this persona sounds and speaks. Use plain prose: no bullets or headers. Leave blank to reuse the text prompt above.
          </p>
          <textarea
            value={patientEditor.editVoicePersonaPrompt}
            onChange={(e) => patientEditor.setEditVoicePersonaPrompt(e.target.value)}
            className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
            style={{
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: UI_COLORS.border.default,
              outlineColor: UI_COLORS.border.medium,
              minHeight: '140px',
            }}
            placeholder="Describe how this persona sounds and speaks in real time: their pace, filler words, emotional tone, and any physical vocal cues. Write in plain prose, one instruction per sentence. Keep it under 150 words."
          />
          <PromptGuidanceToggle mode="voice" />
        </div>
      </div>

      {/* Patient Photo */}
      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
          Photo
        </label>
        <div className="flex items-center gap-4">
          <UserAvatar
            name={patientEditor.editPatientName || 'P'}
            imageUrl={patientEditor.editPatientProfilePicUrl || (patientEditor.selectedPatientForEdit && patientEditor.selectedPatientForEdit !== 'new' ? profilePictures[patientEditor.selectedPatientForEdit] : undefined)}
            size="large"
          />
          <label className={`cursor-pointer ${!canAttachAssets ? 'pointer-events-none opacity-50' : ''}`}>
            <input
              type="file"
              accept="image/*"
              onChange={patientEditor.handlePhotoUpload}
              className="hidden"
              disabled={!canAttachAssets}
            />
            <div
              className="p-3 rounded-full transition-colors"
              style={{
                backgroundColor: UI_COLORS.background.tableHeader,
                color: UI_COLORS.text.body
              }}
            >
              <Camera className="w-6 h-6" />
            </div>
          </label>
          {patientEditor.selectedPatientForEdit && patientEditor.selectedPatientForEdit !== 'new' && (patientEditor.editPatientProfilePicUrl || profilePictures[patientEditor.selectedPatientForEdit]) && (
            <button
              onClick={patientEditor.handlePhotoDelete}
              className="p-3 rounded-full transition-colors"
              style={{ backgroundColor: UI_COLORS.background.tableHeader, color: UI_COLORS.text.body }}
              title="Remove photo"
            >
              <Trash2 className="w-6 h-6" />
            </button>
          )}
        </div>
        {!canAttachAssets && (
          <p className="text-xs mt-2" style={{ color: UI_COLORS.text.muted }}>
            Add a name, age, and gender first.
          </p>
        )}
      </div>

      {/* File Upload Sections */}
      <div className="space-y-4">
        {patientEditor.filesLoading && (
          <div className="flex items-center gap-2 p-3 rounded-lg" style={{ backgroundColor: UI_COLORS.background.tableHeader }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: UI_COLORS.text.muted }} />
            <span className="text-sm" style={{ color: UI_COLORS.text.body }}>Loading patient files…</span>
          </div>
        )}
        {!canAttachAssets && (
          <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>
            Add a name, age, and gender first to upload files.
          </p>
        )}
        {([
          { label: 'LLM Upload', type: 'llm' as const, description: 'Document used by the AI to roleplay as this patient.' },
          { label: 'Patient Information', type: 'patientInfo' as const, description: 'Medical record for this patient. This document is visible to students.' },
          // Answer key file upload disabled — replaced by DTP/Recommendations Bank approach
          /* { label: 'Answer Key', type: 'answerKey' as const, description: 'Reference answers for debrief evaluation.' }, */
        ]).map(({ label, type, description }) => (
          <div key={type} className="p-4 border rounded-lg space-y-3" style={{ borderColor: UI_COLORS.border.default }}>
            {/* Header row: label + status + upload button */}
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium" style={{ color: UI_COLORS.text.heading }}>
                  {label}
                </span>
                <p className="text-xs mt-0.5" style={{ color: UI_COLORS.text.muted }}>{description}</p>
              </div>
              <div className="flex items-center gap-2">
                {patientEditor.uploadStatus[type] === 'uploading' && <Loader2 className="w-4 h-4 animate-spin" style={{ color: UI_COLORS.text.muted }} />}
                {patientEditor.uploadStatus[type] === 'success' && <span className="flex items-center gap-1 text-sm" style={{ color: '#16a34a' }}><CheckCircle className="w-4 h-4" /> Uploaded</span>}
                {patientEditor.uploadStatus[type] === 'error' && <span className="flex items-center gap-1 text-sm" style={{ color: '#dc2626' }}><XCircle className="w-4 h-4" /> Failed</span>}
                <label className={`cursor-pointer ${(patientEditor.uploadStatus[type] === 'uploading' || patientEditor.filesLoading || !canAttachAssets) ? 'pointer-events-none opacity-50' : ''}`}>
                  <input
                    type="file"
                    onChange={(e) => patientEditor.handleFileUpload(type, e)}
                    className="hidden"
                    disabled={patientEditor.filesLoading || !canAttachAssets}
                  />
                  <div
                    className="p-2 rounded-lg transition-colors flex items-center gap-2"
                    style={{
                      backgroundColor: UI_COLORS.background.tableHeader,
                      color: UI_COLORS.text.body
                    }}
                  >
                    <Upload className="w-5 h-5" />
                    Upload
                  </div>
                </label>
              </div>
            </div>

            {/* Uploaded files list / inline preview */}
            {patientEditor.uploadedFiles[type].length > 0 && (
              <div className="pt-1">
                {previewFile && patientEditor.uploadedFiles[type].some(f => f.filename === previewFile.filename) ? (
                  <div className="flex flex-col">
                    <button
                      onClick={() => setPreviewFile(null)}
                      className="flex items-center gap-1 text-sm mb-3 bg-transparent border-0 cursor-pointer p-0 transition-colors"
                      style={{ color: UI_COLORS.text.body }}
                      onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
                      onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back to files
                    </button>
                    <h4 className="font-semibold text-sm mb-2" style={{ color: UI_COLORS.text.heading }}>
                      {previewFile.displayName || previewFile.filename}
                    </h4>
                    {previewFile.url ? (
                      <iframe
                        src={previewFile.url}
                        title={previewFile.displayName || previewFile.filename}
                        className="w-full rounded border"
                        style={{ borderColor: UI_COLORS.border.default, minHeight: '400px' }}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>No preview available for this file.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {patientEditor.uploadedFiles[type].map((file) => (
                      <FileDisplayNameRow
                        key={file.filename}
                        file={file}
                        fileType={type}
                        ingestionStatus={patientEditor.ingestionStatus[type]?.[file.filename]}
                        onSaveDisplayName={patientEditor.handleDisplayNameSave}
                        onDelete={patientEditor.handleFileDelete}
                        onPreview={setPreviewFile}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Save Button */}
      <div className="pt-4">
        <Button
          onClick={onSavePatient}
          className="px-8 py-3 text-base font-medium transition-colors"
          style={{
            backgroundColor: UI_COLORS.button.primary,
            color: UI_COLORS.button.text
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}


/* ─── Prompt Guidance Toggle ─── */

function PromptGuidanceToggle({ mode }: { mode: 'text' | 'voice' }) {
  const [open, setOpen] = useState(false);

  const textGuidance = (
    <ul className="list-disc pl-4 space-y-1 text-xs" style={{ color: UI_COLORS.text.body }}>
      <li><strong>Identity & presentation</strong>: name, age, emotional tone, how they come across</li>
      <li><strong>Information reveal rules</strong>: what they volunteer vs. withhold until asked</li>
      <li><strong>Behavioral rules (conditionals OK)</strong>: "Only mention X if asked about Y"</li>
      <li><strong>Their own language</strong>: how they refer to things in lay terms</li>
      <li><strong>Relationship & trust level</strong>: how they relate to the person they're speaking with</li>
      <li className="pt-1" style={{ color: UI_COLORS.text.muted }}><em>Don't include:</em> factual details already in uploaded documents, or speech-style instructions (irrelevant for text)</li>
    </ul>
  );

  const voiceGuidance = (
    <ul className="list-disc pl-4 space-y-1 text-xs" style={{ color: UI_COLORS.text.body }}>
      <li><strong>Speech pace & filler words</strong>: "speaks slowly", "uses 'um' and 'you know'"</li>
      <li><strong>Physical sound cues</strong>: "slightly breathless", "voice cracks when emotional"</li>
      <li><strong>Emotional tone as heard</strong>: "sounds anxious", "flat and tired", "defensive"</li>
      <li><strong>Lay terminology</strong>: avoid jargon the voice AI may mispronounce</li>
      <li><strong>Simple behavioral rules (1 sentence each)</strong>: "Don't mention X unless asked"</li>
      <li className="pt-1" style={{ color: UI_COLORS.text.muted }}><em>Don't include:</em> bullet points or headers (plain prose only), complex conditional logic, jargon, or long backstory</li>
    </ul>
  );

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs transition-colors bg-transparent border-0 cursor-pointer p-0"
        style={{ color: UI_COLORS.text.muted }}
        onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
        onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.muted}
      >
        <Info className="w-3 h-3" />
        {open ? 'Hide writing tips' : 'Writing tips'}
      </button>
      {open && (
        <div
          className="mt-2 p-3 rounded-lg"
          style={{ backgroundColor: UI_COLORS.background.tableHeader }}
        >
          {mode === 'text' ? textGuidance : voiceGuidance}
        </div>
      )}
    </div>
  );
}


/* ─── Ingestion Status Badge ─── */

function IngestionStatusBadge({
  status,
}: {
  status?: import('@/services/instructorService').IngestionStatusOrQueued;
}) {
  // 'not processing' means the file isn't part of the RAG index (nothing to show).
  if (!status || status === 'not processing') return null;

  const base = 'flex items-center gap-1 text-xs flex-shrink-0 whitespace-nowrap';

  if (status === 'queued' || status === 'processing') {
    return (
      <span className={base} style={{ color: UI_COLORS.text.muted }} title="This document is being processed for the AI to use.">
        <Loader2 className="w-3 h-3 animate-spin" />
        {status === 'queued' ? 'Queued' : 'Processing'}
      </span>
    );
  }

  if (status === 'completed') {
    return (
      <span className={base} style={{ color: '#16a34a' }} title="Ready for the AI to use.">
        <CheckCircle className="w-3 h-3" />
        Ready
      </span>
    );
  }

  // error
  return (
    <span className={base} style={{ color: '#dc2626' }} title="Processing failed. Delete and re-upload this document to retry.">
      <XCircle className="w-3 h-3" />
      Failed
    </span>
  );
}


/* ─── File Display Name Row ─── */

function FileDisplayNameRow({
  file,
  fileType,
  ingestionStatus,
  onSaveDisplayName,
  onDelete,
  onPreview,
}: {
  file: import('@/services/instructorService').UploadedFileInfo;
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  fileType: 'llm' | 'patientInfo' /* | 'answerKey' */;
  ingestionStatus?: import('@/services/instructorService').IngestionStatusOrQueued;
  onSaveDisplayName: (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string, displayName: string) => Promise<void>;
  onDelete: (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string) => Promise<void>;
  onPreview: (file: import('@/services/instructorService').UploadedFileInfo) => void;
}) {
  const [localName, setLocalName] = useState(file.displayName || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleBlur = async () => {
    if (localName === (file.displayName || '')) return;
    setSaving(true);
    try {
      await onSaveDisplayName(fileType, file.filename, localName);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex items-start gap-3 p-3 rounded-lg"
      style={{ backgroundColor: UI_COLORS.background.tableHeader }}
    >
      <FileText className="w-4 h-4 mt-1 flex-shrink-0" style={{ color: UI_COLORS.text.muted }} />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs truncate" style={{ color: UI_COLORS.text.muted }} title={file.filename}>
            {file.filename}
          </p>
          <IngestionStatusBadge status={ingestionStatus} />
        </div>
        <div className="flex items-center gap-2">
          {/* Display name only applies to patient info files (visible to students) */}
          {fileType === 'patientInfo' && (
            <>
              <Input
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="Enter display name..."
                className="h-8 text-sm flex-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                style={{
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: UI_COLORS.border.default,
                  backgroundColor: UI_COLORS.background.white,
                }}
              />
              {saving && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" style={{ color: UI_COLORS.text.muted }} />}
              {saved && <CheckCircle className="w-3 h-3 flex-shrink-0" style={{ color: '#16a34a' }} />}
            </>
          )}
          {fileType !== 'patientInfo' && <div className="flex-1" />}
          <button
            onClick={() => onPreview(file)}
            className="p-1 rounded transition-colors flex-shrink-0"
            style={{ color: UI_COLORS.text.muted }}
            onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
            onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.muted}
            title="Preview file"
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(fileType, file.filename)}
            className="p-1 rounded transition-colors flex-shrink-0"
            style={{ color: UI_COLORS.text.muted }}
            onMouseEnter={(e) => e.currentTarget.style.color = '#dc2626'}
            onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.muted}
            title="Delete file"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}


/* ─── Questions Tab ─── */

function QuestionsTab({
  patientEditor,
  caseQuestionSearchQuery,
  onCaseQuestionSearchChange,
  filteredCaseQuestions,
  globalRubricSearchQuery,
  onGlobalRubricSearchChange,
  filteredGlobalRubric,
  onSaveCaseQuestion,
  onDeleteCaseQuestion,
}: {
  patientEditor: UsePatientEditorReturn;
  caseQuestionSearchQuery: string;
  onCaseQuestionSearchChange: (query: string) => void;
  filteredCaseQuestions: GlobalRubricQuestion[];
  globalRubricSearchQuery: string;
  onGlobalRubricSearchChange: (query: string) => void;
  filteredGlobalRubric: GlobalRubricQuestion[];
  onSaveCaseQuestion: (patientId: string, question: GlobalRubricQuestion) => void;
  onDeleteCaseQuestion: (patientId: string, questionId: string) => void;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; questionId: string; questionTitle: string }>({
    open: false, questionId: '', questionTitle: ''
  });

  const handleConfirmDeleteCaseQuestion = () => {
    if (patientEditor.selectedPatientForEdit && deleteConfirm.questionId) {
      onDeleteCaseQuestion(patientEditor.selectedPatientForEdit, deleteConfirm.questionId);
      patientEditor.setCaseSpecificQuestions(patientEditor.caseSpecificQuestions.filter(q => q.id !== deleteConfirm.questionId));
    }
    setDeleteConfirm({ open: false, questionId: '', questionTitle: '' });
  };

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Remove Case Question
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove "<span className="font-medium">{deleteConfirm.questionTitle}</span>" from this patient? This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button
              onClick={() => setDeleteConfirm(prev => ({ ...prev, open: false }))}
              variant="outline"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDeleteCaseQuestion}
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>
        Case-Specific Key Questions
      </h2>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
        <Input
          placeholder="Search Key Questions"
          value={caseQuestionSearchQuery}
          onChange={(e) => onCaseQuestionSearchChange(e.target.value)}
          className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Case-Specific Questions */}
      <div className="space-y-4">
        <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
          Click on a Key Question entry to expand and edit it.
        </p>

        <Accordion type="single" collapsible className="space-y-2">
          {filteredCaseQuestions.map((question, index) => (
            <AccordionItem
              key={question.id}
              value={question.id}
              style={{
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: UI_COLORS.border.default,
                borderRadius: '0.5rem',
                overflow: 'hidden'
              }}
            >
              <AccordionTrigger
                className="px-4 hover:no-underline"
                style={{
                  backgroundColor: UI_COLORS.background.white,
                  color: UI_COLORS.text.heading
                }}
              >
                <div className="flex items-center justify-between w-full pr-4">
                  <span className="font-medium">
                    Q{index + 1} - {question.title}
                  </span>
                  <span className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                    {question.required ? 'Required' : 'Optional'}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent
                className="px-4 pb-4"
                style={{ backgroundColor: UI_COLORS.background.white }}
              >
                <div className="space-y-4 pt-4">
                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Title
                    </label>
                    <Input
                      value={question.title}
                      onChange={(e) => {
                        const updatedQuestions = patientEditor.caseSpecificQuestions.map(q =>
                          q.id === question.id ? { ...q, title: e.target.value } : q
                        );
                        patientEditor.setCaseSpecificQuestions(updatedQuestions);
                      }}
                      placeholder="Chest Pain Characterization"
                      maxLength={150}
                      className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        backgroundColor: UI_COLORS.background.white
                      }}
                    />
                  </div>

                  {/* Key Question */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Key Question
                    </label>
                    <textarea
                      value={question.keyQuestion}
                      onChange={(e) => {
                        const updatedQuestions = patientEditor.caseSpecificQuestions.map(q =>
                          q.id === question.id ? { ...q, keyQuestion: e.target.value } : q
                        );
                        patientEditor.setCaseSpecificQuestions(updatedQuestions);
                      }}
                      placeholder="Assess the characteristics of the patient's chest pain..."
                      maxLength={5000}
                      className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        outlineColor: UI_COLORS.border.medium,
                        minHeight: '100px',
                      }}
                    />
                  </div>

                  {/* Clinical Intent */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Clinical Intent
                    </label>
                    <textarea
                      value={question.clinicalIntent}
                      onChange={(e) => {
                        const updatedQuestions = patientEditor.caseSpecificQuestions.map(q =>
                          q.id === question.id ? { ...q, clinicalIntent: e.target.value } : q
                        );
                        patientEditor.setCaseSpecificQuestions(updatedQuestions);
                      }}
                      placeholder="This question evaluates the student's ability..."
                      maxLength={5000}
                      className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        outlineColor: UI_COLORS.border.medium,
                        minHeight: '100px',
                      }}
                    />
                  </div>

                  {/* Evaluation Criteria */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Evaluation Criteria
                    </label>
                    <textarea
                      value={question.evaluationCriteria}
                      onChange={(e) => {
                        const updatedQuestions = patientEditor.caseSpecificQuestions.map(q =>
                          q.id === question.id ? { ...q, evaluationCriteria: e.target.value } : q
                        );
                        patientEditor.setCaseSpecificQuestions(updatedQuestions);
                      }}
                      placeholder="The student attempts to identify at least 3-4 of the following..."
                      maxLength={5000}
                      className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        outlineColor: UI_COLORS.border.medium,
                        minHeight: '150px',
                      }}
                    />
                  </div>

                  {/* Required Toggle */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={question.required}
                      onClick={() => {
                        const updatedQuestions = patientEditor.caseSpecificQuestions.map(q =>
                          q.id === question.id ? { ...q, required: !q.required } : q
                        );
                        patientEditor.setCaseSpecificQuestions(updatedQuestions);
                      }}
                      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                      style={{
                        backgroundColor: question.required ? UI_COLORS.toggle.active : UI_COLORS.toggle.inactive
                      }}
                    >
                      <span
                        className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
                        style={{
                          transform: question.required ? 'translateX(22px)' : 'translateX(2px)'
                        }}
                      />
                    </button>
                    <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
                      Required for Case Completion
                    </span>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-4 pt-4">
                    <Button
                      onClick={() => {
                        if (patientEditor.selectedPatientForEdit) {
                          onSaveCaseQuestion(patientEditor.selectedPatientForEdit, question);
                        }
                      }}
                      className="px-8 py-3 text-base font-medium transition-colors"
                      style={{
                        backgroundColor: UI_COLORS.button.primary,
                        color: UI_COLORS.button.text
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                    >
                      Save
                    </Button>
                    <Button
                      onClick={() => {
                        if (patientEditor.selectedPatientForEdit) {
                          setDeleteConfirm({ open: true, questionId: question.id, questionTitle: question.title });
                        }
                      }}
                      variant="outline"
                      className="px-8 py-3 text-base font-medium transition-colors text-white"
                      style={{
                        backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[0],
                        borderColor: SIMULATION_GROUP_COLOR_PALETTE[0],
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                      onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      {/* Divider */}
      <div className="my-8" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }} />

      {/* Group-Wide Key Questions Section */}
      <div className="space-y-4">
        <h3 className="font-semibold text-lg" style={{ color: UI_COLORS.text.heading }}>
          GROUP-WIDE KEY QUESTIONS
        </h3>
        <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
          The following group-wide questions are shown for reference to prevent redundancy. Edit group-wide questions from the Group-Wide Key Questions tab.
        </p>

        {/* Search Bar for Group-Wide Questions */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
          <Input
            placeholder="Search Group-Wide Questions"
            value={globalRubricSearchQuery}
            onChange={(e) => onGlobalRubricSearchChange(e.target.value)}
            className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
            style={{
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: UI_COLORS.border.default,
              backgroundColor: UI_COLORS.background.white
            }}
          />
        </div>

        <Accordion type="single" collapsible className="space-y-2">
          {filteredGlobalRubric.map((question, index) => (
            <AccordionItem
              key={question.id}
              value={question.id}
              style={{
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: UI_COLORS.border.default,
                borderRadius: '0.5rem',
                overflow: 'hidden',
                opacity: 0.7,
              }}
            >
              <AccordionTrigger
                className="px-4 hover:no-underline"
                style={{
                  backgroundColor: UI_COLORS.background.tableHeader,
                  color: UI_COLORS.text.heading
                }}
              >
                <div className="flex items-center justify-between w-full pr-4">
                  <span className="font-medium text-sm">
                    Q{index + 1} - {question.title}
                  </span>
                  <span className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                    {question.required ? 'Required' : 'Optional'}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent
                className="px-4 pb-4"
                style={{ backgroundColor: UI_COLORS.background.white }}
              >
                <div className="space-y-4 pt-4">
                  {[
                    { label: 'Title', value: question.title, minHeight: undefined },
                    { label: 'Key Question', value: question.keyQuestion, minHeight: '150px' },
                    { label: 'Clinical Intent', value: question.clinicalIntent, minHeight: '100px' },
                    { label: 'Evaluation Criteria', value: question.evaluationCriteria, minHeight: '100px' },
                  ].map(({ label, value, minHeight }) => (
                    <div key={label}>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>{label}</label>
                      <div
                        className="w-full px-3 py-3 rounded-lg text-base whitespace-pre-wrap"
                        style={{
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: UI_COLORS.border.default,
                          backgroundColor: UI_COLORS.background.hoverLight,
                          color: UI_COLORS.text.body,
                          minHeight,
                        }}
                      >
                        {value}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
                      {question.required ? 'Required for Case Completion' : 'Optional'}
                    </span>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}


/* ─── Materials Tab ─── */

function MaterialsTab({
  patientEditor,
  materialSearchQuery,
  onMaterialSearchChange,
  filteredMaterials,
}: {
  patientEditor: UsePatientEditorReturn;
  materialSearchQuery: string;
  onMaterialSearchChange: (query: string) => void;
  filteredMaterials: CaseMaterial[];
}) {
  const { showNotification } = useNotification();
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; materialId: string; materialTitle: string }>({
    open: false, materialId: '', materialTitle: ''
  });

  const handleConfirmDeleteMaterial = async () => {
    if (patientEditor.selectedPatientForEdit && deleteConfirm.materialId) {
      try {
        await instructorService.deleteCaseMaterial(patientEditor.selectedPatientForEdit, deleteConfirm.materialId);
        patientEditor.setCaseMaterials(patientEditor.caseMaterials.filter(m => m.id !== deleteConfirm.materialId));
        showNotification({ message: 'Material deleted successfully', type: 'success' });
      } catch (error) {
        console.error('Failed to delete material:', error);
        showNotification({ message: 'Failed to delete material', type: 'error' });
      }
    }
    setDeleteConfirm({ open: false, materialId: '', materialTitle: '' });
  };

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Delete Material
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to delete "<span className="font-medium">{deleteConfirm.materialTitle}</span>"? This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button
              onClick={() => setDeleteConfirm(prev => ({ ...prev, open: false }))}
              variant="outline"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDeleteMaterial}
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>
        Physical Assessment Materials
      </h2>

      {/* Add New Material Button */}
      <div className="mb-6">
        <Button
          onClick={patientEditor.handleAddNewCaseMaterial}
          className="justify-start gap-2 py-2.5 h-auto font-medium transition-colors"
          style={{
            backgroundColor: UI_COLORS.button.primary,
            color: UI_COLORS.button.text
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
        >
          <Plus className="w-5 h-5" />
          Add new Material
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
        <Input
          placeholder="Search Materials"
          value={materialSearchQuery}
          onChange={(e) => onMaterialSearchChange(e.target.value)}
          className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: UI_COLORS.border.default,
            backgroundColor: UI_COLORS.background.white
          }}
        />
      </div>

      {/* Materials Accordion */}
      <div className="space-y-4">
        <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
          Click on a Material entry to expand and edit it.
        </p>

        <Accordion type="single" collapsible className="space-y-2">
          {filteredMaterials.map((material) => (
            <AccordionItem
              key={material.id}
              value={material.id}
              style={{
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: UI_COLORS.border.default,
                borderRadius: '0.5rem',
                overflow: 'hidden'
              }}
            >
              <AccordionTrigger
                className="px-4 hover:no-underline"
                style={{
                  backgroundColor: UI_COLORS.background.white,
                  color: UI_COLORS.text.heading
                }}
              >
                <div className="flex items-center justify-between w-full pr-4">
                  <span className="font-medium">
                    {material.title}
                  </span>
                  <span className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                    {material.materialType}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent
                className="px-4 pb-4"
                style={{ backgroundColor: UI_COLORS.background.white }}
              >
                <div className="space-y-4 pt-4">
                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Title
                    </label>
                    <Input
                      value={material.title}
                      onChange={(e) => {
                        const updatedMaterials = patientEditor.caseMaterials.map(m =>
                          m.id === material.id ? { ...m, title: e.target.value } : m
                        );
                        patientEditor.setCaseMaterials(updatedMaterials);
                      }}
                      placeholder="Chest X-Ray"
                      className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        backgroundColor: UI_COLORS.background.white
                      }}
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Description
                    </label>
                    <textarea
                      value={material.description}
                      onChange={(e) => {
                        const updatedMaterials = patientEditor.caseMaterials.map(m =>
                          m.id === material.id ? { ...m, description: e.target.value } : m
                        );
                        patientEditor.setCaseMaterials(updatedMaterials);
                      }}
                      placeholder="Frontal chest radiograph obtained as part of the patient's clinical evaluation."
                      className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        outlineColor: UI_COLORS.border.medium,
                        minHeight: '80px',
                      }}
                    />
                  </div>

                  {/* Material Type */}
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                      Material Type
                    </label>
                    <select
                      value={material.materialType}
                      onChange={(e) => {
                        const updatedMaterials = patientEditor.caseMaterials.map(m =>
                          m.id === material.id ? { ...m, materialType: e.target.value as CaseMaterial['materialType'] } : m
                        );
                        patientEditor.setCaseMaterials(updatedMaterials);
                      }}
                      className="w-full px-3 py-3 rounded-lg text-base focus:outline-none focus:ring-2"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        backgroundColor: UI_COLORS.background.white,
                        outlineColor: UI_COLORS.border.medium,
                      }}
                    >
                      <option value="kaltura">Kaltura</option>
                      <option value="panopto">Panopto</option>
                      <option value="h5p">H5P</option>
                    </select>
                  </div>

                  {/* Embed Link or Code */}
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: UI_COLORS.text.body }}>
                      Embed Link or Code
                    </label>
                    <p className="text-xs mb-2" style={{ color: UI_COLORS.text.muted }}>
                      Paste a URL or full embed code (e.g. {'<iframe ...>'}). Aspect ratio is auto-detected from embed dimensions.
                    </p>
                    <textarea
                      value={material.embedLink || ''}
                      onChange={(e) => {
                        const updatedMaterials = patientEditor.caseMaterials.map(m =>
                          m.id === material.id ? { ...m, embedLink: e.target.value } : m
                        );
                        patientEditor.setCaseMaterials(updatedMaterials);
                      }}
                      placeholder={'https://... or <iframe src="..." width="800" height="600"></iframe>'}
                      rows={3}
                      className="w-full px-3 py-3 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 resize-y"
                      style={{
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: UI_COLORS.border.default,
                        backgroundColor: UI_COLORS.background.white,
                        minHeight: '72px',
                      }}
                    />
                  </div>

                  {/* Preview */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="w-5 h-5" style={{ color: UI_COLORS.text.body }} />
                      <span className="font-medium" style={{ color: UI_COLORS.text.heading }}>Preview</span>
                    </div>
                    {material.embedLink ? (
                      material.embedLink.trimStart().toLowerCase().startsWith('<iframe') ? (
                        <div
                          className="embed-responsive rounded-lg overflow-hidden"
                          style={{
                            position: 'relative',
                            width: '100%',
                            aspectRatio: (() => {
                              const match = material.embedLink!.match(/width=["']?(\d+)["']?/i);
                              const matchH = material.embedLink!.match(/height=["']?(\d+)["']?/i);
                              const w = match ? parseInt(match[1], 10) : 0;
                              const h = matchH ? parseInt(matchH[1], 10) : 0;
                              return w > 0 && h > 0 ? `${w} / ${h}` : '16 / 9';
                            })(),
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            borderColor: UI_COLORS.border.default,
                          }}
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(material.embedLink, { ALLOWED_TAGS: ['iframe'], ALLOWED_ATTR: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'title', 'style'] }) }}
                        />
                      ) : (
                        <div
                          className="rounded-lg overflow-hidden"
                          style={{
                            position: 'relative',
                            width: '100%',
                            paddingBottom: '56.25%',
                            height: 0,
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            borderColor: UI_COLORS.border.default,
                          }}
                        >
                          <iframe
                            src={material.embedLink}
                            title={material.title || 'Preview'}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 0 }}
                            allowFullScreen
                            allow="autoplay *; fullscreen *; encrypted-media *"
                            sandbox="allow-downloads allow-forms allow-same-origin allow-scripts allow-top-navigation allow-pointer-lock allow-popups allow-modals allow-orientation-lock allow-popups-to-escape-sandbox allow-presentation allow-top-navigation-by-user-activation"
                          />
                        </div>
                      )
                    ) : (
                      <div
                        className="border rounded-lg p-8 flex items-center justify-center"
                        style={{ borderColor: UI_COLORS.border.default, minHeight: '120px' }}
                      >
                        <p className="text-sm italic" style={{ color: UI_COLORS.text.muted }}>Enter an embed link or code above to see a preview</p>
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-4 pt-4">
                    <Button
                      onClick={() => {
                        if (patientEditor.selectedPatientForEdit) {
                          patientEditor.setSelectedMaterialId(material.id);
                          patientEditor.handleSaveCaseMaterial();
                        }
                      }}
                      className="px-8 py-3 text-base font-medium transition-colors"
                      style={{
                        backgroundColor: UI_COLORS.button.primary,
                        color: UI_COLORS.button.text
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                    >
                      Save
                    </Button>
                    <Button
                      onClick={() => {
                        setDeleteConfirm({ open: true, materialId: material.id, materialTitle: material.title });
                      }}
                      variant="outline"
                      className="px-8 py-3 text-base font-medium transition-colors text-white"
                      style={{
                        backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[0],
                        borderColor: SIMULATION_GROUP_COLOR_PALETTE[0],
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                      onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}


/* ─── Patient-Specific DTPs Tab ─── */

function PatientDTPsTab({
  patientEditor,
  patientDTPs,
  groupDTPs,
  onUpdatePatientDTP,
  onDeletePatientDTP,
  onLoadPatientDTPs,
}: {
  patientEditor: UsePatientEditorReturn;
  patientDTPs: DTPAssignment[];
  groupDTPs: DTPAssignment[];
  onUpdatePatientDTP?: (dtpId: string, data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => Promise<void>;
  onDeletePatientDTP?: (patientId: string, groupDtpId: string) => Promise<void>;
  onLoadPatientDTPs?: (patientId: string) => void;
}) {
  const { showNotification } = useNotification();
  const [searchQuery, setSearchQuery] = useState('');

  // Local editable state for existing DTPs
  const [editableDTPs, setEditableDTPs] = useState<DTPAssignment[]>([]);

  const patientId = patientEditor.selectedPatientForEdit;

  // Load DTPs when tab is shown
  useEffect(() => {
    if (patientId && patientId !== 'new' && onLoadPatientDTPs) {
      onLoadPatientDTPs(patientId);
    }
  }, [patientId]);

  // Sync local editable state when patientDTPs changes
  useEffect(() => {
    setEditableDTPs(patientDTPs);
  }, [patientDTPs]);

  const filteredDTPs = editableDTPs.filter(d =>
    (d.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleDelete = async (groupDtpId: string) => {
    if (!patientId || !onDeletePatientDTP) return;
    await onDeletePatientDTP(patientId, groupDtpId);
    setDeleteConfirm({ open: false, groupDtpId: '', dtpTitle: '' });
  };

  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; groupDtpId: string; dtpTitle: string }>({
    open: false, groupDtpId: '', dtpTitle: ''
  });

  const handleSaveExisting = async (dtp: DTPAssignment) => {
    if (!onUpdatePatientDTP || !dtp.dtpId) return;
    try {
      await onUpdatePatientDTP(dtp.dtpId, {
        title: dtp.title || '',
        expectedDTPText: dtp.expectedDTPText || '',
        clinicalIntent: dtp.clinicalIntent || '',
        evaluationCriteria: dtp.evaluationCriteria || '',
        tags: dtp.tags || [],
        isRequired: dtp.isRequired || false,
      });
      showNotification({ message: 'DTP saved successfully.', type: 'success' });
    } catch {
      showNotification({ message: 'Failed to save DTP.', type: 'error' });
    }
  };

  const updateEditableDTP = (groupDtpId: string, updates: Partial<DTPAssignment>) => {
    setEditableDTPs(prev => prev.map(d => d.groupDtpId === groupDtpId ? { ...d, ...updates } : d));
  };

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Remove DTP
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove "<span className="font-medium">{deleteConfirm.dtpTitle}</span>" from this patient? This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button
              onClick={() => setDeleteConfirm(prev => ({ ...prev, open: false }))}
              variant="outline"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => handleDelete(deleteConfirm.groupDtpId)}
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>
        Patient-Specific DTPs
      </h2>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
        <Input
          placeholder="Search DTPs"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }}
        />
      </div>

      {/* Existing DTPs — Inline Editable */}
      <div className="space-y-4">
        <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
          Click on a DTP entry to expand and edit it.
        </p>

        {filteredDTPs.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: UI_COLORS.text.muted }}>No patient-specific DTPs yet.</p>
        ) : (
          <Accordion type="single" collapsible className="space-y-2">
            {filteredDTPs.map((dtp, index) => (
              <AccordionItem key={dtp.groupDtpId} value={dtp.groupDtpId} style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, borderRadius: '0.5rem', overflow: 'hidden' }}>
                <AccordionTrigger className="px-4 hover:no-underline" style={{ backgroundColor: UI_COLORS.background.white, color: UI_COLORS.text.heading }}>
                  <div className="flex items-center justify-between w-full pr-4">
                    <span className="font-medium">
                      DTP{index + 1} - {dtp.title || 'Untitled DTP'}
                    </span>
                    <span className="text-xs" style={{ color: UI_COLORS.text.muted }}>{dtp.isRequired ? 'Required' : 'Optional'}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4" style={{ backgroundColor: UI_COLORS.background.white }}>
                  <div className="space-y-4 pt-4">
                    {/* Title */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Title</label>
                      <Input
                        value={dtp.title || ''}
                        onChange={(e) => updateEditableDTP(dtp.groupDtpId, { title: e.target.value })}
                        placeholder="DTP Title"
                        maxLength={150}
                        className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }}
                      />
                    </div>

                    {/* Expected DTP Text */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Expected DTP Text</label>
                      <textarea
                        value={dtp.expectedDTPText || ''}
                        onChange={(e) => updateEditableDTP(dtp.groupDtpId, { expectedDTPText: e.target.value })}
                        placeholder="Describe the expected drug therapy problem..."
                        maxLength={5000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '100px' }}
                      />
                    </div>

                    {/* Clinical Intent */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Clinical Intent</label>
                      <textarea
                        value={dtp.clinicalIntent || ''}
                        onChange={(e) => updateEditableDTP(dtp.groupDtpId, { clinicalIntent: e.target.value })}
                        placeholder="Why this DTP matters clinically..."
                        maxLength={5000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '100px' }}
                      />
                    </div>

                    {/* Evaluation Criteria */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Evaluation Criteria</label>
                      <textarea
                        value={dtp.evaluationCriteria || ''}
                        onChange={(e) => updateEditableDTP(dtp.groupDtpId, { evaluationCriteria: e.target.value })}
                        placeholder="How to evaluate the student's identification..."
                        maxLength={5000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '150px' }}
                      />
                    </div>

                    {/* Required Toggle */}
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={dtp.isRequired || false}
                        onClick={() => updateEditableDTP(dtp.groupDtpId, { isRequired: !dtp.isRequired })}
                        className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                        style={{ backgroundColor: dtp.isRequired ? UI_COLORS.toggle.active : UI_COLORS.toggle.inactive }}
                      >
                        <span className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform" style={{ transform: dtp.isRequired ? 'translateX(22px)' : 'translateX(2px)' }} />
                      </button>
                      <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>Required for Case Completion</span>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-4 pt-4">
                      <Button
                        onClick={() => handleSaveExisting(dtp)}
                        className="px-8 py-3 text-base font-medium transition-colors"
                        style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                      >
                        Save
                      </Button>
                      <Button
                        onClick={() => setDeleteConfirm({ open: true, groupDtpId: dtp.groupDtpId, dtpTitle: dtp.title || 'Untitled DTP' })}
                        variant="outline"
                        className="px-8 py-3 text-base font-medium transition-colors text-white"
                        style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[0], borderColor: SIMULATION_GROUP_COLOR_PALETTE[0] }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>

      {/* Group DTPs — Read-Only */}
      {groupDTPs.length > 0 && (
        <>
          <div className="my-8" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }} />
          <div className="space-y-4">
            <h3 className="font-semibold text-lg" style={{ color: UI_COLORS.text.heading }}>
              GROUP-WIDE DTPS
            </h3>
            <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
              The following group-wide DTPs are shown for reference to prevent redundancy. Select which group-wide DTPs to include/exclude in the DTP Bank tab.
            </p>
            <Accordion type="single" collapsible className="space-y-2">
              {groupDTPs.map((dtp, index) => (
                <AccordionItem
                  key={dtp.groupDtpId}
                  value={dtp.groupDtpId}
                  style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, borderRadius: '0.5rem', overflow: 'hidden', opacity: 0.7 }}
                >
                  <AccordionTrigger className="px-4 hover:no-underline" style={{ backgroundColor: UI_COLORS.background.tableHeader, color: UI_COLORS.text.heading }}>
                    <div className="flex items-center justify-between w-full pr-4">
                      <span className="font-medium text-sm">
                        DTP{index + 1} - {dtp.title || 'Untitled DTP'}
                      </span>
                      <span className="text-xs" style={{ color: UI_COLORS.text.muted }}>{dtp.isRequired ? 'Required' : 'Optional'}</span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-4" style={{ backgroundColor: UI_COLORS.background.white }}>
                    <div className="space-y-4 pt-4">
                      {[
                        { label: 'Title', value: dtp.title, minHeight: undefined },
                        { label: 'Expected DTP Text', value: dtp.expectedDTPText, minHeight: '100px' },
                        { label: 'Clinical Intent', value: dtp.clinicalIntent, minHeight: '100px' },
                        { label: 'Evaluation Criteria', value: dtp.evaluationCriteria, minHeight: '100px' },
                      ].map(({ label, value, minHeight }) => (
                        <div key={label}>
                          <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>{label}</label>
                          <div
                            className="w-full px-3 py-3 rounded-lg text-base whitespace-pre-wrap"
                            style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.hoverLight, color: UI_COLORS.text.body, minHeight }}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
                          {dtp.isRequired ? 'Required for Case Completion' : 'Optional'}
                        </span>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </>
      )}
    </div>
  );
}


/* ─── Patient-Specific Recommendations Tab ─── */

function PatientRecommendationsTab({
  patientEditor,
  patientRecommendations,
  groupRecommendations,
  onUpdatePatientRecommendation,
  onDeletePatientRecommendation,
  onLoadPatientRecommendations,
}: {
  patientEditor: UsePatientEditorReturn;
  patientRecommendations: RecommendationAssignment[];
  groupRecommendations: RecommendationAssignment[];
  onUpdatePatientRecommendation?: (recommendationId: string, data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string }) => Promise<void>;
  onDeletePatientRecommendation?: (patientId: string, groupRecommendationId: string) => Promise<void>;
  onLoadPatientRecommendations?: (patientId: string) => void;
}) {
  const { showNotification } = useNotification();
  const [searchQuery, setSearchQuery] = useState('');

  // Local editable state for existing recommendations
  const [editableRecs, setEditableRecs] = useState<RecommendationAssignment[]>([]);

  const patientId = patientEditor.selectedPatientForEdit;

  // Load recommendations when tab is shown
  useEffect(() => {
    if (patientId && patientId !== 'new' && onLoadPatientRecommendations) {
      onLoadPatientRecommendations(patientId);
    }
  }, [patientId]);

  // Sync local editable state when patientRecommendations changes
  useEffect(() => {
    setEditableRecs(patientRecommendations);
  }, [patientRecommendations]);

  const filteredRecs = editableRecs.filter(r =>
    (r.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleDelete = async (groupRecommendationId: string) => {
    if (!patientId || !onDeletePatientRecommendation) return;
    await onDeletePatientRecommendation(patientId, groupRecommendationId);
    setDeleteConfirm({ open: false, groupRecommendationId: '', recTitle: '' });
  };

  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; groupRecommendationId: string; recTitle: string }>({
    open: false, groupRecommendationId: '', recTitle: ''
  });

  const handleSaveExisting = async (rec: RecommendationAssignment) => {
    if (!onUpdatePatientRecommendation || !rec.recommendationId) return;
    try {
      await onUpdatePatientRecommendation(rec.recommendationId, {
        title: rec.title || '',
        recommendationText: rec.recommendationText || '',
        evaluationCriteria: rec.evaluationCriteria || '',
        rationale: rec.rationale || '',
      });
      showNotification({ message: 'Recommendation saved successfully.', type: 'success' });
    } catch {
      showNotification({ message: 'Failed to save recommendation.', type: 'error' });
    }
  };

  const updateEditableRec = (groupRecommendationId: string, updates: Partial<RecommendationAssignment>) => {
    setEditableRecs(prev => prev.map(r => r.groupRecommendationId === groupRecommendationId ? { ...r, ...updates } : r));
  };

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Remove Recommendation
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove "<span className="font-medium">{deleteConfirm.recTitle}</span>" from this patient? This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: UI_COLORS.border.default }}>
            <Button
              onClick={() => setDeleteConfirm(prev => ({ ...prev, open: false }))}
              variant="outline"
              style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => handleDelete(deleteConfirm.groupRecommendationId)}
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>
        Patient-Specific Recommendations
      </h2>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
        <Input
          placeholder="Search Recommendations"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }}
        />
      </div>

      {/* Existing Recommendations — Inline Editable */}
      <div className="space-y-4">
        <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
          Click on a Recommendation entry to expand and edit it.
        </p>

        {filteredRecs.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: UI_COLORS.text.muted }}>No patient-specific recommendations yet.</p>
        ) : (
          <Accordion type="single" collapsible className="space-y-2">
            {filteredRecs.map((rec, index) => (
              <AccordionItem key={rec.groupRecommendationId} value={rec.groupRecommendationId} style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, borderRadius: '0.5rem', overflow: 'hidden' }}>
                <AccordionTrigger className="px-4 hover:no-underline" style={{ backgroundColor: UI_COLORS.background.white, color: UI_COLORS.text.heading }}>
                  <div className="flex items-center justify-between w-full pr-4">
                    <span className="font-medium">
                      R{index + 1} - {rec.title || 'Untitled Recommendation'}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4" style={{ backgroundColor: UI_COLORS.background.white }}>
                  <div className="space-y-4 pt-4">
                    {/* Title */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Title</label>
                      <Input
                        value={rec.title || ''}
                        onChange={(e) => updateEditableRec(rec.groupRecommendationId, { title: e.target.value })}
                        placeholder="Recommendation Title"
                        maxLength={150}
                        className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }}
                      />
                    </div>

                    {/* Recommendation Text */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Recommendation Text</label>
                      <textarea
                        value={rec.recommendationText || ''}
                        onChange={(e) => updateEditableRec(rec.groupRecommendationId, { recommendationText: e.target.value })}
                        placeholder="Describe the recommendation..."
                        maxLength={5000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '100px' }}
                      />
                    </div>

                    {/* Evaluation Criteria */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Evaluation Criteria</label>
                      <textarea
                        value={rec.evaluationCriteria || ''}
                        onChange={(e) => updateEditableRec(rec.groupRecommendationId, { evaluationCriteria: e.target.value })}
                        placeholder="How to evaluate the student's recommendation..."
                        maxLength={50000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '100px' }}
                      />
                    </div>

                    {/* Rationale */}
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>Rationale</label>
                      <textarea
                        value={rec.rationale || ''}
                        onChange={(e) => updateEditableRec(rec.groupRecommendationId, { rationale: e.target.value })}
                        placeholder="Clinical rationale for this recommendation..."
                        maxLength={5000}
                        className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                        style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, outlineColor: UI_COLORS.border.medium, minHeight: '100px' }}
                      />
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-4 pt-4">
                      <Button
                        onClick={() => handleSaveExisting(rec)}
                        className="px-8 py-3 text-base font-medium transition-colors"
                        style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                      >
                        Save
                      </Button>
                      <Button
                        onClick={() => setDeleteConfirm({ open: true, groupRecommendationId: rec.groupRecommendationId, recTitle: rec.title || 'Untitled Recommendation' })}
                        variant="outline"
                        className="px-8 py-3 text-base font-medium transition-colors text-white"
                        style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[0], borderColor: SIMULATION_GROUP_COLOR_PALETTE[0] }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>

      {/* Group Recommendations — Read-Only */}
      {groupRecommendations.length > 0 && (
        <>
          <div className="my-8" style={{ borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: UI_COLORS.border.default }} />
          <div className="space-y-4">
            <h3 className="font-semibold text-lg" style={{ color: UI_COLORS.text.heading }}>
              GROUP-WIDE RECOMMENDATIONS
            </h3>
            <p className="text-xs italic mb-4" style={{ color: UI_COLORS.text.muted }}>
              The following group-wide recommendations are shown for reference to prevent redundancy. Select which group-wide recommendations to include/exclude in the Recommendations Bank tab.
            </p>
            <Accordion type="single" collapsible className="space-y-2">
              {groupRecommendations.map((rec, index) => (
                <AccordionItem
                  key={rec.groupRecommendationId}
                  value={rec.groupRecommendationId}
                  style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, borderRadius: '0.5rem', overflow: 'hidden', opacity: 0.7 }}
                >
                  <AccordionTrigger className="px-4 hover:no-underline" style={{ backgroundColor: UI_COLORS.background.tableHeader, color: UI_COLORS.text.heading }}>
                    <div className="flex items-center justify-between w-full pr-4">
                      <span className="font-medium text-sm">
                        R{index + 1} - {rec.title || 'Untitled Recommendation'}
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-4" style={{ backgroundColor: UI_COLORS.background.white }}>
                    <div className="space-y-4 pt-4">
                      {[
                        { label: 'Title', value: rec.title, minHeight: undefined },
                        { label: 'Recommendation Text', value: rec.recommendationText, minHeight: '100px' },
                        { label: 'Evaluation Criteria', value: rec.evaluationCriteria, minHeight: '100px' },
                        { label: 'Rationale', value: rec.rationale, minHeight: '100px' },
                      ].map(({ label, value, minHeight }) => (
                        <div key={label}>
                          <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>{label}</label>
                          <div
                            className="w-full px-3 py-3 rounded-lg text-base whitespace-pre-wrap"
                            style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.hoverLight, color: UI_COLORS.text.body, minHeight }}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </>
      )}
    </div>
  );
}
