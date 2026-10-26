import { useEffect, useRef, useState } from 'react';
import {
  instructorService,
  type CaseMaterial,
  type GlobalRubricQuestion,
  type IngestionStatusOrQueued,
  type ManageablePatient,
  type UploadedFileInfo,
} from '@/services/instructorService';
import { useNotification } from '@/components/notifications';

export interface UsePatientEditorParams {
  groupId: string | undefined;
  role: 'admin' | 'instructor';
  manageablePatients: ManageablePatient[];
  setManageablePatients: React.Dispatch<React.SetStateAction<any[]>>;
  profilePictures: Record<string, string>;
  setProfilePictures: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  reloadPatients: () => Promise<void>;
}

export interface UsePatientEditorReturn {
  // Form state
  selectedPatientForEdit: string | null;
  editPatientTab: 'info' | 'questions' | 'materials' | 'dtps' | 'recommendations';
  editPatientName: string;
  editPatientAge: string;
  editPatientGender: string;
  editPatientPrompt: string;
  editPatientVoiceId: string;
  editVoicePersonaPrompt: string;
  uploadStatus: Record<string, 'idle' | 'uploading' | 'success' | 'error'>;
  filesLoading: boolean;
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  uploadedFiles: Record<'llm' | 'patientInfo' /* | 'answerKey' */, UploadedFileInfo[]>;
  // Live ingestion status per uploaded file, keyed by filename (e.g. "record.pdf").
  ingestionStatus: Record<'llm' | 'patientInfo', Record<string, IngestionStatusOrQueued>>;
  editPatientProfilePicUrl: string | null;
  caseMaterials: CaseMaterial[];
  selectedMaterialId: string;
  caseSpecificQuestions: GlobalRubricQuestion[];

  // Setters for form fields
  setEditPatientTab: (tab: 'info' | 'questions' | 'materials' | 'dtps' | 'recommendations') => void;
  setEditPatientName: (name: string) => void;
  setEditPatientAge: (age: string) => void;
  setEditPatientGender: (gender: string) => void;
  setEditPatientPrompt: (prompt: string) => void;
  setEditPatientVoiceId: (voiceId: string) => void;
  setEditVoicePersonaPrompt: (prompt: string) => void;
  setSelectedMaterialId: (id: string) => void;
  setCaseMaterials: React.Dispatch<React.SetStateAction<CaseMaterial[]>>;
  setCaseSpecificQuestions: React.Dispatch<React.SetStateAction<GlobalRubricQuestion[]>>;

