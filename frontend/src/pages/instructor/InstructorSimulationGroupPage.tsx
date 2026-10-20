import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { ArrowLeft, BarChart3, Users, UserCog, Menu, HelpCircle, Pill, ClipboardList, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { useAuth } from '@/App';
import { instructorService, type GlobalRubricQuestion, type QuestionBankItem } from '@/services/instructorService';
import { studentService } from '@/services/studentService';
import { DashboardSkeleton } from '@/components/skeletons';
import { UI_COLORS } from '@/lib/colors';
import { useSimulationGroupData } from '@/hooks/useSimulationGroupData';
import { usePatientEditor } from '@/hooks/usePatientEditor';
import { useQuestionBank } from '@/hooks/useQuestionBank';
import { useDTPBank } from '@/hooks/useDTPBank';
import { useRecommendationsBank } from '@/hooks/useRecommendationsBank';
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
import { DTPBankSection } from '@/components/simulation-group/DTPBankSection';
import { RecommendationsBankSection } from '@/components/simulation-group/RecommendationsBankSection';
import { AddQuestionDialog } from '@/components/AddQuestionDialog';
import { AddPatientSpecificQuestionDialog } from '@/components/AddPatientSpecificQuestionDialog';
import AIDebriefDialog from '../../components/AIDebriefDialog';
import { useNotification } from '@/components/notifications';
import { listDTPItemsAsInstructor, assignDTPToGroup, assignDTPToPatient, getAssignedDTPs, unassignDTP, createDTPItem, updateDTPItem } from '@/services/dtpBankService';
import type { DTPAssignment } from '@/services/dtpBankService';
import { listRecommendationItemsAsInstructor, assignRecommendationToGroup, assignRecommendationToPatient, getAssignedRecommendations, unassignRecommendation, createRecommendationItem, updateRecommendationItem } from '@/services/recommendationsBankService';
import type { RecommendationAssignment } from '@/services/recommendationsBankService';

type ActiveSection = 'analytics' | 'patients' | 'students' | 'rubric' | 'questionBank' | 'dtpBank' | 'recommendationsBank' | 'prompt' | 'editPatient' | 'viewStudent';

/**
 * InstructorSimulationGroupPage — thin shell composing shared hooks and components.
 * Instructor-specific: debrief prompt section, voice toggle, access code dialog.
 */
function InstructorSimulationGroupPage() {
  const navigate = useNavigate();
  const { signOut, user: authUser } = useAuth();
  const { groupId } = useParams();
  const [searchParams] = useSearchParams();
  const adminReturnUrl = searchParams.get('returnUrl');
  const { showNotification } = useNotification();

  // Section navigation
  const [activeSection, setActiveSection] = useState<ActiveSection>('analytics');
  const [isMainSidebarVisible, setIsMainSidebarVisible] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [studentSearchQuery, setStudentSearchQuery] = useState('');

  // Shared hooks
  const groupData = useSimulationGroupData({ groupId, role: 'instructor' });
  const patientEditor = usePatientEditor({
    groupId, role: 'instructor',
    manageablePatients: groupData.manageablePatients, setManageablePatients: groupData.setManageablePatients,
    profilePictures: groupData.profilePictures, setProfilePictures: groupData.setProfilePictures,
    reloadPatients: groupData.reloadPatients,
  });
  const questionBank = useQuestionBank({ role: 'instructor' });
  const dtpBank = useDTPBank({ role: 'instructor' });
  const recommendationsBank = useRecommendationsBank({ role: 'instructor' });
  const studentViewer = useStudentViewer({ groupId, groupName: groupData.simulationGroup?.group_name });
  const debriefViewer = useDebriefViewer({ groupId });

  // Instructor-specific: prompts
  const [systemPromptText, setSystemPromptText] = useState('');
  const [debriefPromptText, setDebriefPromptText] = useState('');
  const [selectedPromptType, setSelectedPromptType] = useState<'system' | 'debrief'>('system');

  // Global rubric state
  const [globalRubricQuestions, setGlobalRubricQuestions] = useState<GlobalRubricQuestion[]>(() =>
    instructorService.getGlobalRubricQuestions(groupId || '1')
  );
  // Mapping from question bank ID → group_question_id (assignment record ID) for unassign
  const questionIdToGroupQuestionId = useRef<Map<string, string>>(new Map());
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(() => {
    const questions = instructorService.getGlobalRubricQuestions(groupId || '1');
    return questions[0]?.id || null;
  });
  const [rubricSearchQuery, setRubricSearchQuery] = useState('');
  const [isAccessCodeDialogOpen, setIsAccessCodeDialogOpen] = useState(false);

  const { labels, simulationGroup, setSimulationGroup, manageablePatients, profilePictures, students,
    patientAnalytics, analyticsDateRange, setAnalyticsDateRange, keyQuestionCoverage,
    keyQuestionAnalytics, dtpCoverage, recommendationCoverage, dtpAnalytics, recommendationAnalytics,
    studentProgress, selectedPatientId, setSelectedPatientId, loading, user,
  } = groupData;

  const { includedQuestionIds, setIncludedQuestionIds, pendingQuestionIds, setPendingQuestionIds,
    questionBankTab, globalBankQuestions, patientSpecificBankQuestions, setPatientSpecificBankQuestions,
    allExistingTags, setGlobalBankQuestions, setQuestionBankLoading, setQuestionBankError,
    isAddQuestionDialogOpen, setIsAddQuestionDialogOpen,
    isAddPatientQuestionDialogOpen, setIsAddPatientQuestionDialogOpen,
    selectedPatientForQuestionBank,
  } = questionBank;

  const { aiPersonaLabelLower, aiPersonaPlural: aiPersonaLabelPlural, userRole: userRoleLabel } = {
    aiPersonaLabelLower: labels.aiPersonaLower, aiPersonaPlural: labels.aiPersonaPlural, userRole: labels.userRole,
  };

  const accessCode = simulationGroup?.group_access_code || 'XXXX-XXXX-XXXX-XXXX';
  const hasAdminRole = authUser?.groups.includes('admin') || false;
  const selectedQuestion = globalRubricQuestions.find(q => q.id === selectedQuestionId);
  const enableVoiceForAll = manageablePatients.length > 0 && manageablePatients.every((p: any) => p.voice_enabled !== false);

  // ── Load prompts ──
  useEffect(() => {
    if (!groupId) return;
    (async () => {
      try {
        const [systemPrompt, debriefPrompt] = await Promise.all([
          instructorService.getEvaluationPrompt(groupId),
          instructorService.getDebriefPrompt(groupId),
        ]);
        setSystemPromptText(systemPrompt);
        setDebriefPromptText(debriefPrompt);
      } catch (error) { console.error('Error loading prompts:', error); }
    })();
  }, [groupId]);

  // ── Load question bank data ──
  useEffect(() => {
    if (activeSection !== 'questionBank') return;
    (async () => {
      try {
        setQuestionBankLoading(true); setQuestionBankError(null);
        const questions = await instructorService.getGlobalQuestionBank();
        setGlobalBankQuestions(questions.filter(q => !q.tags?.includes('patient_specific')));
        setPatientSpecificBankQuestions(questions.filter(q => q.tags?.includes('patient_specific')));
      } catch (err) {
        setQuestionBankError(err instanceof Error ? err.message : 'Failed to load question bank');
      } finally { setQuestionBankLoading(false); }
    })();
  }, [activeSection]);

  // ── Load assigned questions ──
  useEffect(() => {
    if ((activeSection === 'rubric' || activeSection === 'questionBank' || activeSection === 'editPatient') && groupId) {
      instructorService.getSimulationGroupQuestions(groupId)
        .then((assigned: any[]) => {
          const globalAssigned = assigned.filter((q: any) => !q.persona_id);
          const rubricQuestions: GlobalRubricQuestion[] = globalAssigned.map((q: any) => ({
            id: q.question_id, group_question_id: q.group_question_id,
            title: q.title || '', keyQuestion: q.question_text || '',
            clinicalIntent: '', evaluationCriteria: q.evaluation_criteria || '',
            required: q.is_mandatory ?? false,
          }));
          setGlobalRubricQuestions(rubricQuestions);
          setIncludedQuestionIds(new Set(globalAssigned.map((q: any) => q.question_id)));
          setPendingQuestionIds(new Set(globalAssigned.map((q: any) => q.question_id)));
          // Build questionId → groupQuestionId mapping
          const map = new Map<string, string>();
          for (const q of globalAssigned) {
            if (q.question_id && q.group_question_id) map.set(q.question_id, q.group_question_id);
          }
          questionIdToGroupQuestionId.current = map;
          if (rubricQuestions.length > 0 && !selectedQuestionId) setSelectedQuestionId(rubricQuestions[0].id);
        })
        .catch((err: any) => console.error('Failed to load assigned questions:', err));
    }
  }, [activeSection, groupId]);

  // ── DTP Bank: mapping from DTP item ID → group_dtp_id for unassign ──
  const dtpIdToGroupDtpId = useRef<Map<string, string>>(new Map());

  // ── Recommendations Bank: mapping from Recommendation item ID → group_recommendation_id for unassign ──
  const recIdToGroupRecId = useRef<Map<string, string>>(new Map());

  // ── Load DTP bank items when section becomes active ──
  useEffect(() => {
    if (activeSection !== 'dtpBank' || !groupId) return;
    const orgId = simulationGroup?.organization_id;
    if (orgId) {
      dtpBank.setLoading(true);
      listDTPItemsAsInstructor(orgId).then((items) => {
        dtpBank.setDtpItems(items);
        dtpBank.setLoading(false);
      }).catch(() => dtpBank.setLoading(false));
    }
    // Load assignments (group-wide by default)
    getAssignedDTPs(groupId).then((assignments) => {
      const filtered = assignments.filter(a => !a.personaId);
      dtpBank.setIncludedIds(new Set(filtered.map(a => a.dtpId)));
      dtpBank.setPendingIds(new Set(filtered.map(a => a.dtpId)));
      dtpIdToGroupDtpId.current.clear();
      for (const a of filtered) dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
    }).catch(() => dtpBank.setIncludedIds(new Set()));
  }, [activeSection, groupId, simulationGroup?.organization_id]);

  // ── Load Recommendations bank items when section becomes active ──
  useEffect(() => {
    if (activeSection !== 'recommendationsBank' || !groupId) return;
    const orgId = simulationGroup?.organization_id;
    if (orgId) {
      recommendationsBank.setLoading(true);
      listRecommendationItemsAsInstructor(orgId).then((items) => {
        recommendationsBank.setRecommendationItems(items);
        recommendationsBank.setLoading(false);
      }).catch(() => recommendationsBank.setLoading(false));
    }
    // Load assignments (group-wide by default)
    getAssignedRecommendations(groupId).then((assignments) => {
      const filtered = assignments.filter(a => !a.personaId);
      recommendationsBank.setIncludedIds(new Set(filtered.map(a => a.recommendationId)));
      recommendationsBank.setPendingIds(new Set(filtered.map(a => a.recommendationId)));
      recIdToGroupRecId.current.clear();
      for (const a of filtered) recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
    }).catch(() => recommendationsBank.setIncludedIds(new Set()));
  }, [activeSection, groupId, simulationGroup?.organization_id]);

  // ── DTP Bank: confirm selections handler ──
  const handleConfirmDTPSelections = async () => {
    if (!groupId) return;
    try {
      const idsToAdd = [...dtpBank.pendingIds].filter(id => !dtpBank.includedIds.has(id));
      const idsToRemove = [...dtpBank.includedIds].filter(id => !dtpBank.pendingIds.has(id));

      for (const id of idsToAdd) {
        const result = dtpBank.selectedPatientId
          ? await assignDTPToPatient(id, groupId, dtpBank.selectedPatientId)
          : await assignDTPToGroup(id, groupId);
        if (result?.groupDtpId) dtpIdToGroupDtpId.current.set(id, result.groupDtpId);
      }
      for (const id of idsToRemove) {
        const groupDtpId = dtpIdToGroupDtpId.current.get(id);
        if (groupDtpId) {
          await unassignDTP(groupDtpId);
          dtpIdToGroupDtpId.current.delete(id);
        }
      }
      dtpBank.setIncludedIds(new Set(dtpBank.pendingIds));
      showNotification({ message: 'DTP selections confirmed.', type: 'success' });
    } catch (err) {
      console.error('Failed to confirm DTP selections:', err);
      showNotification({ message: 'Failed to confirm DTP selections.', type: 'error' });
    }
  };

  // ── Recommendations Bank: confirm selections handler ──
  const handleConfirmRecommendationSelections = async () => {
    if (!groupId) return;
    try {
      const idsToAdd = [...recommendationsBank.pendingIds].filter(id => !recommendationsBank.includedIds.has(id));
      const idsToRemove = [...recommendationsBank.includedIds].filter(id => !recommendationsBank.pendingIds.has(id));

      for (const id of idsToAdd) {
        const result = recommendationsBank.selectedPatientId
          ? await assignRecommendationToPatient(id, groupId, recommendationsBank.selectedPatientId)
          : await assignRecommendationToGroup(id, groupId);
        if (result?.groupRecommendationId) recIdToGroupRecId.current.set(id, result.groupRecommendationId);
      }
      for (const id of idsToRemove) {
        const groupRecId = recIdToGroupRecId.current.get(id);
        if (groupRecId) {
          await unassignRecommendation(groupRecId);
          recIdToGroupRecId.current.delete(id);
        }
      }
      recommendationsBank.setIncludedIds(new Set(recommendationsBank.pendingIds));
      showNotification({ message: 'Recommendation selections confirmed.', type: 'success' });
    } catch (err) {
      console.error('Failed to confirm Recommendation selections:', err);
      showNotification({ message: 'Failed to confirm Recommendation selections.', type: 'error' });
    }
  };

  // ── DTP/Rec tab sync helpers ──
  const syncDTPGroupWideIds = () => {
    if (!groupId) return;
    getAssignedDTPs(groupId).then((assignments) => {
      const filtered = assignments.filter(a => !a.personaId);
      dtpBank.setIncludedIds(new Set(filtered.map(a => a.dtpId)));
      dtpBank.setPendingIds(new Set(filtered.map(a => a.dtpId)));
      dtpIdToGroupDtpId.current.clear();
      for (const a of filtered) dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
    }).catch(() => { dtpBank.setIncludedIds(new Set()); dtpBank.setPendingIds(new Set()); });
  };

  const syncDTPPatientIds = (patientId: string | null) => {
    if (!groupId || !patientId) { dtpBank.setIncludedIds(new Set()); dtpBank.setPendingIds(new Set()); return; }
    getAssignedDTPs(groupId, patientId).then((assignments) => {
      dtpBank.setIncludedIds(new Set(assignments.map(a => a.dtpId)));
      dtpBank.setPendingIds(new Set(assignments.map(a => a.dtpId)));
      dtpIdToGroupDtpId.current.clear();
      for (const a of assignments) dtpIdToGroupDtpId.current.set(a.dtpId, a.groupDtpId);
    }).catch(() => { dtpBank.setIncludedIds(new Set()); dtpBank.setPendingIds(new Set()); });
  };

  const syncRecGroupWideIds = () => {
    if (!groupId) return;
    getAssignedRecommendations(groupId).then((assignments) => {
      const filtered = assignments.filter(a => !a.personaId);
      recommendationsBank.setIncludedIds(new Set(filtered.map(a => a.recommendationId)));
      recommendationsBank.setPendingIds(new Set(filtered.map(a => a.recommendationId)));
      recIdToGroupRecId.current.clear();
      for (const a of filtered) recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
    }).catch(() => { recommendationsBank.setIncludedIds(new Set()); recommendationsBank.setPendingIds(new Set()); });
  };

  const syncRecPatientIds = (patientId: string | null) => {
    if (!groupId || !patientId) { recommendationsBank.setIncludedIds(new Set()); recommendationsBank.setPendingIds(new Set()); return; }
    getAssignedRecommendations(groupId, patientId).then((assignments) => {
      recommendationsBank.setIncludedIds(new Set(assignments.map(a => a.recommendationId)));
      recommendationsBank.setPendingIds(new Set(assignments.map(a => a.recommendationId)));
      recIdToGroupRecId.current.clear();
      for (const a of assignments) recIdToGroupRecId.current.set(a.recommendationId, a.groupRecommendationId);
    }).catch(() => { recommendationsBank.setIncludedIds(new Set()); recommendationsBank.setPendingIds(new Set()); });
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
    const orgId = simulationGroup?.organization_id;
    if (!orgId || !groupId) return;
    try {
      const created = await createDTPItem(orgId, data);
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
    const orgId = simulationGroup?.organization_id;
    if (!orgId || !groupId) return;
    try {
      const created = await createRecommendationItem(orgId, { ...data, tags: data.tags ?? [] });
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
      // Update local state to reflect the change
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
      // Update local state to reflect the change
      setPatientRecommendations(prev => prev.map(r => r.recommendationId === recommendationId ? { ...r, ...data } : r));
    } catch (err) {
      console.error('Failed to update patient Recommendation:', err);
      showNotification({ message: 'Failed to update Recommendation.', type: 'error' });
      throw err;
    }
  };

  // ── Navigation handlers ──
  const handleSignOut = async () => { await signOut(); };
  const handleBackToAllGroups = () => navigate('/instructor');
  const handleStudentView = async () => {
    const instructorReturnUrl = `/instructor/group/${groupId}`;
    if (groupId && accessCode && accessCode !== 'XXXX-XXXX-XXXX-XXXX') {
      const result = await studentService.joinGroup(accessCode, 'preview');
      if (result?.success) { navigate(`/patients/${groupId}`, { state: { adminReturnUrl: instructorReturnUrl } }); return; }
      showNotification({ message: 'Unable to join this simulation group as a student. Redirecting to your student dashboard.', type: 'warning' });
    }
    navigate('/student');
  };
  const handleAdminView = () => {
    const orgId = simulationGroup?.organization_id;
    orgId && groupId ? navigate(`/admin/organization/${orgId}/group/${groupId}`) : navigate('/admin');
  };
  const handleCopyAccessCode = () => navigator.clipboard.writeText(accessCode);
  const handleGenerateAccessCode = async () => {
    if (!groupId) return;
    try {
      await instructorService.generateAccessCode(groupId);
      setSimulationGroup(await instructorService.getSimulationGroup(groupId));
    } catch (error) { console.error('Error generating access code:', error); }
  };

  // ── Patient / student section handlers ──
  const [deletePatientConfirm, setDeletePatientConfirm] = useState<{ open: boolean; patientId: string; patientName: string }>({
    open: false, patientId: '', patientName: ''
  });
  const handleDeletePatient = (patientId: string) => {
    const patient = manageablePatients.find(p => p.id === patientId || (p as any).patient_id === patientId);
    setDeletePatientConfirm({ open: true, patientId, patientName: patient?.name || aiPersonaLabelLower });
  };
  const handleConfirmDeletePatient = () => {
    groupData.setManageablePatients(prev => prev.filter(p => p.id !== deletePatientConfirm.patientId));
    instructorService.deletePatient(deletePatientConfirm.patientId);
    setDeletePatientConfirm({ open: false, patientId: '', patientName: '' });
  };
  const handleEditPatient = (patientId: string) => {
    patientEditor.startEditing(patientId);
    const questionIds = instructorService.getPatientCaseSpecificQuestionIds(patientId);
    setIncludedQuestionIds(questionIds); setPendingQuestionIds(new Set(questionIds));
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
      prev.map(p => (p.id === patientId || p.patient_id === patientId) ? { ...p, voice_enabled: enabled } : p)
    );
    if (groupId) {
      try { await instructorService.updatePatientVoiceEnabled(patientId, groupId, enabled); }
      catch (err) { console.error('Failed to update voice setting:', err); }
    }
  };
  const handleViewStudent = async (studentId: string) => { await studentViewer.viewStudent(studentId); setActiveSection('viewStudent'); };
  const handleBackFromViewStudent = () => { studentViewer.closeStudentView(); setActiveSection('students'); };

  // ── Rubric handlers ──
  const handleSaveQuestion = async () => {
    if (!selectedQuestion) return;
    try { await instructorService.updateGlobalRubricQuestion(groupId || '1', selectedQuestion); showNotification({ message: 'Question saved successfully.', type: 'success' }); }
    catch { showNotification({ message: 'Failed to save question. Please try again.', type: 'error' }); }
  };
  const handleUpdateQuestionField = (field: keyof GlobalRubricQuestion, value: string | boolean) => {
    if (!selectedQuestionId) return;
    setGlobalRubricQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, [field]: value } : q));
  };

  // ── Question bank handlers (complex business logic) ──
  const handleSaveNewGlobalQuestion = async (question: { title: string; keyQuestion: string; clinicalIntent: string; evaluationCriteria: string; required: boolean }) => {
    const orgId = simulationGroup?.organization_id;
    if (!orgId) {
      showNotification({ message: 'Organization not available. Please try again.', type: 'error' });
      return;
    }
    try {
      await instructorService.createQuestionBankQuestion(orgId, {
        title: question.title,
        question_text: question.keyQuestion,
        evaluation_criteria: question.evaluationCriteria,
        is_mandatory: question.required,
      });
      const questions = await instructorService.getGlobalQuestionBank();
      setGlobalBankQuestions(questions.filter(q => !q.tags?.includes('patient_specific')));
      showNotification({ message: 'Question added to bank successfully.', type: 'success' });
    } catch (error) {
      console.error('Failed to add global question:', error);
      showNotification({ message: 'Failed to add question. Please try again.', type: 'error' });
    }
  };

  const handleSaveNewPatientQuestion = (question: { patientId: string; title: string; keyQuestion: string; clinicalIntent: string; evaluationCriteria: string; required: boolean }) => {
    const newQuestionId = `bank-patient-${Date.now()}`;
    const newBankQuestion: any = { id: newQuestionId, title: question.title, questionText: question.keyQuestion, clinicalIntent: question.clinicalIntent, evaluationCriteria: question.evaluationCriteria, isMandatory: question.required, isActive: true, usedBySimulationGroups: [], usedByPatients: [] };
    instructorService.addToPatientSpecificQuestionBank(newBankQuestion);
    setPatientSpecificBankQuestions(instructorService.getPatientSpecificQuestionBank());
    const newCaseQuestion: GlobalRubricQuestion = { id: newQuestionId, title: question.title, keyQuestion: question.keyQuestion, clinicalIntent: question.clinicalIntent, evaluationCriteria: question.evaluationCriteria, required: question.required };
    instructorService.addCaseSpecificQuestion(question.patientId, newCaseQuestion);
    if (questionBankTab === 'patientSpecific' && selectedPatientForQuestionBank === question.patientId) {
      setIncludedQuestionIds(prev => { const s = new Set(prev); s.add(newQuestionId); return s; });
    }
    if (patientEditor.selectedPatientForEdit === question.patientId) {
      patientEditor.setCaseSpecificQuestions(instructorService.getCaseSpecificQuestions(question.patientId));
    }
  };

  const handleToggleQuestionInclusion = async (questionId: string, bankQuestion: QuestionBankItem, isChecked: boolean) => {
    const newSet = new Set(includedQuestionIds);
    try {
      if (isChecked) {
        newSet.add(questionId);
        if (questionBankTab === 'global' || questionId.startsWith('bank-global-')) {
          const result = await instructorService.assignQuestionToGroup(groupId || '1', questionId);
          // Store the new group_question_id in the mapping
          if (result?.group_question_id) {
            questionIdToGroupQuestionId.current.set(questionId, result.group_question_id);
          } else if (Array.isArray(result) && result[0]?.group_question_id) {
            questionIdToGroupQuestionId.current.set(questionId, result[0].group_question_id);
          }
          if (!globalRubricQuestions.find(q => q.id === questionId)) {
            instructorService.addGlobalRubricQuestion(groupId || '1', { id: questionId, title: bankQuestion.title, keyQuestion: bankQuestion.questionText, clinicalIntent: bankQuestion.clinicalIntent, evaluationCriteria: bankQuestion.evaluationCriteria, required: bankQuestion.isMandatory });
            setGlobalRubricQuestions(instructorService.getGlobalRubricQuestions(groupId || '1'));
          }
        }
      } else {
        newSet.delete(questionId);
        if (questionBankTab === 'global' || questionId.startsWith('bank-global-')) {
          const groupQuestionId = questionIdToGroupQuestionId.current.get(questionId);
          if (!groupQuestionId) {
            console.error('No group_question_id found for question:', questionId);
            return;
          }
          await instructorService.unassignQuestion(groupQuestionId);
          questionIdToGroupQuestionId.current.delete(questionId);
          instructorService.deleteGlobalRubricQuestion(groupId || '1', questionId);
          setGlobalRubricQuestions(instructorService.getGlobalRubricQuestions(groupId || '1'));
        }
      }
      setIncludedQuestionIds(newSet);
    } catch (err) { setQuestionBankError(err instanceof Error ? err.message : 'Failed to update question assignment'); }
  };

  const handleConfirmSelections = async () => {
    const allBankQuestions = questionBankTab === 'global' ? globalBankQuestions : patientSpecificBankQuestions;
    try {
      if (questionBankTab === 'global') {
        const idsToAdd = Array.from(pendingQuestionIds).filter(id => !includedQuestionIds.has(id));
        const idsToRemove = Array.from(includedQuestionIds).filter(id => !pendingQuestionIds.has(id));
        if (idsToAdd.length > 0) {
          const result = await instructorService.assignQuestionToGroup(groupId || '1', idsToAdd);
          // Populate questionId → groupQuestionId mapping from the response
          const assignments = Array.isArray(result) ? result : (result ? [result] : []);
          for (const a of assignments) {
            if (a?.question_id && a?.group_question_id) {
              questionIdToGroupQuestionId.current.set(a.question_id, a.group_question_id);
            }
          }
          for (const id of idsToAdd) {
            const bankQ = allBankQuestions.find(q => q.id === id);
            if (bankQ && !globalRubricQuestions.find(q => q.id === id)) {
              instructorService.addGlobalRubricQuestion(groupId || '1', { id: bankQ.id, title: bankQ.title, keyQuestion: bankQ.questionText, clinicalIntent: bankQ.clinicalIntent, evaluationCriteria: bankQ.evaluationCriteria, required: bankQ.isMandatory });
            }
          }
          setGlobalRubricQuestions(instructorService.getGlobalRubricQuestions(groupId || '1'));
        }
        for (const id of idsToRemove) {
          const bankQ = allBankQuestions.find(q => q.id === id);
          if (bankQ) await handleToggleQuestionInclusion(id, bankQ, false);
        }
      } else if (questionBankTab === 'patientSpecific' && selectedPatientForQuestionBank) {
        const idsToAdd = Array.from(pendingQuestionIds).filter(id => !includedQuestionIds.has(id));
        if (idsToAdd.length > 0) {
          await instructorService.assignQuestionToGroup(groupId || '1', idsToAdd, selectedPatientForQuestionBank);
        }

        includedQuestionIds.forEach(id => {
          if (!pendingQuestionIds.has(id)) {
            instructorService.deleteCaseSpecificQuestion(selectedPatientForQuestionBank, id);
            if (patientEditor.selectedPatientForEdit === selectedPatientForQuestionBank) patientEditor.setCaseSpecificQuestions(instructorService.getCaseSpecificQuestions(selectedPatientForQuestionBank));
          }
        });
      }
      setIncludedQuestionIds(new Set(pendingQuestionIds));
    } catch (err) { setQuestionBankError(err instanceof Error ? err.message : 'Failed to confirm selections'); }
  };

  // ── Question bank tab sync helpers ──
  const syncGlobalIds = () => {
    const ids = new Set(globalRubricQuestions.map(q => q.id));
    if (ids.size > 0) { setIncludedQuestionIds(ids); setPendingQuestionIds(new Set(ids)); }
  };
  const syncPatientIds = (patientId: string | null) => {
    if (patientId && groupId) {
      instructorService.getSimulationGroupQuestions(groupId, patientId).then((assigned: any[]) => {
        const ids = new Set(assigned.map((q: any) => q.question_id));
        setIncludedQuestionIds(ids); setPendingQuestionIds(new Set(ids));
      }).catch(() => {});
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
              <ArrowLeft className="w-4 h-4" /> Back to All Groups
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {adminReturnUrl && (
            <Button variant="default" onClick={() => navigate(adminReturnUrl)} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}>Back to Admin View</Button>
          )}
          <Button variant="default" onClick={handleStudentView} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Student View</Button>
          {hasAdminRole && (
            <Button variant="default" onClick={handleAdminView} className="px-6 transition-colors" style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }} onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover} onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}>Admin View</Button>
          )}
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
            { id: 'questionBank', label: 'Question Bank', icon: <HelpCircle className="w-5 h-5" />, onClick: () => { setActiveSection('questionBank'); questionBankTab === 'global' ? syncGlobalIds() : syncPatientIds(selectedPatientForQuestionBank); } },
            { id: 'dtpBank', label: 'DTP Bank', icon: <Pill className="w-5 h-5" /> },
            { id: 'recommendationsBank', label: 'Recommendations Bank', icon: <ClipboardList className="w-5 h-5" /> },
            { id: 'prompt', label: 'Manage Prompts', icon: <FileCode className="w-5 h-5" /> },
          ]}
          accessCode={accessCode}
          onCopyAccessCode={handleCopyAccessCode}
          onGenerateAccessCode={() => setIsAccessCodeDialogOpen(true)}
          isVisible={isMainSidebarVisible}
          onToggleVisibility={() => setIsMainSidebarVisible(!isMainSidebarVisible)}
        />

        <main className="flex-1 overflow-y-auto" style={{ padding: ['rubric', 'questionBank', 'dtpBank', 'recommendationsBank', 'editPatient', 'viewStudent', 'prompt'].includes(activeSection) ? '0' : '2rem' }}>
          {activeSection === 'analytics' && (
            <Suspense fallback={<DashboardSkeleton />}>
              <AnalyticsSection patientAnalytics={patientAnalytics} analyticsDateRange={analyticsDateRange} onDateRangeChange={setAnalyticsDateRange} keyQuestionCoverage={keyQuestionCoverage} keyQuestionAnalytics={keyQuestionAnalytics} dtpCoverage={dtpCoverage} recommendationCoverage={recommendationCoverage} dtpAnalytics={dtpAnalytics} recommendationAnalytics={recommendationAnalytics} studentProgress={studentProgress} selectedPatientId={selectedPatientId} onPatientSelect={setSelectedPatientId} labels={labels} simulationGroup={simulationGroup} onNavigateToSection={section => setActiveSection(section as ActiveSection)} />
            </Suspense>
          )}
          {activeSection === 'patients' && <PatientsSection patients={manageablePatients} profilePictures={profilePictures} searchQuery={searchQuery} onSearchChange={setSearchQuery} onEditPatient={handleEditPatient} onDeletePatient={handleDeletePatient} onCreatePatient={handleCreateNewPatient} onTogglePatientVoice={handleTogglePatientVoice} labels={labels} enableVoiceForAll={enableVoiceForAll} onToggleVoice={async (enabled) => {
            for (const p of manageablePatients) {
              const pid = (p as any).id || (p as any).patient_id;
              await handleTogglePatientVoice(pid, enabled);
            }
          }} />}
          {activeSection === 'students' && <StudentsSection students={students} searchQuery={studentSearchQuery} onSearchChange={setStudentSearchQuery} onViewStudent={handleViewStudent} labels={labels} />}
          {activeSection === 'rubric' && <RubricSection questions={globalRubricQuestions} selectedQuestionId={selectedQuestionId} onSelectQuestion={setSelectedQuestionId} searchQuery={rubricSearchQuery} onSearchChange={setRubricSearchQuery} onSaveQuestion={handleSaveQuestion} onUpdateField={handleUpdateQuestionField} />}
          {activeSection === 'questionBank' && <QuestionBankSection questionBank={questionBank} role="instructor" groupId={groupId || '1'} patients={manageablePatients} onConfirmSelections={handleConfirmSelections} onGlobalTabClick={syncGlobalIds} onPatientSpecificTabClick={() => syncPatientIds(selectedPatientForQuestionBank)} onPatientSelect={syncPatientIds} />}
          {activeSection === 'dtpBank' && <DTPBankSection dtpBank={dtpBank} role="instructor" groupId={groupId || ''} patients={manageablePatients} onConfirmSelections={handleConfirmDTPSelections} onGroupWideTabClick={syncDTPGroupWideIds} onPatientSpecificTabClick={() => syncDTPPatientIds(dtpBank.selectedPatientId)} onPatientSelect={syncDTPPatientIds} />}
          {activeSection === 'recommendationsBank' && <RecommendationsBankSection recommendationsBank={recommendationsBank} role="instructor" groupId={groupId || ''} patients={manageablePatients} onConfirmSelections={handleConfirmRecommendationSelections} onGroupWideTabClick={syncRecGroupWideIds} onPatientSpecificTabClick={() => syncRecPatientIds(recommendationsBank.selectedPatientId)} onPatientSelect={syncRecPatientIds} />}
          {activeSection === 'prompt' && (
            <div className="flex h-full relative">
              <aside className="flex flex-col border-r" style={{ backgroundColor: UI_COLORS.background.white, borderRightWidth: '1px', borderRightStyle: 'solid', borderRightColor: UI_COLORS.border.default, width: '16rem', minWidth: '16rem' }}>
                <div className="p-6">
                  <h3 className="text-sm font-semibold mb-4" style={{ color: UI_COLORS.text.heading }}>Prompt Type</h3>
                  <div className="space-y-2">
                    {(['system', 'debrief'] as const).map(type => (
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
                    <h2 className="text-2xl font-bold mb-2" style={{ color: UI_COLORS.text.heading }}>{selectedPromptType === 'system' ? 'System Prompt' : 'Debrief Prompt'}</h2>
                    {selectedPromptType === 'system' ? (
                      <div className="space-y-4">
                        <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>Controls how the AI patient behaves during conversations. Changes apply to all patients in this group.</p>
                        <textarea
                          value={systemPromptText}
                          onChange={e => setSystemPromptText(e.target.value)}
                          placeholder="Leave empty to use the default patient behavior prompt."
                          rows={12}
                          className="w-full px-4 py-3 rounded-md resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 text-sm font-mono"
                          style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.white, color: UI_COLORS.text.heading, minHeight: '400px' }}
                        />
                        <div className="flex gap-3 justify-end">
                          <Button
                            onClick={async () => { setSystemPromptText(await instructorService.getDefaultSystemPrompt()); }}
                            variant="outline"
                            className="px-6 transition-colors"
                            style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading, backgroundColor: UI_COLORS.background.white }}
                          >
                            Load Default Prompt
                          </Button>
                          <Button
                            onClick={async () => {
                              if (!groupId) return;
                              try {
                                await instructorService.updateSystemPrompt(groupId, authUser?.email || '', systemPromptText);
                                showNotification({ message: 'System prompt saved successfully!', type: 'success' });
                              } catch (error) {
                                console.error('Failed to save system prompt:', error);
                                showNotification({ message: 'Failed to save prompt. Please try again.', type: 'error' });
                              }
                            }}
                            className="px-6 transition-colors"
                            style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
                            onMouseEnter={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                            onMouseLeave={e => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                          >
                            Save Prompt
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>The debrief prompt controls how AI-generated debriefs are structured. This is managed by admins.</p>
                        <textarea
                          readOnly
                          className="w-full px-4 py-3 rounded-lg resize-none text-sm font-mono cursor-default"
                          style={{ borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default, backgroundColor: UI_COLORS.background.tableHeader, color: UI_COLORS.text.heading, minHeight: '400px' }}
                          value={debriefPromptText || 'Default built-in debrief prompt is in use.'}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {activeSection === 'editPatient' && <EditPatientPanel patientEditor={patientEditor} profilePictures={profilePictures} onBack={handleBackFromEditPatient} labels={labels} groupId={groupId || ''} globalRubricQuestions={globalRubricQuestions} onSavePatient={handleSavePatientChanges} onSaveCaseQuestion={(pid, q) => instructorService.updateCaseSpecificQuestion(pid, q)} onDeleteCaseQuestion={(pid, qid) => instructorService.deleteCaseSpecificQuestion(pid, qid)} onCreatePatientDTP={handleCreatePatientDTP} onUpdatePatientDTP={handleUpdatePatientDTP} onDeletePatientDTP={handleDeletePatientDTP} patientDTPs={patientDTPs} groupDTPs={groupDTPs} onLoadPatientDTPs={handleLoadPatientDTPs} onCreatePatientRecommendation={handleCreatePatientRecommendation} onUpdatePatientRecommendation={handleUpdatePatientRecommendation} onDeletePatientRecommendation={handleDeletePatientRecommendation} patientRecommendations={patientRecommendations} groupRecommendations={groupRecommendations} onLoadPatientRecommendations={handleLoadPatientRecommendations} />}
          {activeSection === 'viewStudent' && studentViewer.selectedStudentId && <StudentDetailsPanel studentDetails={studentViewer.studentDetails} studentDetailsLoading={studentViewer.studentDetailsLoading} studentPatientData={studentViewer.studentPatientData} expandedAttemptId={studentViewer.expandedAttemptId} onExpandAttempt={studentViewer.setExpandedAttemptId} selectedPatientFilter={studentViewer.selectedPatientFilter} onPatientFilterChange={studentViewer.setSelectedPatientFilter} onViewDebrief={debriefViewer.viewDebrief} isFetchingDebrief={debriefViewer.isFetchingDebrief} onDownloadPdf={async (attemptId) => { const el = debriefViewer.attemptPdfRefs.current[String(attemptId)]; if (el) await debriefViewer.downloadPdf(attemptId, el); }} isGeneratingPdf={debriefViewer.isGeneratingPdf} onBack={handleBackFromViewStudent} attemptPdfRefs={debriefViewer.attemptPdfRefs} labels={labels} />}
        </main>
      </div>

      <AIDebriefDialog isOpen={debriefViewer.isAIDebriefOpen} onClose={debriefViewer.closeDebrief} data={debriefViewer.selectedDebriefData} updatedDebriefData={debriefViewer.selectedUpdatedDebriefData} simulationGroupId={groupId} patientMode={debriefViewer.selectedUpdatedDebriefData?.chunk2 ? 'full_assessment' : 'interview_practice'} />
      <AddQuestionDialog open={isAddQuestionDialogOpen} onOpenChange={setIsAddQuestionDialogOpen} questionType={questionBankTab === 'global' ? 'global' : 'patientSpecific'} existingTags={allExistingTags} onSave={(q) => questionBankTab === 'global' ? handleSaveNewGlobalQuestion(q) : handleSaveNewPatientQuestion({ ...q, patientId: selectedPatientForQuestionBank || '' })} />
      <AddPatientSpecificQuestionDialog open={isAddPatientQuestionDialogOpen} onOpenChange={setIsAddPatientQuestionDialogOpen} patients={manageablePatients.map(p => ({ id: p.id, name: p.name }))} onSave={handleSaveNewPatientQuestion} />

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
    </PageContainer>
  );
}

export default InstructorSimulationGroupPage;