import { useNavigate, useParams } from 'react-router-dom';
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { ArrowLeft, BarChart3, Users, UserCog, Search, Trash2, Plus, Menu, UserPlus, FileCode, HelpCircle, AlertTriangle, Pill, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { useAuth } from '@/App';
import { mockInstructorDataService, type GlobalRubricQuestion, type QuestionBankItem, instructorService } from '@/services/instructorService';
import { mockGroupInstructors, mockOrganizations } from '@/services/adminService';
import { studentService } from '@/services/studentService';
import * as adminApi from '@/services/adminApiService';
import { UI_COLORS } from '@/lib/colors';
import { useSimulationGroupData } from '@/hooks/useSimulationGroupData';
import { usePatientEditor } from '@/hooks/usePatientEditor';
import { useQuestionBank } from '@/hooks/useQuestionBank';
import { useStudentViewer } from '@/hooks/useStudentViewer';
import { useDebriefViewer } from '@/hooks/useDebriefViewer';
import { SimulationGroupSidebar } from '@/components/simulation-group/SimulationGroupSidebar';
import { PatientsSection } from '@/components/simulation-group/PatientsSection';
import { StudentsSection } from '@/components/simulation-group/StudentsSection';
import { StudentDetailsPanel } from '@/components/simulation-group/StudentDetailsPanel';
import { EditPatientPanel } from '@/components/simulation-group/EditPatientPanel';

// Lazy-loaded so recharts (~426 KB) only downloads when the Analytics tab opens.
const AnalyticsSection = lazy(() =>
  import('@/components/simulation-group/AnalyticsSection').then((m) => ({ default: m.AnalyticsSection }))
);
import { RubricSection } from '@/components/simulation-group/RubricSection';
import { QuestionBankSection } from '@/components/simulation-group/QuestionBankSection';
import { AddQuestionDialog } from '@/components/AddQuestionDialog';
import { AddPatientSpecificQuestionDialog } from '@/components/AddPatientSpecificQuestionDialog';
import { AddInstructorDialog } from '@/components/AddInstructorDialog';
import { useNotification } from '@/components/notifications';
import AIDebriefDialog from '@/components/AIDebriefDialog';
import PromptPlayground from '@/components/prompt-playground/PromptPlayground';
import SystemPromptPlayground from '@/components/prompt-playground/SystemPromptPlayground';

import { IssuesFeedbackSection } from '@/components/simulation-group/IssuesFeedbackSection';
import type { IssueReport, DebriefFeedback } from '@/services/adminApiService';
import { DTPBankSection } from '@/components/simulation-group/DTPBankSection';
import { RecommendationsBankSection } from '@/components/simulation-group/RecommendationsBankSection';
import { AddDTPDialog } from '@/components/AddDTPDialog';
import { AddRecommendationDialog } from '@/components/AddRecommendationDialog';
import { useDTPBank } from '@/hooks/useDTPBank';
import { useRecommendationsBank } from '@/hooks/useRecommendationsBank';
import { assignDTPToGroup, assignDTPToPatient, getAssignedDTPs, unassignDTP, listDTPItems, createDTPItem, updateDTPItem } from '@/services/dtpBankService';
import type { DTPItem, DTPAssignment } from '@/services/dtpBankService';
import { assignRecommendationToGroup, assignRecommendationToPatient, getAssignedRecommendations, unassignRecommendation, listRecommendationItems, createRecommendationItem, updateRecommendationItem } from '@/services/recommendationsBankService';
import type { RecommendationItem, RecommendationAssignment } from '@/services/recommendationsBankService';

import LoadingIndicator from '@/components/LoadingIndicator';
import { DashboardSkeleton } from '@/components/skeletons';

type ActiveSection = 'analytics' | 'patients' | 'students' | 'instructors' | 'prompts' | 'rubric' | 'questionBank' | 'dtpBank' | 'recommendationsBank' | 'editPatient' | 'viewStudent' | 'issuesFeedback';

/**
 * AdminSimulationGroupPage — thin shell composing shared hooks and components.
 * Admin-specific: instructors management, prompts with history, max messages per chat.
 */
function AdminSimulationGroupPage() {
  const navigate = useNavigate();
  const { organizationId, groupId } = useParams();
  const { user: authUser } = useAuth();
  const { showNotification } = useNotification();

  // Section navigation
  const [activeSection, setActiveSection] = useState<ActiveSection>('analytics');
  const [isMainSidebarVisible, setIsMainSidebarVisible] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [studentSearchQuery, setStudentSearchQuery] = useState('');

  // Shared hooks
  const groupData = useSimulationGroupData({ groupId, organizationId, role: 'admin' });
  const patientEditor = usePatientEditor({
    groupId, role: 'admin',
    manageablePatients: groupData.manageablePatients, setManageablePatients: groupData.setManageablePatients,
    profilePictures: groupData.profilePictures, setProfilePictures: groupData.setProfilePictures,
    reloadPatients: groupData.reloadPatients,
  });
  const questionBank = useQuestionBank({ role: 'admin' });
  const studentViewer = useStudentViewer({ groupId, groupName: groupData.simulationGroup?.group_name });
  const debriefViewer = useDebriefViewer({ groupId });

  // Destructure shared data
  const { labels, simulationGroup, setSimulationGroup, manageablePatients, profilePictures, students,
    patientAnalytics, analyticsDateRange, setAnalyticsDateRange, keyQuestionCoverage,
    keyQuestionAnalytics, dtpCoverage, recommendationCoverage, dtpAnalytics, recommendationAnalytics,
    studentProgress, selectedPatientId, setSelectedPatientId, loading, user,
  } = groupData;

  const { includedQuestionIds, setIncludedQuestionIds, questionBankTab,
    setGlobalBankQuestions, setPatientSpecificBankQuestions,
    allExistingTags, addQuestionType,
    isAddQuestionDialogOpen, setIsAddQuestionDialogOpen,
    isAddPatientQuestionDialogOpen, setIsAddPatientQuestionDialogOpen,
    selectedPatientForQuestionBank,
  } = questionBank;

  const { aiPersonaPlural: aiPersonaLabelPlural, aiPersonaLower: aiPersonaLabelLower, userRole: userRoleLabel } = labels;
  const accessCode = simulationGroup?.group_access_code || 'XXXX-XXXX-XXXX-XXXX';
  const enableVoiceForAll = manageablePatients.length > 0 && manageablePatients.every((p: any) => p.voice_enabled !== false);

  // Admin-specific state: instructors
  const [instructors, setInstructors] = useState<adminApi.AdminInstructor[]>([]);
  const [instructorsLoading, setInstructorsLoading] = useState(false);
  const [instructorSearchQuery, setInstructorSearchQuery] = useState('');
  const [isAddInstructorDialogOpen, setIsAddInstructorDialogOpen] = useState(false);

  // Admin-specific state: organization
  const [organization, setOrganization] = useState<adminApi.AdminOrganization | null>(null);

  // Admin-specific state: prompts
  const [selectedPromptType, setSelectedPromptType] = useState<'system' | 'evaluation'>('system');
  const [systemPromptText, setSystemPromptText] = useState('Pretend to be a patient with the context you are given. You are helping the pharmacist practice their skills interacting with a patient.');
  const [evaluationPromptText, setEvaluationPromptText] = useState('');
  const [, setIsPromptUnsaved] = useState(false);
  const [promptHistory, setPromptHistory] = useState<Array<{id: string; text: string; saved_at: string; modified_by_email: string | null; modified_by_first_name: string | null; modified_by_last_name: string | null}>>([]);

  // Admin-specific state: max messages
  const [maxMessagesPerChat, setMaxMessagesPerChat] = useState<number | null>(null);
  const [maxMessagesInput, setMaxMessagesInput] = useState<string>('');

  // Global rubric state
  const [globalRubricQuestions, setGlobalRubricQuestions] = useState<GlobalRubricQuestion[]>([]);

  // Mapping from question bank ID → group_question_id (assignment record ID) for unassign
  const questionIdToGroupQuestionId = useRef<Map<string, string>>(new Map());

  // Mapping from DTP item ID → group_dtp_id (assignment record ID) for unassign
  const dtpIdToGroupDtpId = useRef<Map<string, string>>(new Map());

  // Mapping from Recommendation item ID → group_recommendation_id (assignment record ID) for unassign
  const recIdToGroupRecId = useRef<Map<string, string>>(new Map());

  // Issues & Feedback state
  const [issueReports, setIssueReports] = useState<IssueReport[]>([]);
  const [debriefFeedbackList, setDebriefFeedbackList] = useState<DebriefFeedback[]>([]);
  const [issuesFeedbackLoading, setIssuesFeedbackLoading] = useState(false);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [rubricSearchQuery, setRubricSearchQuery] = useState('');
  const [isAccessCodeDialogOpen, setIsAccessCodeDialogOpen] = useState(false);

  // DTP Bank state (via hook)
  const dtpBank = useDTPBank({ role: 'admin' });
  const { includedIds: includedDTPIds, setIncludedIds: setIncludedDTPIds, selectedPatientId: selectedPatientForDTP, setSelectedPatientId: setSelectedPatientForDTP } = dtpBank;

  // Recommendations Bank state (via hook)
  const recommendationsBank = useRecommendationsBank({ role: 'admin' });
  const { includedIds: includedRecommendationIds, setIncludedIds: setIncludedRecommendationIds, selectedPatientId: selectedPatientForRecommendations, setSelectedPatientId: setSelectedPatientForRecommendations } = recommendationsBank;

  const selectedQuestion = globalRubricQuestions.find(q => q.id === selectedQuestionId);
  const filteredInstructors = instructors.filter(i => {
    const fullName = `${i.first_name} ${i.last_name}`.toLowerCase();
    return fullName.includes(instructorSearchQuery.toLowerCase()) || i.user_email.toLowerCase().includes(instructorSearchQuery.toLowerCase());
  });

  // ── Reset admin-specific state when group changes ──
  useEffect(() => {
    setInstructors([]);
    setPromptHistory([]);
    setIssueReports([]);
    setDebriefFeedbackList([]);
    setGlobalRubricQuestions([]);
    setMaxMessagesPerChat(null);
    setMaxMessagesInput('');
    setSelectedQuestionId(null);
  }, [groupId]);

  // ── Admin-specific data loading ──
  useEffect(() => {
    const loadAdminData = async () => {
      if (!groupId) return;
      try {
        const [bankGlobal, bankPatient] = await Promise.all([
          organizationId
            ? adminApi.getQuestionBankQuestions(organizationId).catch(err => { console.error('Failed to load global questions:', err); return [] as QuestionBankItem[]; })
            : instructorService.getGlobalQuestionBank().catch(err => { console.error('Failed to load global questions:', err); return [] as QuestionBankItem[]; }),
          Promise.resolve(instructorService.getPatientSpecificQuestionBank()),
        ]);
        if (organizationId) {
          const global: QuestionBankItem[] = [];
          const patientSpecific: QuestionBankItem[] = [];
          for (const q of bankGlobal) {
            if (q.tags?.includes('patient_specific')) { patientSpecific.push(q); } else { global.push(q); }
          }
          setGlobalBankQuestions(global);
          setPatientSpecificBankQuestions(patientSpecific);
        } else {
          setGlobalBankQuestions(bankGlobal);
          setPatientSpecificBankQuestions(bankPatient);
        }
        const adminGroupData = await adminApi.getSimulationGroup(groupId).catch(() => undefined);
        if (adminGroupData?.max_messages_per_chat != null) {
          setMaxMessagesPerChat(adminGroupData.max_messages_per_chat);
          setMaxMessagesInput(String(adminGroupData.max_messages_per_chat));
        } else { setMaxMessagesPerChat(null); setMaxMessagesInput(''); }
      } catch (error) { console.error('Error loading admin-specific data:', error); }
      if (organizationId) {
        try { setOrganization(await adminApi.getOrganization(organizationId)); }
        catch (err) {
          console.error('Failed to load organization from API, using mock:', err);
          setOrganization(mockOrganizations.find(o => o.organization_id === organizationId) || null);
        }
      }
    };
    loadAdminData();
  }, [groupId, organizationId]);

  // ── Load prompts ──
  useEffect(() => {
    if (!groupId) return;
    (async () => {
      try {
        const [systemPrompt, debriefPrompt] = await Promise.all([
          instructorService.getEvaluationPrompt(groupId).catch(err => { console.error('Failed to load system prompt:', err); return ''; }),
          instructorService.getDebriefPrompt(groupId).catch(err => { console.error('Failed to load debrief prompt:', err); return ''; }),
        ]);
        setSystemPromptText(systemPrompt);
        setEvaluationPromptText(debriefPrompt);
      } catch (error) { console.error('Error loading prompts:', error); }
    })();
  }, [groupId]);

  // ── Load prompt history ──
  useEffect(() => {
    if (!groupId) return;
    (async () => {
      const type = selectedPromptType === 'system' ? 'system' : 'debrief';
      setPromptHistory(await instructorService.getPromptHistory(groupId, type));
    })();
  }, [groupId, selectedPromptType]);

  // ── Load instructors ──
  useEffect(() => {
    if (activeSection === 'instructors' && groupId) {
      setInstructorsLoading(true);
      adminApi.getGroupInstructors(groupId)
        .then(setInstructors)
        .catch(err => { console.error('Failed to load group instructors, using mock data:', err); setInstructors(mockGroupInstructors); })
        .finally(() => setInstructorsLoading(false));
    }
  }, [activeSection, groupId]);

  // ── Load issues & feedback ──
  useEffect(() => {
    if (activeSection === 'issuesFeedback' && groupId) {
      setIssuesFeedbackLoading(true);
      Promise.all([
        adminApi.getIssueReports(groupId).catch(err => { console.error('Failed to load issue reports:', err); return [] as IssueReport[]; }),
        adminApi.getDebriefFeedback(groupId).catch(err => { console.error('Failed to load debrief feedback:', err); return [] as DebriefFeedback[]; }),
      ]).then(([reports, feedback]) => {
        setIssueReports(reports);
        setDebriefFeedbackList(feedback);
      }).finally(() => setIssuesFeedbackLoading(false));
    }
  }, [activeSection, groupId]);

  // ── Load assigned questions ──
  useEffect(() => {
    if ((activeSection === 'rubric' || activeSection === 'questionBank' || activeSection === 'editPatient') && groupId) {
      instructorService.getSimulationGroupQuestions(groupId)
        .then((assigned: any[]) => {
          const globalAssigned = assigned.filter((q: any) => !q.persona_id);
          const rubricQuestions: GlobalRubricQuestion[] = globalAssigned.map((q: any) => ({
            id: q.question_id, title: q.title || '', keyQuestion: q.question_text || '',
            clinicalIntent: '', evaluationCriteria: q.evaluation_criteria || '', required: q.is_mandatory ?? false,
          }));
          setGlobalRubricQuestions(rubricQuestions);
          if (activeSection !== 'editPatient') setIncludedQuestionIds(new Set(globalAssigned.map((q: any) => q.question_id)));
          // Build questionId → groupQuestionId mapping
          const map = new Map<string, string>();
          for (const q of assigned) {
            if (q.question_id && q.group_question_id) map.set(q.question_id, q.group_question_id);
          }
          questionIdToGroupQuestionId.current = map;
          if (rubricQuestions.length > 0 && !selectedQuestionId) setSelectedQuestionId(rubricQuestions[0].id);
        })
        .catch((err: any) => console.error('Failed to load assigned questions:', err));
    }
  }, [activeSection, groupId]);

  // ── Load assigned DTPs when DTP bank section becomes active ──
  useEffect(() => {
    if (activeSection === 'dtpBank' && groupId) {
      // Load bank items
      if (organizationId) {
        listDTPItems(organizationId).then((items) => {
          dtpBank.setDtpItems(items);
        });
      }
      // Load assignments
      getAssignedDTPs(groupId, selectedPatientForDTP || undefined).then((assignments) => {
        const filtered = selectedPatientForDTP ? assignments : assignments.filter(a => !a.personaId);
        setIncludedDTPIds(new Set(filtered.map(a => a.dtpId)));
        dtpIdToGroupDtpId.current.clear();
        for (const a of filtered) {
          dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
        }
      }).catch(() => setIncludedDTPIds(new Set()));
    }
  }, [activeSection, groupId]);

  // ── Load assigned Recommendations when Recommendations bank section becomes active ──
  useEffect(() => {
    if (activeSection === 'recommendationsBank' && groupId) {
      // Load bank items
      if (organizationId) {
        listRecommendationItems(organizationId).then((items) => {
          recommendationsBank.setRecommendationItems(items);
        });
      }
      // Load assignments
      getAssignedRecommendations(groupId, selectedPatientForRecommendations || undefined).then((assignments) => {
        const filtered = selectedPatientForRecommendations ? assignments : assignments.filter(a => !a.personaId);
        setIncludedRecommendationIds(new Set(filtered.map(a => a.recommendationId)));
        recIdToGroupRecId.current.clear();
        for (const a of filtered) {
          recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
        }
      }).catch(() => setIncludedRecommendationIds(new Set()));
    }
  }, [activeSection, groupId]);

  // ── Navigation handlers ──
  const handleSignOut = () => navigate('/login');
  const handleBackToAllGroups = () => navigate(`/admin/organization/${organizationId}`);
  const handleStudentView = async () => {
    const adminReturnUrl = `/admin/organization/${organizationId}/group/${groupId}`;
    if (groupId && accessCode && accessCode !== 'XXXX-XXXX-XXXX-XXXX') {
      try {
        const result = await studentService.joinGroup(accessCode, 'preview');
        if (result?.success) { navigate(`/patients/${groupId}`, { state: { adminReturnUrl } }); return; }
        showNotification({ message: 'Unable to enroll in this simulation group. Taking you to the student dashboard instead.', type: 'warning' });
      } catch (error) {
        console.error('Unexpected error while enrolling as student:', error);
        showNotification({ message: 'An unexpected error occurred while enrolling in this simulation group. Taking you to the student dashboard instead.', type: 'error' });
      }
    }
    navigate('/student');
  };
  const handleInstructorView = async () => {
    if (groupId) {
      try {
        const user = await import('@/lib/auth').then(m => m.authService.getCurrentUser());
        if (user?.email) await adminApi.enrollInstructorInGroup(groupId, user.email);
      } catch (err) { console.error('Failed to enroll as instructor:', err); }
      navigate(`/instructor/group/${groupId}`);
    } else { navigate('/instructor'); }
  };
  const handleCopyAccessCode = () => navigator.clipboard.writeText(accessCode);
  const handleGenerateAccessCode = async () => {
    if (!groupId) return;
    try {
      const result = await adminApi.regenerateAccessCode(groupId);
      setSimulationGroup((prev: any) => prev ? { ...prev, group_access_code: result.access_code } : prev);
    } catch (err) {
      console.error('Failed to regenerate access code via API, using mock:', err);
      const newCode = await mockInstructorDataService.generateAccessCode(groupId);
      setSimulationGroup((prev: any) => prev ? { ...prev, group_access_code: newCode } : prev);
    }
  };

  // ── Patient / student handlers ──
  const [deletePatientConfirm, setDeletePatientConfirm] = useState<{ open: boolean; patientId: string; patientName: string }>({
    open: false, patientId: '', patientName: ''
  });
  const handleDeletePatient = (patientId: string) => {
    const patient = groupData.manageablePatients.find((p: any) => p.patient_id === patientId || p.id === patientId);
    setDeletePatientConfirm({ open: true, patientId, patientName: (patient as any)?.name || aiPersonaLabelLower });
  };
  const handleConfirmDeletePatient = () => {
    groupData.setManageablePatients(prev => prev.filter((p: any) => p.patient_id !== deletePatientConfirm.patientId));
    mockInstructorDataService.deletePatient(deletePatientConfirm.patientId);
    setDeletePatientConfirm({ open: false, patientId: '', patientName: '' });
  };
  const handleEditPatient = (patientId: string) => {
    patientEditor.startEditing(patientId);
    if (groupId) {
      instructorService.getSimulationGroupQuestions(groupId, patientId)
        .then((assigned: any[]) => {
          setIncludedQuestionIds(new Set(assigned.map((q: any) => q.question_id)));
          for (const q of assigned) {
            if (q.question_id && q.group_question_id) questionIdToGroupQuestionId.current.set(q.question_id, q.group_question_id);
          }
        })
        .catch(() => setIncludedQuestionIds(new Set()));
    }
    setActiveSection('editPatient');
  };
  const handleBackFromEditPatient = () => { patientEditor.stopEditing(); setActiveSection('patients'); };
  const handleSavePatientChanges = async () => {
    try {
      const saved = await patientEditor.savePatient();
      if (saved) {
        showNotification({ message: 'Patient saved successfully.', type: 'success' });
        handleBackFromEditPatient();
      }
    } catch (error) {
      console.error('Failed to save patient changes:', error);
      showNotification({ message: 'Failed to save changes. Please try again.', type: 'error' });
    }
  };
  const handleCreateNewPatient = () => { patientEditor.startCreating(); setActiveSection('editPatient'); };
  const handleTogglePatientVoice = async (patientId: string, enabled: boolean) => {
    groupData.setManageablePatients(prev =>
      prev.map((p: any) => (p.id === patientId || p.patient_id === patientId) ? { ...p, voice_enabled: enabled } : p)
    );
    if (groupId) {
      try { await instructorService.updatePatientVoiceEnabled(patientId, groupId, enabled); }
      catch (err) { console.error('Failed to update voice setting:', err); }
    }
  };
  const handleViewStudent = async (studentId: string) => { await studentViewer.viewStudent(studentId); setActiveSection('viewStudent'); };
  const handleBackFromViewStudent = () => { studentViewer.closeStudentView(); setActiveSection('students'); };

  // ── Instructor handlers ──
  const handleAddNewInstructor = () => setIsAddInstructorDialogOpen(true);
  const handleAddInstructorSubmit = async (email: string, _name: string) => {
    if (!groupId) return;
    try {
      await adminApi.addInstructorToGroup(groupId, email);
      setInstructors(await adminApi.getGroupInstructors(groupId));
      showNotification({ message: `${email} added as instructor.`, type: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add instructor.';
      showNotification({ message, type: 'error' });
    }
  };
  const [removeInstructorConfirm, setRemoveInstructorConfirm] = useState<{ open: boolean; email: string; displayName: string }>({
    open: false, email: '', displayName: ''
  });
  const handleRemoveInstructor = async (instructorEmail: string) => {
    if (!groupId) return;
    const instructor = instructors.find(i => i.user_email === instructorEmail);
    const displayName = instructor ? `${instructor.first_name} ${instructor.last_name}` : instructorEmail;
    setRemoveInstructorConfirm({ open: true, email: instructorEmail, displayName });
  };
  const handleConfirmRemoveInstructor = async () => {
    if (!groupId) return;
    try { await adminApi.removeInstructorFromGroup(groupId, removeInstructorConfirm.email); setInstructors(await adminApi.getGroupInstructors(groupId)); }
    catch (err) { console.error('Failed to remove instructor via API, removing locally:', err); setInstructors(prev => prev.filter(i => i.user_email !== removeInstructorConfirm.email)); }
    setRemoveInstructorConfirm({ open: false, email: '', displayName: '' });
  };

  // ── Prompt handlers ──
  const handleLoadDefaultPrompt = async () => {
    if (selectedPromptType === 'system') {
      setSystemPromptText(await instructorService.getDefaultSystemPrompt());
    } else {
      setEvaluationPromptText(await instructorService.getDefaultDebriefPrompt());
    }
    setIsPromptUnsaved(true);
  };
  const handleSavePrompt = async () => {
    if (!groupId) return;
    try {
      const email = authUser?.email || '';
      if (selectedPromptType === 'evaluation') { await instructorService.updateDebriefPrompt(groupId, email, evaluationPromptText); }
      else { await instructorService.updateSystemPrompt(groupId, email, systemPromptText); }
      setIsPromptUnsaved(false);
      const type = selectedPromptType === 'system' ? 'system' : 'debrief';
      setPromptHistory(await instructorService.getPromptHistory(groupId, type));
      showNotification({ message: 'Prompt saved successfully!', type: 'success' });
    } catch (error) { console.error('Failed to save prompt:', error); showNotification({ message: 'Failed to save prompt. Please try again.', type: 'error' }); }
  };
  const [restorePromptConfirm, setRestorePromptConfirm] = useState<{ open: boolean; versionText: string }>({
    open: false, versionText: ''
  });
  const handleRestorePromptVersion = (versionText: string) => {
    setRestorePromptConfirm({ open: true, versionText });
  };
  const handleConfirmRestorePrompt = () => {
    if (selectedPromptType === 'system') { setSystemPromptText(restorePromptConfirm.versionText); } else { setEvaluationPromptText(restorePromptConfirm.versionText); }
    setRestorePromptConfirm({ open: false, versionText: '' });
  };

  // ── Rubric handlers ──
  const handleSaveQuestion = () => {
    if (!selectedQuestion) return;
    instructorService.updateGlobalRubricQuestion(groupId || '1', selectedQuestion);
  };
  const handleUpdateQuestionField = (field: keyof GlobalRubricQuestion, value: string | boolean) => {
    if (!selectedQuestionId) return;
    setGlobalRubricQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, [field]: value } : q));
  };
  const [deleteQuestionConfirm, setDeleteQuestionConfirm] = useState<{ open: boolean; questionId: string; questionTitle: string }>({
    open: false, questionId: '', questionTitle: ''
  });
  const handleDeleteQuestion = () => {
    if (!selectedQuestionId) return;
    const question = globalRubricQuestions.find(q => q.id === selectedQuestionId);
    setDeleteQuestionConfirm({ open: true, questionId: selectedQuestionId, questionTitle: question?.title || '' });
  };
  const handleConfirmDeleteQuestion = () => {
    instructorService.deleteGlobalRubricQuestion(groupId || '1', deleteQuestionConfirm.questionId);
    const updated = instructorService.getGlobalRubricQuestions(groupId || '1');
    setGlobalRubricQuestions(updated);
    setSelectedQuestionId(updated[0]?.id || null);
    setIncludedQuestionIds(prev => { const s = new Set(prev); s.delete(deleteQuestionConfirm.questionId); return s; });
    setDeleteQuestionConfirm({ open: false, questionId: '', questionTitle: '' });
  };

  // ── Question bank handlers ──
  const handleSaveNewQuestion = async (question: { title: string; keyQuestion: string; clinicalIntent: string; evaluationCriteria: string; required: boolean }) => {
    const newQuestionId = `bank-${addQuestionType}-${Date.now()}`;
    const newBankQuestion: QuestionBankItem = {
      id: newQuestionId, title: question.title, questionText: question.keyQuestion, clinicalIntent: question.clinicalIntent,
      evaluationCriteria: question.evaluationCriteria, isMandatory: question.required, isActive: true,
      tags: addQuestionType === 'patientSpecific' ? ['patient_specific'] : [], usedBySimulationGroups: [],
      usedByPatients: addQuestionType === 'patientSpecific' ? [] : undefined,
    };
    if (addQuestionType === 'global') {
      if (organizationId) {
        try {
          await adminApi.createQuestionBankQuestion(organizationId, { title: question.title, question_text: question.keyQuestion, evaluation_criteria: question.evaluationCriteria, is_mandatory: question.required, tags: [] });
          const allQuestions = await adminApi.getQuestionBankQuestions(organizationId);
          setGlobalBankQuestions(allQuestions.filter(q => !q.tags?.includes('patient_specific')));
        } catch (err) {
          console.error('Failed to create question via API, falling back to mock:', err);
          instructorService.addToGlobalQuestionBank(newBankQuestion);
          setGlobalBankQuestions(prev => [...prev, newBankQuestion]);
        }
      } else {
        instructorService.addToGlobalQuestionBank(newBankQuestion);
        setGlobalBankQuestions(prev => [...prev, newBankQuestion]);
      }
    } else {
      instructorService.addToPatientSpecificQuestionBank(newBankQuestion);
      setPatientSpecificBankQuestions(instructorService.getPatientSpecificQuestionBank());
    }
  };

  const handleSaveNewPatientQuestion = async (question: { patientId: string; title: string; keyQuestion: string; clinicalIntent: string; evaluationCriteria: string; required: boolean }) => {
    const newQuestionId = `bank-patient-${Date.now()}`;
    const newBankQuestion: QuestionBankItem = {
      id: newQuestionId, title: question.title, questionText: question.keyQuestion, clinicalIntent: question.clinicalIntent,
      evaluationCriteria: question.evaluationCriteria, isMandatory: question.required, isActive: true,
      tags: ['patient_specific'], usedBySimulationGroups: [], usedByPatients: [],
    };
    mockInstructorDataService.addToPatientSpecificQuestionBank(newBankQuestion);
    setPatientSpecificBankQuestions(mockInstructorDataService.getPatientSpecificQuestionBank());
    const newCaseQuestion: GlobalRubricQuestion = { id: newQuestionId, title: question.title, keyQuestion: question.keyQuestion, clinicalIntent: question.clinicalIntent, evaluationCriteria: question.evaluationCriteria, required: question.required };
    instructorService.addCaseSpecificQuestion(question.patientId, newCaseQuestion);
    if (questionBankTab === 'patientSpecific' && selectedPatientForQuestionBank === question.patientId) {
      setIncludedQuestionIds(prev => { const s = new Set(prev); s.add(newQuestionId); return s; });
    }
    try {
      const created = await adminApi.createQuestionBankQuestion(organizationId!, { title: question.title, question_text: question.keyQuestion, evaluation_criteria: question.evaluationCriteria, is_mandatory: question.required });
      await instructorService.assignQuestionToGroup(groupId || '', created.id, question.patientId);
      const updatedBank = await instructorService.getGlobalQuestionBank();
      setGlobalBankQuestions(updatedBank);
      if (questionBankTab === 'patientSpecific' && selectedPatientForQuestionBank === question.patientId) {
        setIncludedQuestionIds(prev => { const s = new Set(prev); s.add(created.id); return s; });
      }
    } catch (err) { console.error('Failed to create patient-specific question:', err); }
  };

  const handleToggleQuestionInclusion = async (questionId: string, bankQuestion: QuestionBankItem, isChecked: boolean) => {
    const newSet = new Set(includedQuestionIds);
    const isGlobal = questionBankTab === 'global' || questionId.startsWith('bank-global-');
    const personaId = !isGlobal ? selectedPatientForQuestionBank : undefined;
    try {
      if (isChecked) {
        newSet.add(questionId);
        const result = await instructorService.assignQuestionToGroup(groupId || '1', questionId, personaId || undefined);
        // Store the new group_question_id in the mapping
        if (result?.group_question_id) {
          questionIdToGroupQuestionId.current.set(questionId, result.group_question_id);
        } else if (Array.isArray(result) && result[0]?.group_question_id) {
          questionIdToGroupQuestionId.current.set(questionId, result[0].group_question_id);
        }
        if (isGlobal && !globalRubricQuestions.find(q => q.id === questionId)) {
          instructorService.addGlobalRubricQuestion(groupId || '1', { id: questionId, title: bankQuestion.title, keyQuestion: bankQuestion.questionText, clinicalIntent: bankQuestion.clinicalIntent, evaluationCriteria: bankQuestion.evaluationCriteria, required: bankQuestion.isMandatory });
          setGlobalRubricQuestions(instructorService.getGlobalRubricQuestions(groupId || '1'));
        }
      } else {
        newSet.delete(questionId);
        const groupQuestionId = questionIdToGroupQuestionId.current.get(questionId);
        if (!groupQuestionId) {
          console.error('No group_question_id found for question:', questionId);
          return;
        }
        await instructorService.unassignQuestion(groupQuestionId);
        questionIdToGroupQuestionId.current.delete(questionId);
        if (isGlobal) {
          instructorService.deleteGlobalRubricQuestion(groupId || '1', questionId);
          setGlobalRubricQuestions(instructorService.getGlobalRubricQuestions(groupId || '1'));
        }
      }
      setIncludedQuestionIds(newSet);
    } catch (err) { console.error('Failed to update question assignment:', err); }
  };

  // ── DTP Bank assignment handlers ──
  const handleToggleDTPInclusion = async (dtpItemId: string, _dtpItem: DTPItem, isChecked: boolean) => {
    const newSet = new Set(includedDTPIds);
    try {
      if (isChecked) {
        newSet.add(dtpItemId);
        let result;
        if (selectedPatientForDTP) {
          result = await assignDTPToPatient(dtpItemId, groupId || '', selectedPatientForDTP);
        } else {
          result = await assignDTPToGroup(dtpItemId, groupId || '');
        }
        if (result?.groupDtpId) {
          dtpIdToGroupDtpId.current.set(dtpItemId, result.groupDtpId);
        }
        showNotification({ message: selectedPatientForDTP ? 'DTP assigned to patient.' : 'DTP assigned to all patients.', type: 'success' });
      } else {
        newSet.delete(dtpItemId);
        const groupDtpId = dtpIdToGroupDtpId.current.get(dtpItemId);
        if (groupDtpId) {
          await unassignDTP(groupDtpId);
          dtpIdToGroupDtpId.current.delete(dtpItemId);
        }
        showNotification({ message: selectedPatientForDTP ? 'DTP unassigned from patient.' : 'DTP unassigned from all patients.', type: 'success' });
      }
      setIncludedDTPIds(newSet);
      groupData.reloadPatients();
    } catch (err) {
      console.error('Failed to update DTP assignment:', err);
      showNotification({ message: 'Failed to update DTP assignment.', type: 'error' });
    }
  };

  const handleDTPPatientSelect = (patientId: string | null) => {
    setSelectedPatientForDTP(patientId);
    // Reload assignments for the new patient selection
    if (!groupId) return;
    getAssignedDTPs(groupId, patientId || undefined).then((assignments) => {
      setIncludedDTPIds(new Set(assignments.map(a => a.dtpId)));
      // Populate the ID mapping for unassign
      dtpIdToGroupDtpId.current.clear();
      for (const a of assignments) {
        dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
      }
    }).catch(() => setIncludedDTPIds(new Set()));
  };

  // ── Recommendations Bank assignment handlers ──
  const handleToggleRecommendationInclusion = async (itemId: string, _item: RecommendationItem, isChecked: boolean) => {
    const newSet = new Set(includedRecommendationIds);
    try {
      if (isChecked) {
        newSet.add(itemId);
        let result;
        if (selectedPatientForRecommendations) {
          result = await assignRecommendationToPatient(itemId, groupId || '', selectedPatientForRecommendations);
        } else {
          result = await assignRecommendationToGroup(itemId, groupId || '');
        }
        if (result?.groupRecommendationId) {
          recIdToGroupRecId.current.set(itemId, result.groupRecommendationId);
        }
        showNotification({ message: selectedPatientForRecommendations ? 'Recommendation assigned to patient.' : 'Recommendation assigned to all patients.', type: 'success' });
      } else {
        newSet.delete(itemId);
        const groupRecId = recIdToGroupRecId.current.get(itemId);
        if (groupRecId) {
          await unassignRecommendation(groupRecId);
          recIdToGroupRecId.current.delete(itemId);
        }
        showNotification({ message: selectedPatientForRecommendations ? 'Recommendation unassigned from patient.' : 'Recommendation unassigned from all patients.', type: 'success' });
      }
      setIncludedRecommendationIds(newSet);
      groupData.reloadPatients();
    } catch (err) {
      console.error('Failed to update Recommendation assignment:', err);
      showNotification({ message: 'Failed to update Recommendation assignment.', type: 'error' });
    }
  };

  const handleRecommendationsPatientSelect = (patientId: string | null) => {
    setSelectedPatientForRecommendations(patientId);
    // Reload assignments for the new patient selection
    if (!groupId) return;
    getAssignedRecommendations(groupId, patientId || undefined).then((assignments) => {
      setIncludedRecommendationIds(new Set(assignments.map(a => a.recommendationId)));
      // Populate the ID mapping for unassign
      recIdToGroupRecId.current.clear();
      for (const a of assignments) {
        recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
      }
    }).catch(() => setIncludedRecommendationIds(new Set()));
  };

  // ── Add New DTP handler (from inline dialog) ──
  const handleSaveNewDTPItem = async (data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => {
    if (!organizationId) return;
    try {
      const created = await createDTPItem(organizationId, data);
      dtpBank.setDtpItems(prev => [created, ...prev]);
      showNotification({ message: 'DTP item created successfully.', type: 'success' });
    } catch (err) {
      console.error('Failed to create DTP item:', err);
      showNotification({ message: 'Failed to create DTP item.', type: 'error' });
    }
  };

  // ── Add New Recommendation handler (from inline dialog) ──
  const handleSaveNewRecommendationItem = async (data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string; tags?: string[] }) => {
    if (!organizationId) return;
    try {
      const created = await createRecommendationItem(organizationId, { ...data, tags: data.tags ?? [] });
      recommendationsBank.setRecommendationItems(prev => [created, ...prev]);
      showNotification({ message: 'Recommendation item created successfully.', type: 'success' });
    } catch (err) {
      console.error('Failed to create Recommendation item:', err);
      showNotification({ message: 'Failed to create Recommendation item.', type: 'error' });
    }
  };

  // ── Edit Patient: Patient-specific and group-level DTPs/Recs state ──
  const [patientDTPs, setPatientDTPs] = useState<DTPAssignment[]>([]);
  const [groupDTPs, setGroupDTPs] = useState<DTPAssignment[]>([]);
  const [patientRecommendations, setPatientRecommendations] = useState<RecommendationAssignment[]>([]);
  const [groupRecommendations, setGroupRecommendations] = useState<RecommendationAssignment[]>([]);

  const handleLoadPatientDTPs = (patientId: string) => {
    if (!groupId) return;
    Promise.all([
      getAssignedDTPs(groupId, patientId),
      getAssignedDTPs(groupId),
    ]).then(([patientAssignments, groupAssignments]) => {
      setPatientDTPs(patientAssignments);
      setGroupDTPs(groupAssignments.filter(a => !a.personaId));
    }).catch(() => { setPatientDTPs([]); setGroupDTPs([]); });
  };

  const handleLoadPatientRecommendations = (patientId: string) => {
    if (!groupId) return;
    Promise.all([
      getAssignedRecommendations(groupId, patientId),
      getAssignedRecommendations(groupId),
    ]).then(([patientAssignments, groupAssignments]) => {
      setPatientRecommendations(patientAssignments);
      setGroupRecommendations(groupAssignments.filter(a => !a.personaId));
    }).catch(() => { setPatientRecommendations([]); setGroupRecommendations([]); });
  };

  const handleCreatePatientDTP = async (patientId: string, data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => {
    if (!organizationId || !groupId) return;
    try {
      const created = await createDTPItem(organizationId, data);
      const assignment = await assignDTPToPatient(created.id, groupId, patientId);
      setPatientDTPs(prev => [...prev, assignment]);
      showNotification({ message: 'DTP created and assigned to patient.', type: 'success' });
    } catch (err) {
      console.error('Failed to create patient DTP:', err);
      showNotification({ message: 'Failed to create patient DTP.', type: 'error' });
    }
  };

  const handleDeletePatientDTP = async (_patientId: string, groupDtpId: string) => {
    try {
      await unassignDTP(groupDtpId);
      setPatientDTPs(prev => prev.filter(d => d.groupDtpId !== groupDtpId));
      showNotification({ message: 'DTP removed from patient.', type: 'success' });
    } catch (err) {
      console.error('Failed to remove patient DTP:', err);
      showNotification({ message: 'Failed to remove patient DTP.', type: 'error' });
    }
  };

  const handleCreatePatientRecommendation = async (patientId: string, data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string; tags?: string[] }) => {
    if (!organizationId || !groupId) return;
    try {
      const created = await createRecommendationItem(organizationId, { ...data, tags: data.tags ?? [] });
      const assignment = await assignRecommendationToPatient(created.id, groupId, patientId);
      setPatientRecommendations(prev => [...prev, assignment]);
      showNotification({ message: 'Recommendation created and assigned to patient.', type: 'success' });
    } catch (err) {
      console.error('Failed to create patient Recommendation:', err);
      showNotification({ message: 'Failed to create patient Recommendation.', type: 'error' });
    }
  };

  const handleDeletePatientRecommendation = async (_patientId: string, groupRecommendationId: string) => {
    try {
      await unassignRecommendation(groupRecommendationId);
      setPatientRecommendations(prev => prev.filter(r => r.groupRecommendationId !== groupRecommendationId));
      showNotification({ message: 'Recommendation removed from patient.', type: 'success' });
    } catch (err) {
      console.error('Failed to remove patient Recommendation:', err);
      showNotification({ message: 'Failed to remove patient Recommendation.', type: 'error' });
    }
  };

  const handleUpdatePatientDTP = async (dtpId: string, data: { title: string; expectedDTPText: string; clinicalIntent: string; evaluationCriteria: string; tags: string[]; isRequired: boolean }) => {
    try {
      await updateDTPItem(dtpId, data);
      setPatientDTPs(prev => prev.map(d => d.dtpId === dtpId ? { ...d, ...data } : d));
    } catch (err) {
      console.error('Failed to update patient DTP:', err);
      showNotification({ message: 'Failed to update DTP.', type: 'error' });
      throw err;
    }
  };

  const handleUpdatePatientRecommendation = async (recommendationId: string, data: { title: string; recommendationText: string; evaluationCriteria: string; rationale: string }) => {
    try {
      await updateRecommendationItem(recommendationId, data);
      setPatientRecommendations(prev => prev.map(r => r.recommendationId === recommendationId ? { ...r, ...data } : r));
    } catch (err) {
      console.error('Failed to update patient Recommendation:', err);
      showNotification({ message: 'Failed to update Recommendation.', type: 'error' });
      throw err;
    }
  };

  // ── Loading state ──
  if (loading) {
    return <DashboardSkeleton cardCount={4} />;
  }

  return (
    <PageContainer>
      {/* Header */}
      <header className="flex-shrink-0 flex border-b border-border items-center justify-between py-6 px-8" style={{ backgroundColor: UI_COLORS.header.background }}>
        <div className="flex items-center gap-4">
          <button onClick={() => setIsMainSidebarVisible(!isMainSidebarVisible)} className="p-2 rounded-lg transition-colors" style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary} aria-label="Toggle sidebar">
            <Menu className="w-5 h-5" />
          </button>
          <UserAvatar name={user.name} imageUrl={user.avatarUrl} size="medium" />
          <div className="flex flex-col items-start gap-0.5">
            <h1 className="font-bold tracking-tight leading-tight text-2xl" style={{ color: UI_COLORS.text.heading }}>Simulation Group View</h1>
            <button onClick={handleBackToAllGroups} className="font-normal text-sm flex items-center gap-1 bg-transparent border-0 cursor-pointer p-0 transition-colors" style={{ color: UI_COLORS.text.body }} onMouseEnter={e => e.currentTarget.style.color = UI_COLORS.text.heading} onMouseLeave={e => e.currentTarget.style.color = UI_COLORS.text.body}>
              <ArrowLeft className="w-4 h-4" /> Back to {organization?.name || 'Organization'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="default" onClick={handleInstructorView} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Instructor View</Button>
          <Button variant="default" onClick={handleStudentView} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Student View</Button>
          <Button variant="default" onClick={handleSignOut} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}>Sign Out</Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <SimulationGroupSidebar
          activeSection={activeSection}
          onSectionChange={section => setActiveSection(section as ActiveSection)}
          sections={[
            { id: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-5 h-5" /> },
            { id: 'patients', label: `Manage ${aiPersonaLabelPlural}`, icon: <Users className="w-5 h-5" /> },
            { id: 'students', label: `Manage ${userRoleLabel}s`, icon: <UserCog className="w-5 h-5" /> },
            { id: 'instructors', label: 'Manage Instructors', icon: <UserPlus className="w-5 h-5" /> },
            { id: 'questionBank', label: 'Question Bank', icon: <HelpCircle className="w-5 h-5" /> },
            { id: 'dtpBank', label: 'DTP Bank', icon: <Pill className="w-5 h-5" /> },
            { id: 'recommendationsBank', label: 'Recommendations Bank', icon: <ClipboardList className="w-5 h-5" /> },
            { id: 'issuesFeedback', label: 'Issues and Feedback', icon: <AlertTriangle className="w-5 h-5" /> },
            { id: 'prompts', label: 'Manage Prompts', icon: <FileCode className="w-5 h-5" /> },
          ]}
          accessCode={accessCode}
          onCopyAccessCode={handleCopyAccessCode}
          onGenerateAccessCode={() => setIsAccessCodeDialogOpen(true)}
          isVisible={isMainSidebarVisible}
          onToggleVisibility={() => setIsMainSidebarVisible(!isMainSidebarVisible)}
        />

        <main className="flex-1 overflow-y-auto" style={{ padding: ['rubric', 'questionBank', 'dtpBank', 'recommendationsBank', 'prompts', 'editPatient', 'viewStudent', 'issuesFeedback'].includes(activeSection) ? '0' : '2rem' }}>
          {activeSection === 'analytics' && (
            <Suspense fallback={<div className="p-8 text-sm" style={{ color: UI_COLORS.text.muted }}>Loading analytics…</div>}>
              <AnalyticsSection patientAnalytics={patientAnalytics} analyticsDateRange={analyticsDateRange} onDateRangeChange={setAnalyticsDateRange} keyQuestionCoverage={keyQuestionCoverage} keyQuestionAnalytics={keyQuestionAnalytics} dtpCoverage={dtpCoverage} recommendationCoverage={recommendationCoverage} dtpAnalytics={dtpAnalytics} recommendationAnalytics={recommendationAnalytics} studentProgress={studentProgress} selectedPatientId={selectedPatientId} onPatientSelect={setSelectedPatientId} labels={labels} simulationGroup={simulationGroup} onNavigateToSection={section => setActiveSection(section as ActiveSection)} />
            </Suspense>
          )}

          {activeSection === 'patients' && (
            <PatientsSection patients={manageablePatients} profilePictures={profilePictures} searchQuery={searchQuery} onSearchChange={setSearchQuery} onEditPatient={handleEditPatient} onDeletePatient={handleDeletePatient} onCreatePatient={handleCreateNewPatient} onTogglePatientVoice={handleTogglePatientVoice} labels={labels} enableVoiceForAll={enableVoiceForAll} onToggleVoice={async (newValue) => {
              for (const p of manageablePatients) {
                const pid = (p as any).id || (p as any).patient_id;
                await handleTogglePatientVoice(pid, newValue);
              }
            }}>
              {/* Max messages per chat setting */}
              <div className="border rounded-xl p-5 space-y-3" style={{ borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }}>
                <label className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>Max messages per conversation</label>
                <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>Limit the number of messages a student can send in a single conversation. Leave empty for unlimited.</p>
                <div className="flex items-center gap-3">
                  <Input type="number" min="1" placeholder="Unlimited" value={maxMessagesInput} onChange={e => setMaxMessagesInput(e.target.value)} className="w-32 text-base focus-visible:ring-0 focus-visible:ring-offset-0" style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default }} />
                  <Button onClick={async () => {
                    if (!groupId) return;
                    const parsed = maxMessagesInput.trim() === '' ? null : parseInt(maxMessagesInput, 10);
                    if (parsed !== null && (isNaN(parsed) || parsed < 1)) return;
                    try { await adminApi.updateGroupMessageLimit(groupId, parsed); setMaxMessagesPerChat(parsed); } catch (err) { console.error('Failed to update message limit:', err); }
                  }} disabled={(() => { const parsed = maxMessagesInput.trim() === '' ? null : parseInt(maxMessagesInput, 10); if (parsed !== null && (isNaN(parsed) || parsed < 1)) return true; return parsed === maxMessagesPerChat; })()} className="px-4 py-2 text-sm font-medium transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Save</Button>
                  {maxMessagesPerChat != null && (
                    <Button variant="outline" onClick={async () => { if (!groupId) return; try { await adminApi.updateGroupMessageLimit(groupId, null); setMaxMessagesPerChat(null); setMaxMessagesInput(''); } catch (err) { console.error('Failed to remove message limit:', err); } }} className="px-4 py-2 text-sm font-medium">Remove limit</Button>
                  )}
                </div>
                {maxMessagesPerChat != null && <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>Current limit: {maxMessagesPerChat} messages per conversation</p>}
              </div>
            </PatientsSection>
          )}

          {activeSection === 'students' && <StudentsSection students={students} searchQuery={studentSearchQuery} onSearchChange={setStudentSearchQuery} onViewStudent={handleViewStudent} labels={labels} />}

          {activeSection === 'instructors' && (
            <div className="space-y-6 max-w-5xl">
              <div className="flex gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" style={{ color: UI_COLORS.text.muted }} />
                  <Input placeholder="Search by Instructor Name" value={instructorSearchQuery} onChange={e => setInstructorSearchQuery(e.target.value)} className="pl-10 py-6 text-base focus-visible:ring-0 focus-visible:ring-offset-0" style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white }} />
                </div>
                <Button onClick={handleAddNewInstructor} className="px-6 py-6 gap-2 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>
                  <Plus className="w-5 h-5" /> Add Instructor
                </Button>
              </div>
              <div className="border rounded-lg overflow-hidden" style={{ borderColor: UI_COLORS.border.default }}>
                <div className="grid grid-cols-[2fr_3fr_auto] gap-4 px-6 py-4" style={{ backgroundColor: UI_COLORS.background.tableHeader }}>
                  {['Instructor Name', 'Email Address', 'Actions'].map(h => <div key={h} className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>{h}</div>)}
                </div>
                {instructorsLoading ? (
                  <div className="px-6 py-8 text-center"><LoadingIndicator size="sm" message="Loading instructors..." /></div>
                ) : filteredInstructors.length === 0 ? (
                  <div className="px-6 py-8 text-center" style={{ color: UI_COLORS.text.muted }}>{instructorSearchQuery ? 'No instructors match your search.' : 'No instructors assigned to this group yet.'}</div>
                ) : filteredInstructors.map(instructor => (
                  <div key={instructor.user_email} className="grid grid-cols-[2fr_3fr_auto] gap-4 px-6 py-4 border-t items-center" style={{ borderColor: UI_COLORS.border.default }}>
                    <div className="text-base" style={{ color: UI_COLORS.text.heading }}>{instructor.first_name} {instructor.last_name}</div>
                    <div className="text-base" style={{ color: UI_COLORS.text.heading }}>{instructor.user_email}</div>
                    <div>
                      <button onClick={() => handleRemoveInstructor(instructor.user_email)} className="p-2 rounded-md hover:bg-gray-100 transition-colors" style={{ border: 'none', cursor: 'pointer', backgroundColor: 'transparent' }} aria-label="Remove instructor from group" title="Remove from group">
                        <Trash2 className="w-5 h-5" style={{ color: UI_COLORS.status.error }} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'rubric' && <RubricSection questions={globalRubricQuestions} selectedQuestionId={selectedQuestionId} onSelectQuestion={setSelectedQuestionId} searchQuery={rubricSearchQuery} onSearchChange={setRubricSearchQuery} onSaveQuestion={handleSaveQuestion} onDeleteQuestion={handleDeleteQuestion} onUpdateField={handleUpdateQuestionField} />}

          {activeSection === 'questionBank' && (
            <QuestionBankSection questionBank={questionBank} role="admin" groupId={groupId || '1'} patients={manageablePatients}
              onToggleQuestionInclusion={handleToggleQuestionInclusion}
              onGlobalTabClick={() => { setIncludedQuestionIds(new Set(globalRubricQuestions.map(q => q.id))); }}
              onPatientSpecificTabClick={() => {
                if (selectedPatientForQuestionBank && groupId) {
                  instructorService.getSimulationGroupQuestions(groupId, selectedPatientForQuestionBank).then((assigned: any[]) => {
                    setIncludedQuestionIds(new Set(assigned.map((q: any) => q.question_id)));
                    for (const q of assigned) {
                      if (q.question_id && q.group_question_id) questionIdToGroupQuestionId.current.set(q.question_id, q.group_question_id);
                    }
                  }).catch(() => {});
                }
              }}
              onPatientSelect={(patientId) => {
                if (patientId && groupId) {
                  instructorService.getSimulationGroupQuestions(groupId, patientId).then((assigned: any[]) => {
                    setIncludedQuestionIds(new Set(assigned.map((q: any) => q.question_id)));
                    for (const q of assigned) {
                      if (q.question_id && q.group_question_id) questionIdToGroupQuestionId.current.set(q.question_id, q.group_question_id);
                    }
                  }).catch(() => {});
                }
              }}
            />
          )}

          {activeSection === 'dtpBank' && (
            <DTPBankSection
              dtpBank={dtpBank}
              role="admin"
              groupId={groupId || ''}
              patients={manageablePatients}
              onToggleDTPInclusion={handleToggleDTPInclusion}
              onGroupWideTabClick={() => {
                if (groupId) {
                  getAssignedDTPs(groupId).then((assignments) => {
                    const filtered = assignments.filter(a => !a.personaId);
                    setIncludedDTPIds(new Set(filtered.map(a => a.dtpId)));
                    dtpIdToGroupDtpId.current.clear();
                    for (const a of filtered) {
                      dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
                    }
                  }).catch(() => setIncludedDTPIds(new Set()));
                }
              }}
              onPatientSpecificTabClick={() => {
                if (selectedPatientForDTP && groupId) {
                  getAssignedDTPs(groupId, selectedPatientForDTP).then((assignments) => {
                    setIncludedDTPIds(new Set(assignments.map(a => a.dtpId)));
                    dtpIdToGroupDtpId.current.clear();
                    for (const a of assignments) {
                      dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
                    }
                  }).catch(() => setIncludedDTPIds(new Set()));
                }
              }}
              onPatientSelect={handleDTPPatientSelect}
            />
          )}

          {activeSection === 'recommendationsBank' && (
            <RecommendationsBankSection
              recommendationsBank={recommendationsBank}
              role="admin"
              groupId={groupId || ''}
              patients={manageablePatients}
              onToggleRecommendationInclusion={handleToggleRecommendationInclusion}
              onGroupWideTabClick={() => {
                if (groupId) {
                  getAssignedRecommendations(groupId).then((assignments) => {
                    const filtered = assignments.filter(a => !a.personaId);
                    setIncludedRecommendationIds(new Set(filtered.map(a => a.recommendationId)));
                    recIdToGroupRecId.current.clear();
                    for (const a of filtered) {
                      recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
                    }
                  }).catch(() => setIncludedRecommendationIds(new Set()));
                }
              }}
              onPatientSpecificTabClick={() => {
                if (selectedPatientForRecommendations && groupId) {
                  getAssignedRecommendations(groupId, selectedPatientForRecommendations).then((assignments) => {
                    setIncludedRecommendationIds(new Set(assignments.map(a => a.recommendationId)));
                    recIdToGroupRecId.current.clear();
                    for (const a of assignments) {
                      recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
                    }
                  }).catch(() => setIncludedRecommendationIds(new Set()));
                }
              }}
              onPatientSelect={handleRecommendationsPatientSelect}
            />
          )}

          {activeSection === 'issuesFeedback' && (
            <IssuesFeedbackSection
              issueReports={issueReports}
              debriefFeedback={debriefFeedbackList}
              loading={issuesFeedbackLoading}
              onDeleteIssueReport={async (reportId) => {
                try {
                  await adminApi.deleteIssueReport(reportId);
                  setIssueReports((prev) => prev.filter((r) => r.report_id !== reportId));
                } catch (err) {
                  console.error('Failed to delete issue report:', err);
                }
              }}
              onDeleteDebriefFeedback={async (feedbackId) => {
                try {
                  await adminApi.deleteDebriefFeedback(feedbackId);
                  setDebriefFeedbackList((prev) => prev.filter((f) => f.feedback_id !== feedbackId));
                } catch (err) {
                  console.error('Failed to delete debrief feedback:', err);
                }
              }}
            />
          )}

          {activeSection === 'prompts' && (
            <div className="flex h-full relative">
              <aside className="flex flex-col border-r" style={{ backgroundColor: UI_COLORS.background.white, borderRightWidth: '1px', borderRightStyle: 'solid', borderRightColor: UI_COLORS.border.default, width: '16rem', minWidth: '16rem' }}>
                <div className="p-6">
                  <h3 className="text-sm font-semibold mb-4" style={{ color: UI_COLORS.text.heading }}>Prompt Type</h3>
                  <div className="space-y-2">
                    {(['system', 'evaluation'] as const).map(type => (
                      <Button key={type} onClick={() => setSelectedPromptType(type)} variant="ghost" className="w-full justify-start gap-3 px-4 py-2.5 h-auto font-medium" style={{ backgroundColor: selectedPromptType === type ? UI_COLORS.background.tableHeader : 'transparent', color: UI_COLORS.text.heading }}>
                        {type === 'system' ? 'System Prompt' : 'Debrief Prompt'}
                      </Button>
                    ))}
                  </div>
                </div>
              </aside>
              <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-4xl space-y-8">
                  <div>
                    <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>{selectedPromptType === 'system' ? 'System Prompt' : 'Debrief Prompt'}</h2>
                    <div className="space-y-4">
                      <label className="text-sm font-medium" style={{ color: UI_COLORS.text.heading }}>Edit Prompt</label>
                      <textarea value={String(selectedPromptType === 'system' ? systemPromptText : evaluationPromptText)} onChange={e => { if (selectedPromptType === 'system') { setSystemPromptText(e.target.value); } else { setEvaluationPromptText(e.target.value); } setIsPromptUnsaved(true); }} placeholder={selectedPromptType === 'evaluation' ? 'No custom debrief prompt configured.' : 'Leave empty to use the default patient behavior prompt. The AI will respond briefly, stay in character, and follow standard clinical simulation guidelines.'} rows={6} className="w-full px-4 py-3 rounded-md resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2" style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white, color: UI_COLORS.text.heading }} />
                      <div className="flex gap-3 justify-end">
                        <Button onClick={handleLoadDefaultPrompt} variant="outline" className="px-6 transition-colors" style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading, backgroundColor: UI_COLORS.background.white }}>Load Default Prompt</Button>
                        <Button onClick={handleSavePrompt} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Save Prompt</Button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold mb-4" style={{ color: UI_COLORS.text.heading }}>{selectedPromptType === 'system' ? 'System' : 'Debrief'} Prompt History</h3>
                    <p className="text-sm mb-6" style={{ color: UI_COLORS.text.muted }}>Browse earlier versions. Restore any version you want to use.</p>
                    {promptHistory.length === 0 && <p className="text-sm italic" style={{ color: UI_COLORS.text.muted }}>No history yet. Save a prompt to start tracking changes.</p>}
                    {promptHistory.map((version, index) => (
                      <div key={version.id} className="border rounded-lg p-6 mb-4" style={{ borderColor: UI_COLORS.border.default }}>
                        <textarea value={String(version.text)} readOnly placeholder="Prompt goes here..." rows={4} className="w-full px-4 py-3 rounded-md resize-none mb-4" style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.tableHeader, color: UI_COLORS.text.heading }} />
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <span className="text-sm" style={{ color: UI_COLORS.text.muted }}>Version {index + 1} of {promptHistory.length}</span>
                            <span className="text-sm" style={{ color: UI_COLORS.text.muted }}>Saved: {new Date(version.saved_at).toLocaleString()}</span>
                            {version.modified_by_email && <span className="text-sm" style={{ color: UI_COLORS.text.muted }}>by {version.modified_by_first_name && version.modified_by_last_name ? `${version.modified_by_first_name} ${version.modified_by_last_name}` : version.modified_by_email}</span>}
                          </div>
                          <Button onClick={() => handleRestorePromptVersion(version.text)} variant="outline" className="px-6 transition-colors" style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading, backgroundColor: UI_COLORS.background.white }}>Restore This Version</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedPromptType === 'evaluation' && groupId && (
                    <PromptPlayground
                      simulationGroupId={groupId}
                      currentDebriefPrompt={evaluationPromptText}
                    />
                  )}
                  {selectedPromptType === 'system' && groupId && (
                    <SystemPromptPlayground
                      simulationGroupId={groupId}
                      currentSystemPrompt={systemPromptText}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'editPatient' && <EditPatientPanel patientEditor={patientEditor} profilePictures={profilePictures} onBack={handleBackFromEditPatient} labels={labels} groupId={groupId || ''} globalRubricQuestions={globalRubricQuestions} onSavePatient={handleSavePatientChanges} onSaveCaseQuestion={(pid, q) => instructorService.updateCaseSpecificQuestion(pid, q)} onDeleteCaseQuestion={(pid, qid) => instructorService.deleteCaseSpecificQuestion(pid, qid)} onCreatePatientDTP={handleCreatePatientDTP} onUpdatePatientDTP={handleUpdatePatientDTP} onDeletePatientDTP={handleDeletePatientDTP} patientDTPs={patientDTPs} groupDTPs={groupDTPs} onLoadPatientDTPs={handleLoadPatientDTPs} onCreatePatientRecommendation={handleCreatePatientRecommendation} onUpdatePatientRecommendation={handleUpdatePatientRecommendation} onDeletePatientRecommendation={handleDeletePatientRecommendation} patientRecommendations={patientRecommendations} groupRecommendations={groupRecommendations} onLoadPatientRecommendations={handleLoadPatientRecommendations} />}
          {activeSection === 'viewStudent' && studentViewer.selectedStudentId && <StudentDetailsPanel studentDetails={studentViewer.studentDetails} studentDetailsLoading={studentViewer.studentDetailsLoading} studentPatientData={studentViewer.studentPatientData} expandedAttemptId={studentViewer.expandedAttemptId} onExpandAttempt={studentViewer.setExpandedAttemptId} selectedPatientFilter={studentViewer.selectedPatientFilter} onPatientFilterChange={studentViewer.setSelectedPatientFilter} onViewDebrief={debriefViewer.viewDebrief} isFetchingDebrief={debriefViewer.isFetchingDebrief} onDownloadPdf={async (attemptId) => { const el = debriefViewer.attemptPdfRefs.current[String(attemptId)]; if (el) await debriefViewer.downloadPdf(attemptId, el); }} isGeneratingPdf={debriefViewer.isGeneratingPdf} onBack={handleBackFromViewStudent} attemptPdfRefs={debriefViewer.attemptPdfRefs} labels={labels} />}
        </main>
      </div>

      <AIDebriefDialog isOpen={debriefViewer.isAIDebriefOpen} onClose={debriefViewer.closeDebrief} data={debriefViewer.selectedDebriefData} updatedDebriefData={debriefViewer.selectedUpdatedDebriefData} simulationGroupId={groupId} patientMode={debriefViewer.selectedUpdatedDebriefData?.chunk2 ? 'full_assessment' : 'interview_practice'} />
      <AddQuestionDialog open={isAddQuestionDialogOpen} onOpenChange={setIsAddQuestionDialogOpen} questionType={addQuestionType} existingTags={allExistingTags} onSave={handleSaveNewQuestion} />
      <AddPatientSpecificQuestionDialog open={isAddPatientQuestionDialogOpen} onOpenChange={setIsAddPatientQuestionDialogOpen} patients={manageablePatients.map(p => ({ id: p.patient_id, name: p.patient_name }))} onSave={handleSaveNewPatientQuestion} />
      <AddInstructorDialog open={isAddInstructorDialogOpen} onOpenChange={setIsAddInstructorDialogOpen} onAddInstructor={handleAddInstructorSubmit} existingInstructorEmails={instructors.map(i => i.user_email)} />
      <AddDTPDialog open={dtpBank.isAddDialogOpen} onOpenChange={dtpBank.setIsAddDialogOpen} onSave={handleSaveNewDTPItem} />
      <AddRecommendationDialog open={recommendationsBank.isAddDialogOpen} onOpenChange={recommendationsBank.setIsAddDialogOpen} onSave={handleSaveNewRecommendationItem} />

      <Dialog open={isAccessCodeDialogOpen} onOpenChange={setIsAccessCodeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Generate New Access Code</DialogTitle>
            <DialogDescription style={{ color: UI_COLORS.text.body }}>Are you sure? This will permanently replace the current access code. Any students using the old code will no longer be able to join.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAccessCodeDialogOpen(false)} style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={async () => { setIsAccessCodeDialogOpen(false); await handleGenerateAccessCode(); }} style={{ backgroundColor: UI_COLORS.status.error, color: UI_COLORS.button.text }}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Patient Confirmation Dialog */}
      <Dialog open={deletePatientConfirm.open} onOpenChange={(open) => setDeletePatientConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Delete {labels.aiPersona}</DialogTitle>
            <DialogDescription style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to delete "{deletePatientConfirm.patientName}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletePatientConfirm(prev => ({ ...prev, open: false }))} style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={handleConfirmDeletePatient} style={{ backgroundColor: '#ef4444', color: '#fff' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Instructor Confirmation Dialog */}
      <Dialog open={removeInstructorConfirm.open} onOpenChange={(open) => setRemoveInstructorConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Remove Instructor</DialogTitle>
            <DialogDescription style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove {removeInstructorConfirm.displayName} from this group?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveInstructorConfirm(prev => ({ ...prev, open: false }))} style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={handleConfirmRemoveInstructor} style={{ backgroundColor: '#ef4444', color: '#fff' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Prompt Confirmation Dialog */}
      <Dialog open={restorePromptConfirm.open} onOpenChange={(open) => setRestorePromptConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Restore Prompt Version</DialogTitle>
            <DialogDescription style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to restore this version? Your current unsaved changes will be overwritten.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestorePromptConfirm(prev => ({ ...prev, open: false }))} style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={handleConfirmRestorePrompt} style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Rubric Question Confirmation Dialog */}
      <Dialog open={deleteQuestionConfirm.open} onOpenChange={(open) => setDeleteQuestionConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>Remove Group-Wide Question</DialogTitle>
            <DialogDescription style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to remove "{deleteQuestionConfirm.questionTitle}" from the group-wide rubric? It will remain in the question bank.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteQuestionConfirm(prev => ({ ...prev, open: false }))} style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}>Cancel</Button>
            <Button onClick={handleConfirmDeleteQuestion} style={{ backgroundColor: '#ef4444', color: '#fff' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default AdminSimulationGroupPage;