  // Actions
  startEditing: (patientId: string) => void;
  startCreating: () => void;
  stopEditing: () => void;
  savePatient: () => Promise<boolean>;
  autoSaveNewPatient: () => Promise<string | null>;
  handleEditPatientTabSwitch: (tab: 'info' | 'questions' | 'materials' | 'dtps' | 'recommendations') => Promise<void>;
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  handleFileUpload: (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleFileDelete: (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string) => Promise<void>;
  handleDisplayNameSave: (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string, displayName: string) => Promise<void>;
  handlePhotoUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePhotoDelete: () => Promise<void>;
  photoDeletePending: boolean;
  confirmPhotoDelete: () => Promise<void>;
  cancelPhotoDelete: () => void;
  fileDeletePending: { pending: boolean; fileType: 'llm' | 'patientInfo'; filename: string };
  confirmFileDelete: () => Promise<void>;
  cancelFileDelete: () => void;

  // Material CRUD
  handleAddNewCaseMaterial: () => Promise<void>;
  handleSaveCaseMaterial: () => Promise<void>;
}

export function usePatientEditor({
  groupId,
  role,
  manageablePatients,
  setManageablePatients,
  profilePictures: _profilePictures,
  setProfilePictures,
  reloadPatients: _reloadPatients,
}: UsePatientEditorParams): UsePatientEditorReturn {
  const { showNotification } = useNotification();
  // Form state
  const [selectedPatientForEdit, setSelectedPatientForEdit] = useState<string | null>(null);
  const [editPatientTab, setEditPatientTab] = useState<'info' | 'questions' | 'materials' | 'dtps' | 'recommendations'>('info');
  const [editPatientName, setEditPatientName] = useState('');
  const [editPatientAge, setEditPatientAge] = useState('');
  const [editPatientGender, setEditPatientGender] = useState('');
  const [editPatientPrompt, setEditPatientPrompt] = useState('');
  const [editPatientVoiceId, setEditPatientVoiceId] = useState('');
  const [editVoicePersonaPrompt, setEditVoicePersonaPrompt] = useState('');
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'idle' | 'uploading' | 'success' | 'error'>>({});
  const [filesLoading, setFilesLoading] = useState(false);
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  const [uploadedFiles, setUploadedFiles] = useState<Record<'llm' | 'patientInfo' /* | 'answerKey' */, UploadedFileInfo[]>>({ llm: [], patientInfo: [] /* , answerKey: [] */ });
  const [editPatientProfilePicUrl, setEditPatientProfilePicUrl] = useState<string | null>(null);
  const uploadTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Live document ingestion status (RAG embedding progress) + polling control.
  const [ingestionStatus, setIngestionStatus] = useState<Record<'llm' | 'patientInfo', Record<string, IngestionStatusOrQueued>>>({ llm: {}, patientInfo: {} });
  const uploadedFilesRef = useRef(uploadedFiles);
  const ingestionPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ingestionPollCancelled = useRef(false);
  // Track files uploaded during this editing session so we can show 'queued'
  // only for files we know are awaiting Lambda processing (not legacy files).
  const recentlyUploadedRef = useRef<Set<string>>(new Set());

  // Keep a ref of the latest uploaded files so the poller can mark files that
  // exist in S3 but don't yet have a persona_data row as 'queued'.
  useEffect(() => { uploadedFilesRef.current = uploadedFiles; }, [uploadedFiles]);

  const INGESTION_POLL_INTERVAL_MS = 3000;
  const INGESTION_POLL_MAX_MS = 5 * 60 * 1000;

  const stopIngestionPolling = () => {
    ingestionPollCancelled.current = true;
    if (ingestionPollTimer.current) {
      clearTimeout(ingestionPollTimer.current);
      ingestionPollTimer.current = null;
    }
  };

  /**
   * Poll ingestion status until every uploaded document reaches a terminal
   * state (completed / error / not processing) or the max poll window elapses.
   */
  const pollIngestionStatus = (patientId: string) => {
    if (!groupId || patientId === 'new') return;
    if (ingestionPollTimer.current) clearTimeout(ingestionPollTimer.current);
    ingestionPollCancelled.current = false;
    const start = Date.now();

    const tick = async () => {
      if (ingestionPollCancelled.current) return;
      let byFolder;
      try {
        byFolder = await instructorService.getIngestionStatus(groupId, patientId);
      } catch {
        return; // stop the loop on a hard failure
      }
      if (ingestionPollCancelled.current) return;

      const expected = uploadedFilesRef.current;
      const mapSection = (
        files: UploadedFileInfo[],
        serverMap: Record<string, IngestionStatusOrQueued>
      ): Record<string, IngestionStatusOrQueued> => {
        const out: Record<string, IngestionStatusOrQueued> = {};
        files.forEach((f) => {
          if (serverMap[f.filename]) {
            // Server has a status for this file — use it directly.
            out[f.filename] = serverMap[f.filename];
            // Once the server knows about this file, stop treating it as "recent".
            recentlyUploadedRef.current.delete(f.filename);
          } else if (f.ingestionStatus) {
            // File was loaded with an initial status from get_all_files (DB row
            // exists). Use that rather than defaulting to 'queued'.
            out[f.filename] = f.ingestionStatus;
          } else if (recentlyUploadedRef.current.has(f.filename)) {
            // File was uploaded in this session but Lambda hasn't created the
            // DB row yet. Show 'queued' — it should transition soon.
            out[f.filename] = 'queued';
          } else {
            // File exists in S3 but has no DB row and was NOT uploaded this
            // session. It's a legacy file — don't show a misleading badge.
            out[f.filename] = 'not processing';
          }
        });
        return out;
      };

      const llm = mapSection(expected.llm, byFolder.documents);
      const patientInfo = mapSection(expected.patientInfo, byFolder.info);
      setIngestionStatus({ llm, patientInfo });

      const anyPending = [...Object.values(llm), ...Object.values(patientInfo)]
        .some((s) => s === 'processing' || s === 'queued');

      if (anyPending && Date.now() - start < INGESTION_POLL_MAX_MS) {
        ingestionPollTimer.current = setTimeout(tick, INGESTION_POLL_INTERVAL_MS);
      } else if (anyPending) {
        // Polling timed out but some files are still pending. Mark any 'queued'
        // files as 'error' since the Lambda likely never processed them.
        const markStaleQueued = (map: Record<string, IngestionStatusOrQueued>) => {
          const out = { ...map };
          for (const key of Object.keys(out)) {
            if (out[key] === 'queued') out[key] = 'error';
          }
          return out;
        };
        setIngestionStatus({ llm: markStaleQueued(llm), patientInfo: markStaleQueued(patientInfo) });
      }
    };

    tick();
  };

  // Stop polling on unmount.
  useEffect(() => stopIngestionPolling, []);

  // Case materials state
  const [caseMaterials, setCaseMaterials] = useState<CaseMaterial[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>('');

  // Case-specific questions state
  const [caseSpecificQuestions, setCaseSpecificQuestions] = useState<GlobalRubricQuestion[]>([]);

  // Clear upload timers on unmount
  useEffect(() => {
    return () => {
      Object.values(uploadTimers.current).forEach(clearTimeout);
      uploadTimers.current = {};
    };
  }, []);

  // Load case materials from API when patient changes
  useEffect(() => {
    if (!selectedPatientForEdit || selectedPatientForEdit === 'new') return;
    let cancelled = false;
    instructorService.getCaseMaterials(selectedPatientForEdit).then((data) => {
      if (!cancelled) {
        setCaseMaterials(data);
        setSelectedMaterialId(data[0]?.id || '');
      }
    });
    return () => { cancelled = true; };
  }, [selectedPatientForEdit]);

  /**
   * Load uploaded files for a patient from the API
   */
  const loadUploadedFiles = async (patientId: string) => {
    if (!groupId || patientId === 'new') {
      // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
      setUploadedFiles({ llm: [], patientInfo: [] /* , answerKey: [] */ });
      uploadedFilesRef.current = { llm: [], patientInfo: [] };
      setEditPatientProfilePicUrl(null);
      return;
    }
    setFilesLoading(true);
    try {
      const result = await instructorService.fetchPatientUploadedFiles(groupId, patientId);
      // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
      const { llm, patientInfo } = result.files;
      setUploadedFiles({ llm, patientInfo });
      // Update the ref synchronously so the first ingestion poll tick sees the
      // current file set rather than waiting for the effect to flush.
      uploadedFilesRef.current = { llm, patientInfo };
      setEditPatientProfilePicUrl(result.profilePictureUrl);

      // Set initial ingestion status from the file metadata so files don't
      // flash "Queued" before the first poll response arrives.
      const initialLlm: Record<string, IngestionStatusOrQueued> = {};
      const initialPatientInfo: Record<string, IngestionStatusOrQueued> = {};
      llm.forEach((f) => {
        if (f.ingestionStatus) initialLlm[f.filename] = f.ingestionStatus;
      });
      patientInfo.forEach((f) => {
        if (f.ingestionStatus) initialPatientInfo[f.filename] = f.ingestionStatus;
      });
      setIngestionStatus({ llm: initialLlm, patientInfo: initialPatientInfo });

      // Kick off live ingestion polling for any files still being embedded.
      const hasPending = [...llm, ...patientInfo].some(
        (f) => !f.ingestionStatus || f.ingestionStatus === 'processing'
          || recentlyUploadedRef.current.has(f.filename)
      );
      if (hasPending) {
        pollIngestionStatus(patientId);
      }
    } catch {
      setUploadedFiles({ llm: [], patientInfo: [] /* , answerKey: [] */ });
      uploadedFilesRef.current = { llm: [], patientInfo: [] };
      setEditPatientProfilePicUrl(null);
    } finally {
      setFilesLoading(false);
    }
  };

  /**
   * Start editing an existing patient
   */
  const startEditing = (patientId: string) => {
    const patient = manageablePatients.find(
      (p: any) => p.id === patientId || p.patient_id === patientId
    );
    if (!patient) return;

    setSelectedPatientForEdit(patientId);
    setEditPatientName((patient as any).patient_name || (patient as any).name || '');
    setEditPatientAge(((patient as any).patient_age || (patient as any).age || '').toString());
    setEditPatientGender((patient as any).patient_gender || (patient as any).gender || '');
    setEditPatientPrompt((patient as any).patient_prompt || instructorService.getDefaultPatientPrompt());
    setEditPatientVoiceId((patient as any).voice_id || 'tiffany');
    setEditVoicePersonaPrompt((patient as any).voice_persona_prompt ?? '');
    setEditPatientTab('info');

    if (role === 'admin' && groupId) {
      // Admin: load patient-specific questions from API
      instructorService.getSimulationGroupQuestions(groupId, patientId)
        .then((assigned: any[]) => {
          const patientQuestions: GlobalRubricQuestion[] = assigned.map((q: any) => ({
            id: q.question_id,
            group_question_id: q.group_question_id,
            title: q.title || '',
            keyQuestion: q.question_text || '',
            clinicalIntent: q.clinical_intent || '',
            evaluationCriteria: q.evaluation_criteria || '',
            required: q.is_mandatory ?? false,
          }));
          setCaseSpecificQuestions(patientQuestions);
        })
        .catch(() => {
          setCaseSpecificQuestions([]);
        });
    } else {
      // Instructor: load patient-specific questions from API
      if (groupId) {
        instructorService.getSimulationGroupQuestions(groupId, patientId)
          .then((assigned: any[]) => {
            const patientQuestions: GlobalRubricQuestion[] = assigned.map((q: any) => ({
              id: q.question_id,
              group_question_id: q.group_question_id,
              title: q.title || '',
              keyQuestion: q.question_text || '',
              clinicalIntent: q.clinical_intent || '',
              evaluationCriteria: q.evaluation_criteria || '',
              required: q.is_mandatory ?? false,
            }));
            setCaseSpecificQuestions(patientQuestions);
          })
          .catch(() => {
            setCaseSpecificQuestions([]);
          });
      }
    }

    // Materials are loaded by the useEffect above

    // Load uploaded files for display name editing
    loadUploadedFiles(patientId);
  };

  /**
   * Start creating a new patient
   */
  const startCreating = () => {
    setSelectedPatientForEdit('new');
    setEditPatientName('');
    setEditPatientAge('');
    setEditPatientGender('');
    setEditPatientPrompt(instructorService.getDefaultPatientPrompt());
    setEditPatientVoiceId('tiffany');
    setEditVoicePersonaPrompt('');
    setEditPatientTab('info');
    setCaseMaterials([]);
    setSelectedMaterialId('');
    setCaseSpecificQuestions([]);
    // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
    setUploadedFiles({ llm: [], patientInfo: [] /* , answerKey: [] */ });
    setEditPatientProfilePicUrl(null);
    stopIngestionPolling();
    setIngestionStatus({ llm: {}, patientInfo: {} });
    recentlyUploadedRef.current.clear();
  };

  /**
   * Stop editing / go back
   */
  const stopEditing = () => {
    setSelectedPatientForEdit(null);
    setUploadStatus({});
    setFilesLoading(false);
    // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
    setUploadedFiles({ llm: [], patientInfo: [] /* , answerKey: [] */ });
    setEditPatientProfilePicUrl(null);
    Object.values(uploadTimers.current).forEach(clearTimeout);
    uploadTimers.current = {};
    stopIngestionPolling();
    setIngestionStatus({ llm: {}, patientInfo: {} });
    recentlyUploadedRef.current.clear();
  };

  /**
   * Auto-save a new patient before allowing file uploads or other tabs.
   */
  const autoSaveNewPatient = async (): Promise<string | null> => {
    if (selectedPatientForEdit !== 'new' || !groupId) return selectedPatientForEdit;
    if (!editPatientName.trim()) {
      showNotification({ message: 'Please enter a patient name before proceeding.', type: 'warning' });
      return null;
    }
    if (!editPatientAge.trim() || parseInt(editPatientAge) <= 0) {
      showNotification({ message: 'Please enter a valid patient age before proceeding.', type: 'warning' });
      return null;
    }
    if (!editPatientGender.trim()) {
      showNotification({ message: 'Please enter a patient gender before proceeding.', type: 'warning' });
      return null;
    }
    try {
      const newPersonaId = await instructorService.createPatient(groupId, {
        patient_name: editPatientName,
        patient_age: parseInt(editPatientAge) || 0,
        patient_gender: editPatientGender,
        patient_prompt: editPatientPrompt,
        voice_persona_prompt: editVoicePersonaPrompt || undefined,
        voice_id: editPatientVoiceId || undefined,
      });
      setSelectedPatientForEdit(newPersonaId);
      setManageablePatients(await instructorService.getManageablePatients(groupId));
      return newPersonaId;
    } catch (error) {
      console.error('Failed to auto-save new patient:', error);
      showNotification({ message: 'Failed to save patient. Please try again.', type: 'error' });
      return null;
    }
  };

  /**
   * Handle tab switch with auto-save for new patients
   */
  const handleEditPatientTabSwitch = async (tab: 'info' | 'questions' | 'materials' | 'dtps' | 'recommendations') => {
    if (tab !== 'info' && selectedPatientForEdit === 'new') {
      const savedId = await autoSaveNewPatient();
      if (!savedId) return;
    }
    setEditPatientTab(tab);
  };

  /**
   * Save patient changes (create or update).
   * Returns true if saved, false if validation blocked it.
   */
  const savePatient = async (): Promise<boolean> => {
    if (!selectedPatientForEdit || !groupId) return false;

    if (!editPatientName.trim()) {
      showNotification({ message: 'Please enter a patient name before saving.', type: 'warning' });
      return false;
    }

    if (!editPatientAge.trim() || parseInt(editPatientAge) <= 0) {
      showNotification({ message: 'Please enter a valid patient age before saving.', type: 'warning' });
      return false;
    }

    if (!editPatientGender.trim()) {
      showNotification({ message: 'Please enter a patient gender before saving.', type: 'warning' });
      return false;
    }

    if (!editPatientPrompt.trim()) {
      showNotification({ message: 'Please fill in the Text Prompt before saving.', type: 'warning' });
      return false;
    }

    if (selectedPatientForEdit === 'new') {
      const newPersonaId = await instructorService.createPatient(groupId, {
        patient_name: editPatientName,
        patient_age: parseInt(editPatientAge) || 0,
        patient_gender: editPatientGender,
        patient_prompt: editPatientPrompt,
        voice_persona_prompt: editVoicePersonaPrompt || undefined,
        voice_id: editPatientVoiceId || undefined,
      });
      setSelectedPatientForEdit(newPersonaId);
    } else {
      await instructorService.updatePatient(groupId, {
        patient_id: selectedPatientForEdit,
        patient_name: editPatientName,
        patient_age: parseInt(editPatientAge) || 0,
        patient_gender: editPatientGender,
        patient_prompt: editPatientPrompt,
        voice_persona_prompt: editVoicePersonaPrompt || undefined,
        voice_id: editPatientVoiceId || undefined,
      });
    }

    // Reload patients list
    setManageablePatients(await instructorService.getManageablePatients(groupId));
    return true;
  };

  /**
   * Handle photo upload
   */
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && selectedPatientForEdit && groupId) {
      let patientId = selectedPatientForEdit;
      if (patientId === 'new') {
        const savedId = await autoSaveNewPatient();
        if (!savedId) return;
        patientId = savedId;
      }
      await instructorService.uploadPatientPhoto(groupId, patientId, file);
      const [patients, pics] = await Promise.all([
        instructorService.getManageablePatients(groupId),
        instructorService.fetchProfilePictures(groupId),
      ]);
      setManageablePatients(patients);
      setProfilePictures(pics);
      // Refresh the profile picture URL from get_all_files (reliable source)
      loadUploadedFiles(patientId);
    }
  };

