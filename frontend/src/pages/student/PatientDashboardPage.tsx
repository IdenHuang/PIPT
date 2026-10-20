import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { ArrowLeft, Trash2, User, Stethoscope, ChevronDown, ChevronRight, FileText, ArrowLeftIcon, MessageCircle, Loader2 } from 'lucide-react';
import { UI_COLORS } from '@/lib/colors';
import { useState, useEffect, lazy, Suspense } from 'react';
import { useAuth } from '@/App';
import { studentService, type ChatHistoryEntry, type PatientDetail, type PatientFile, type PersonaMedia } from '@/services/studentService';
import type { KeyQuestionsCoverageData } from '@/services/studentService';
import ConfirmDeleteSessionDialog from '@/components/ConfirmDeleteSessionDialog';
import PhysicalAssessmentContent from '@/components/PhysicalAssessmentContent';

// Lazy-loaded so `recharts` is only downloaded when the coverage chart renders,
// keeping it off the patient dashboard's initial paint.
const KeyQuestionsCoverageChart = lazy(() => import('@/components/KeyQuestionsCoverageChart'));

/**
 * PatientDashboardPage Component
 * 
 * Displays detailed patient information including chat history and performance metrics.
 */
function PatientDashboardPage() {
  const navigate = useNavigate();
  const { groupId, patientId } = useParams();
  const location = useLocation();
  const adminReturnUrl = (location.state as any)?.adminReturnUrl as string | undefined;
  
  const { user: authUser, signOut } = useAuth();
  const user = { name: authUser?.email || 'Student', avatarUrl: undefined };
  
  // State for showing all attempts
  const [showAllAttempts, setShowAllAttempts] = useState(false);

  // Pagination for chat history
  const [chatPage, setChatPage] = useState(0);
  const chatsPerPage = 10;

  // State for delete confirmation dialog
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteTargetChatId, setDeleteTargetChatId] = useState<string | null>(null);
  
  // Load patient data from API
  const [patient, setPatient] = useState<PatientDetail>({ id: patientId, name: '', age: 0, gender: '' });
  const [patientLoading, setPatientLoading] = useState(true);

  // Patient Information files
  const [patientFiles, setPatientFiles] = useState<PatientFile[]>([]);
  const [patientFilesLoading, setPatientFilesLoading] = useState(true);
  const [selectedPatientFile, setSelectedPatientFile] = useState<PatientFile | null>(null);
  const [isPatientInfoOpen, setIsPatientInfoOpen] = useState(true);

  // Physical Assessment materials
  const [personaMedia, setPersonaMedia] = useState<PersonaMedia[]>([]);
  const [personaMediaLoading, setPersonaMediaLoading] = useState(false);
  const [isPhysicalAssessmentOpen, setIsPhysicalAssessmentOpen] = useState(true);

  useEffect(() => {
    if (!groupId || !patientId) return;
    let cancelled = false;
    setPatientLoading(true);
    setPatientFilesLoading(true);
    studentService.fetchPatientDetail(groupId, patientId).then((data) => {
      if (!cancelled) {
        setPatient(data);
        setPatientLoading(false);
      }
    }).catch(() => { if (!cancelled) setPatientLoading(false); });
    studentService.fetchPatientFiles(groupId, patientId).then((data) => {
      if (!cancelled) {
        setPatientFiles(data);
        setPatientFilesLoading(false);
      }
    }).catch(() => { if (!cancelled) setPatientFilesLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, patientId]);

  // Fetch persona media when physical assessment section is opened
  useEffect(() => {
    if (!isPhysicalAssessmentOpen || !patientId) return;
    let cancelled = false;
    setPersonaMediaLoading(true);
    studentService.fetchPersonaMedia(patientId).then((data) => {
      if (!cancelled) {
        setPersonaMedia(data);
        setPersonaMediaLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [isPhysicalAssessmentOpen, patientId]);

  // Load chat history from API (falls back to mock)
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [, setChatHistoryLoading] = useState(true);

  useEffect(() => {
    if (!groupId || !patientId) return;
    let cancelled = false;
    setChatHistoryLoading(true);
    studentService.fetchChatHistory(groupId, patientId).then((data) => {
      if (!cancelled) {
        setChatHistory(data);
        setChatHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [groupId, patientId]);

  // Load key questions coverage data from real chat history scores
  const allKeyQuestionsCoverageData: KeyQuestionsCoverageData[] = chatHistory
    .filter((c) => c.completionStatus === 'Complete' && c.score != null)
    .reverse() // oldest first (chatHistory is newest-first)
    .map((c, i) => ({
      attempt: `Attempt ${i + 1}`,
      attemptNumber: i + 1,
      coverage: parseInt(c.score!.replace('%', ''), 10),
    }));

  // Check if there are any chats
  const hasChats = chatHistory.length > 0;
  
  // Check if there's any coverage data
  const hasCoverageData = allKeyQuestionsCoverageData.some((d: { coverage: number; }) => d.coverage > 0);

  // Show only last 5 attempts by default
  const displayedCoverageData = showAllAttempts 
    ? allKeyQuestionsCoverageData 
    : allKeyQuestionsCoverageData.slice(-5);

  /**
   * Handle sign out event
   */
  const handleSignOut = async () => {
    await signOut();
  };

  /**
   * Handle back to patients navigation
   */
  const handleBackToPatients = () => {
    navigate(`/patients/${groupId}`, { state: { adminReturnUrl } });
  };

  /**
   * Handle start new chat
   */
  const handleStartNewChat = () => {
    navigate(`/patients/${groupId}/${patientId}/chat`, { state: { adminReturnUrl } });
  };

  /**
   * Handle chat click
   */
  const handleChatClick = (chatId: string, completionStatus: string) => {
    if (completionStatus === 'Complete') {
      // Navigate to read-only chat history page
      navigate(`/patients/${groupId}/${patientId}/chat/${chatId}/history`, { state: { adminReturnUrl } });
    } else {
      // Navigate to active chat page with existing session ID
      navigate(`/patients/${groupId}/${patientId}/chat/${chatId}`, { state: { adminReturnUrl } });
    }
  };

  /**
   * Handle delete session
   */
  const handleDeleteSession = (e: React.MouseEvent, chatId: string) => {
    e.stopPropagation(); // Prevent row click navigation
    setDeleteTargetChatId(chatId);
    setIsDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!groupId || !patientId || !deleteTargetChatId) return;
    const success = await studentService.deleteSession(groupId, patientId, deleteTargetChatId);
    if (success) {
      setChatHistory((prev) => {
        const updated = prev.filter((c) => c.id !== deleteTargetChatId);
        // Reset to last valid page if current page is now empty
        const maxPage = Math.max(0, Math.ceil(updated.length / chatsPerPage) - 1);
        if (chatPage > maxPage) setChatPage(maxPage);
        return updated;
      });
    }
    setIsDeleteDialogOpen(false);
    setDeleteTargetChatId(null);
  };

  return (
    <PageContainer>
      {/* Delete Session Confirmation Dialog */}
      <ConfirmDeleteSessionDialog
        isOpen={isDeleteDialogOpen}
        onCancel={() => { setIsDeleteDialogOpen(false); setDeleteTargetChatId(null); }}
        onConfirm={handleConfirmDelete}
      />

      {/* Header */}
      <header className="flex-shrink-0 flex border-b border-border items-center justify-between py-6 px-8" style={{ backgroundColor: UI_COLORS.header.background }}>
        <div className="flex items-center gap-4">
          <UserAvatar
            name={user.name}
            imageUrl={user.avatarUrl}
            size="medium"
          />
          <div className="flex flex-col items-start gap-0.5">
            <h1 className="font-bold tracking-tight leading-tight text-2xl" style={{ color: UI_COLORS.text.heading }}>
              Patient Dashboard
            </h1>
            <button
              onClick={handleBackToPatients}
              className="font-normal text-sm flex items-center gap-1 bg-transparent border-0 cursor-pointer p-0 transition-colors"
              style={{ color: UI_COLORS.text.body }}
              onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
              onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
            >
              <ArrowLeft className="w-4 h-4" />
              Back to All Patients
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {adminReturnUrl && (
            <Button
              variant="default"
              onClick={() => navigate(adminReturnUrl)}
              className="px-6 transition-colors"
              style={{ backgroundColor: UI_COLORS.button.primary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
            >
              Back to Admin View
            </Button>
          )}
          <Button
            variant="default"
            onClick={handleSignOut}
            className="px-6 transition-colors"
            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
          >
            Sign Out
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <div className="grid grid-cols-2 gap-6">
          {/* Left Column - Patient Overview */}
          <div className="pr-6 overflow-y-auto" style={{ borderRightWidth: '1px', borderRightStyle: 'solid', borderRightColor: UI_COLORS.border.default }}>
            <h2 className="text-xl font-semibold mb-6" style={{ color: UI_COLORS.text.heading }}>Patient Overview</h2>
            
            {/* Patient Info Card */}
            <div className="flex items-start gap-4 mb-8">
              <UserAvatar
                name={patientLoading ? '...' : patient.name}
                imageUrl={patient.avatarUrl}
                size="large"
              />
              <div className="flex flex-col gap-1">
                {patientLoading ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: UI_COLORS.text.muted }} />
                    <span className="text-base" style={{ color: UI_COLORS.text.muted }}>Loading patient info…</span>
                  </div>
                ) : (
                  <>
                    <h3 className="text-2xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
                      {patient.name}
                    </h3>
                    {patient.pronouns && (
                      <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                        Pronouns: {patient.pronouns}
                      </p>
                    )}
                    {!!patient.age && (
                      <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                        Age: {patient.age}
                      </p>
                    )}
                    {patient.gender && (
                      <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                        Gender: {patient.gender}
                      </p>
                    )}
                    {patient.sex && (
                      <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                        Sex: {patient.sex}
                      </p>
                    )}
                    {patient.primaryComplaint && (
                      <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                        Primary Complaint: {patient.primaryComplaint}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Overall Key Questions Coverage */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
                  Overall Key Questions Coverage
                </h3>
                {hasCoverageData && allKeyQuestionsCoverageData.length > 5 && (
                  <button
                    onClick={() => setShowAllAttempts(!showAllAttempts)}
                    className="text-sm px-3 py-1 rounded transition-colors"
                    style={{ 
                      backgroundColor: UI_COLORS.button.secondary, 
                      color: UI_COLORS.button.text,
                      border: 'none',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                  >
                    {showAllAttempts ? 'Show Recent' : 'View All Attempts'}
                  </button>
                )}
              </div>
              
              {hasCoverageData ? (
                <>
                  {!showAllAttempts && allKeyQuestionsCoverageData.length > 5 && (
                    <p className="text-xs mb-2" style={{ color: UI_COLORS.text.muted }}>
                      Showing last 5 attempts
                    </p>
                  )}
                  <Suspense
                    fallback={
                      <div
                        className="flex items-center justify-center rounded-lg"
                        style={{ height: 300, backgroundColor: UI_COLORS.background.input }}
                      >
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: UI_COLORS.text.muted }} />
                      </div>
                    }
                  >
                    <KeyQuestionsCoverageChart data={displayedCoverageData} />
                  </Suspense>
                </>
              ) : (
                <div 
                  className="flex items-center justify-center rounded-lg"
                  style={{ 
                    backgroundColor: UI_COLORS.background.input,
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.light,
                    height: '300px'
                  }}
                >
                  <p className="text-base" style={{ color: UI_COLORS.text.muted }}>
                    Complete an interaction with a interview or full simulation patient to view key question coverage
                  </p>
                </div>
              )}
            </div>

            {/* Patient Information Section */}
            <div className="mb-8">
              <button
                onClick={() => { setIsPatientInfoOpen(!isPatientInfoOpen); setSelectedPatientFile(null); }}
                className="flex items-center gap-2 w-full text-left mb-3"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {isPatientInfoOpen ? (
                  <ChevronDown className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                ) : (
                  <ChevronRight className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                )}
                <User className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                <h3 className="text-xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
                  Patient Information
                </h3>
              </button>

              {isPatientInfoOpen && (
                <div
                  className="rounded-lg p-4"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    backgroundColor: UI_COLORS.background.white,
                  }}
                >
                  {selectedPatientFile ? (
                    <div className="flex flex-col">
                      <div className="flex items-center justify-between mb-3">
                        <button
                          onClick={() => setSelectedPatientFile(null)}
                          className="flex items-center gap-1 text-sm bg-transparent border-0 cursor-pointer p-0 transition-colors"
                          style={{ color: UI_COLORS.text.body }}
                          onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
                          onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
                        >
                          <ArrowLeftIcon className="w-4 h-4" />
                          Back to files
                        </button>
                        {selectedPatientFile.url && (
                          <a
                            href={selectedPatientFile.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-sm px-3 py-1 rounded transition-colors no-underline"
                            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                          >
                            Open in new tab
                          </a>
                        )}
                      </div>
                      <h4 className="font-semibold text-sm mb-2" style={{ color: UI_COLORS.text.heading }}>
                        {selectedPatientFile.filename}
                      </h4>
                      {selectedPatientFile.url ? (
                        <iframe
                          src={selectedPatientFile.url}
                          title={selectedPatientFile.filename}
                          className="w-full rounded border"
                          style={{ borderColor: UI_COLORS.border.default, minHeight: '400px' }}
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>No preview available for this file.</p>
                      )}
                    </div>
                  ) : patientFilesLoading ? (
                    <div className="flex items-center gap-2 py-2">
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: UI_COLORS.text.muted }} />
                      <span className="text-sm" style={{ color: UI_COLORS.text.body }}>Loading patient files…</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {patientFiles.length === 0 ? (
                        <div className="flex items-center justify-center py-12">
                        <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>No patient information files uploaded.</p>
                        </div>
                      ) : (
                        patientFiles.map((file) => (
                          <div
                            key={file.id}
                            onClick={() => setSelectedPatientFile(file)}
                            className="p-4 rounded-lg cursor-pointer transition-colors"
                            style={{ backgroundColor: UI_COLORS.background.hoverLight }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight}
                          >
                            <div className="flex items-start gap-3">
                              <FileText className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: UI_COLORS.text.muted }} />
                              <div className="flex-1">
                                <h4 className="font-semibold text-sm mb-1" style={{ color: UI_COLORS.text.heading }}>
                                  {file.filename}
                                </h4>
                                <p className="text-xs" style={{ color: UI_COLORS.text.body }}>
                                  {file.description}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Physical Assessment Section */}
            <div className="mb-8">
              <button
                onClick={() => setIsPhysicalAssessmentOpen(!isPhysicalAssessmentOpen)}
                className="flex items-center gap-2 w-full text-left mb-3"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {isPhysicalAssessmentOpen ? (
                  <ChevronDown className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                ) : (
                  <ChevronRight className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                )}
                <Stethoscope className="w-5 h-5" style={{ color: UI_COLORS.text.heading }} />
                <h3 className="text-xl font-semibold" style={{ color: UI_COLORS.text.heading }}>
                  Physical Assessment
                </h3>
              </button>

              {isPhysicalAssessmentOpen && (
                <div
                  className="rounded-lg p-4"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    backgroundColor: UI_COLORS.background.white,
                  }}
                >
                  <PhysicalAssessmentContent materials={personaMedia} loading={personaMediaLoading} />
                </div>
              )}
            </div>

          </div>

          {/* Right Column - Chat History (only when there are chats) */}
          {hasChats ? (
            <div className="pl-6 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xl font-semibold" style={{ color: UI_COLORS.text.heading }}>Chat History</h2>
                <Button
                  onClick={handleStartNewChat}
                  variant="default"
                  className="px-6 transition-colors"
                  style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                >
                  + Start New Interaction
                </Button>
              </div>
              <p className="text-sm mb-4" style={{ color: UI_COLORS.text.body }}>
                Click on an in-progress chat to continue your diagnosis.<br />
                Click on a completed chat to view the AI debrief.<br />
                Each interaction starts fresh, there is no memory carried over between sessions.
              </p>

              {/* Chat History Table */}
              <div className="rounded-lg overflow-y-auto" style={{ backgroundColor: UI_COLORS.background.white, borderWidth: '1px', borderStyle: 'solid', borderColor: UI_COLORS.border.default }}>
                <table className="w-full">
                  <thead style={{ backgroundColor: UI_COLORS.background.tableHeader, borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
                    <tr>
                      <th className="px-6 py-3 text-left font-semibold text-sm" style={{ color: UI_COLORS.text.heading }}>Name</th>
                      <th className="px-6 py-3 text-center font-semibold text-sm" style={{ color: UI_COLORS.text.heading }}>Chat Completion Status</th>
                      <th className="px-6 py-3 text-center font-semibold text-sm" style={{ color: UI_COLORS.text.heading }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chatHistory.slice(chatPage * chatsPerPage, (chatPage + 1) * chatsPerPage).map((chat) => (
                      <tr
                        key={chat.id}
                        onClick={() => handleChatClick(chat.id, chat.completionStatus)}
                        className="last:border-b-0 cursor-pointer transition-colors"
                        style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.light }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.background.hover}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <td className="px-6 py-4" style={{ color: UI_COLORS.text.heading }}>{chat.name}</td>
                        <td className="px-6 py-4 text-center" style={{ color: UI_COLORS.text.body }}>{chat.completionStatus === 'Complete' ? 'Debrief Reached' : chat.completionStatus}</td>
                        <td className="px-6 py-4 text-center">
                          <button
                            onClick={(e) => handleDeleteSession(e, chat.id)}
                            className="p-2 rounded-lg transition-colors inline-flex items-center justify-center"
                            style={{ backgroundColor: 'transparent', color: UI_COLORS.text.muted, border: 'none', cursor: 'pointer' }}
                            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight; e.currentTarget.style.color = '#ef4444'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = UI_COLORS.text.muted; }}
                            aria-label={`Delete session ${chat.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {chatHistory.length > chatsPerPage && (
                <div className="flex items-center justify-between mt-3">
                  <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                    Showing {chatPage * chatsPerPage + 1}–{Math.min((chatPage + 1) * chatsPerPage, chatHistory.length)} of {chatHistory.length} chats
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setChatPage((p) => Math.max(0, p - 1))}
                      disabled={chatPage === 0}
                      className="px-3 py-1 text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text, border: 'none', cursor: 'pointer' }}
                      onMouseEnter={(e) => { if (chatPage > 0) e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary; }}
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => setChatPage((p) => p + 1)}
                      disabled={(chatPage + 1) * chatsPerPage >= chatHistory.length}
                      className="px-3 py-1 text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text, border: 'none', cursor: 'pointer' }}
                      onMouseEnter={(e) => { if ((chatPage + 1) * chatsPerPage < chatHistory.length) e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary; }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Empty state CTA - shown in right sidebar when no chats exist */
            <div className="pl-6 flex flex-col">
              <div
                className="flex flex-col items-center justify-center text-center py-10 px-6 rounded-xl"
                style={{
                  backgroundColor: UI_COLORS.background.tableHeader,
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: UI_COLORS.border.default,
                }}
              >
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
                  style={{ backgroundColor: UI_COLORS.button.secondary }}
                >
                  <MessageCircle className="w-7 h-7" style={{ color: UI_COLORS.button.text }} />
                </div>
                <h2 className="text-xl font-semibold mb-2" style={{ color: UI_COLORS.text.heading }}>
                  No attempts yet
                </h2>
                <p className="text-sm mb-6" style={{ color: UI_COLORS.text.muted }}>
                  Start your first chat with {patientLoading ? 'this patient' : patient.name} to begin the simulation.
                </p>
                <Button
                  onClick={handleStartNewChat}
                  className="px-8 py-3 text-base font-medium transition-colors"
                  style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                >
                  + Start New Interaction
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>
    </PageContainer>
  );
}

export default PatientDashboardPage;