  /**
   * Handle photo delete — sets pending state for confirmation dialog
   */
  const [photoDeletePending, setPhotoDeletePending] = useState(false);
  const handlePhotoDelete = async () => {
    setPhotoDeletePending(true);
  };
  const confirmPhotoDelete = async () => {
    if (!selectedPatientForEdit || selectedPatientForEdit === 'new' || !groupId) return;
    try {
      await instructorService.deletePatientPhoto(groupId, selectedPatientForEdit);
      setProfilePictures(await instructorService.fetchProfilePictures(groupId));
      setEditPatientProfilePicUrl(null);
    } catch (error) {
      console.error('Failed to delete photo:', error);
    }
    setPhotoDeletePending(false);
  };
  const cancelPhotoDelete = () => { setPhotoDeletePending(false); };

  /**
   * Handle file upload (LLM documents, patient info)
   */
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  const handleFileUpload = async (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && selectedPatientForEdit && groupId) {
      let patientId = selectedPatientForEdit;
      if (patientId === 'new') {
        const savedId = await autoSaveNewPatient();
        if (!savedId) return;
        patientId = savedId;
      }
      const folderType = fileType === 'llm' ? 'documents' : 'info' as const;
      /* Answer key folder mapping disabled:
      const folderType = fileType === 'llm' ? 'documents' : fileType === 'patientInfo' ? 'info' : 'answer_key' as const;
      */
      if (uploadTimers.current[fileType]) clearTimeout(uploadTimers.current[fileType]);
      setUploadStatus(prev => ({ ...prev, [fileType]: 'uploading' }));
      try {
        await instructorService.uploadPatientFile(groupId, patientId, file, folderType);
        setUploadStatus(prev => ({ ...prev, [fileType]: 'success' }));
        uploadTimers.current[fileType] = setTimeout(() => setUploadStatus(prev => ({ ...prev, [fileType]: 'idle' })), 3000);
        // Track this file as recently uploaded so the poller shows 'queued'
        // rather than 'not processing' while awaiting the ingestion Lambda.
        recentlyUploadedRef.current.add(file.name);
        // Refresh uploaded files list to show the new file
        loadUploadedFiles(patientId);
      } catch (error) {
        console.error('Failed to upload patient file', { fileType, groupId, patientId, error });
        setUploadStatus(prev => ({ ...prev, [fileType]: 'error' }));
        uploadTimers.current[fileType] = setTimeout(() => setUploadStatus(prev => ({ ...prev, [fileType]: 'idle' })), 5000);
      }
    }
    e.target.value = '';
  };

  /**
   * Handle file delete (remove file from S3, embeddings, and persona_data)
   */
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  const [fileDeletePending, setFileDeletePending] = useState<{ pending: boolean; fileType: 'llm' | 'patientInfo'; filename: string }>({
    pending: false, fileType: 'llm', filename: ''
  });
  const handleFileDelete = async (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string) => {
    if (!selectedPatientForEdit || selectedPatientForEdit === 'new' || !groupId) return;
    setFileDeletePending({ pending: true, fileType, filename });
  };
  const confirmFileDelete = async () => {
    if (!selectedPatientForEdit || selectedPatientForEdit === 'new' || !groupId) return;
    const { fileType, filename } = fileDeletePending;

    const lastDot = filename.lastIndexOf('.');
    const baseName = lastDot > 0 ? filename.substring(0, lastDot) : filename;
    const ext = lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : '';
    const folderType = fileType === 'llm' ? 'documents' : 'info' as const;

    try {
      await instructorService.deletePatientFile(groupId, selectedPatientForEdit, baseName, ext, folderType);
      // Remove from local state immediately
      setUploadedFiles(prev => ({
        ...prev,
        [fileType]: prev[fileType].filter(f => f.filename !== filename),
      }));
    } catch (error) {
      console.error('Failed to delete patient file', { fileType, filename, error });
    }
    setFileDeletePending({ pending: false, fileType: 'llm', filename: '' });
  };
  const cancelFileDelete = () => { setFileDeletePending({ pending: false, fileType: 'llm', filename: '' }); };

  /**
   * Add a new case material
   */
  const handleAddNewCaseMaterial = async () => {
    if (!selectedPatientForEdit) return;
    const newMaterial: CaseMaterial = {
      id: `material-${Date.now()}`,
      title: 'New Material',
      description: '',
      materialType: 'kaltura',
      contentUrl: '',
      embedLink: '',
    };
    try {
      const created = await instructorService.addCaseMaterial(selectedPatientForEdit, newMaterial);
      setCaseMaterials(prev => [created, ...prev]);
      setSelectedMaterialId(created.id);
      showNotification({ message: 'Material added successfully', type: 'success' });
    } catch (error) {
      console.error('Failed to add case material:', error);
      showNotification({ message: 'Failed to add material', type: 'error' });
    }
  };

  /**
   * Save case material changes
   */
  const handleSaveCaseMaterial = async () => {
    const selectedMaterial = caseMaterials.find(m => m.id === selectedMaterialId);
    if (!selectedMaterial || !selectedPatientForEdit) return;
    try {
      const updated = await instructorService.updateCaseMaterial(selectedPatientForEdit, selectedMaterial);
      setCaseMaterials(prev => prev.map(m => m.id === updated.id ? updated : m));
      showNotification({ message: 'Material saved successfully', type: 'success' });
    } catch (error) {
      console.error('Failed to save case material:', error);
      // Surface server-side validation errors (e.g. "url must be an https URL ...").
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      showNotification({ message: `Failed to save material${detail}`, type: 'error' });
    }
  };

  /**
   * Save a display name for an uploaded file (auto-saves on blur)
   */
  // Answer key file handling disabled — replaced by DTP/Recommendations Bank approach
  const handleDisplayNameSave = async (fileType: 'llm' | 'patientInfo' /* | 'answerKey' */, filename: string, displayName: string) => {
    if (!selectedPatientForEdit || selectedPatientForEdit === 'new') return;
    const lastDot = filename.lastIndexOf('.');
    const baseName = lastDot > 0 ? filename.substring(0, lastDot) : filename;
    const ext = lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : '';
    try {
      await instructorService.updateFileDisplayName(selectedPatientForEdit, baseName, ext, displayName);
      // Update local state optimistically
      setUploadedFiles(prev => ({
        ...prev,
        [fileType]: prev[fileType].map(f =>
          f.filename === filename ? { ...f, displayName: displayName || null } : f
        ),
      }));
    } catch (error) {
      console.error('Failed to save display name:', error);
    }
  };

  return {
    // Form state
    selectedPatientForEdit,
    editPatientTab,
    editPatientName,
    editPatientAge,
    editPatientGender,
    editPatientPrompt,
    editPatientVoiceId,
    editVoicePersonaPrompt,
    uploadStatus,
    filesLoading,
    uploadedFiles,
    ingestionStatus,
    editPatientProfilePicUrl,
    caseMaterials,
    selectedMaterialId,
    caseSpecificQuestions,

    // Setters
    setEditPatientTab,
    setEditPatientName,
    setEditPatientAge,
    setEditPatientGender,
    setEditPatientPrompt,
    setEditPatientVoiceId,
    setEditVoicePersonaPrompt,
    setSelectedMaterialId,
    setCaseMaterials,
    setCaseSpecificQuestions,

    // Actions
    startEditing,
    startCreating,
    stopEditing,
    savePatient,
    autoSaveNewPatient,
    handleEditPatientTabSwitch,
    handleFileUpload,
    handleFileDelete,
    handleDisplayNameSave,
    handlePhotoUpload,
    handlePhotoDelete,
    photoDeletePending,
    confirmPhotoDelete,
    cancelPhotoDelete,
    fileDeletePending,
    confirmFileDelete,
    cancelFileDelete,

    // Material CRUD
    handleAddNewCaseMaterial,
    handleSaveCaseMaterial,
  };
}
