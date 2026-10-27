import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { studentService, type StudentChatMessage as Message, type PatientDetail, type PatientFile, type AIDebriefData, type PersonaMedia, type UpdatedDebriefData } from '@/services/studentService';
import { ArrowLeft, FileText, User, Stethoscope, Flag, Eye, Menu, ChevronRight, ChevronLeft, ArrowLeftIcon } from 'lucide-react';
import { SIMULATION_GROUP_COLOR_PALETTE, UI_COLORS } from '@/lib/colors';
import { useState, useRef, useEffect } from 'react';
import ReportIssueDialog from '@/components/ReportIssueDialog';
import AIDebriefDialog from '@/components/AIDebriefDialog';
import PhysicalAssessmentContent, { ImageViewer, isImageFile } from '@/components/PhysicalAssessmentContent';
import { useAuth } from '@/App';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import ResizeHandle from '@/components/ResizeHandle';

/**
 * ChatHistoryPage Component
 * 
 * Read-only view of completed chat history with AI patient.
 * Displays full conversation history without ability to send new messages.
 */
function ChatHistoryPage() {
  const navigate = useNavigate();
  const { groupId, patientId, chatId } = useParams();
  const location = useLocation();
  const adminReturnUrl = (location.state as any)?.adminReturnUrl as string | undefined;
  
  // Load user data from auth context
  const { user: authUser, signOut } = useAuth();
  const user = { name: authUser?.email || 'Student', avatarUrl: undefined };
  
  // Patient data and patient files loaded from API
  const [patient, setPatient] = useState<PatientDetail>({ id: patientId, name: 'Loading...', age: 0, gender: '' });
  const [patientFiles, setPatientFiles] = useState<PatientFile[]>([]);

  // Fetch patient detail, case materials, and patient files from real API
  useEffect(() => {
    if (!groupId || !patientId) return;
    let cancelled = false;

    studentService.fetchPatientDetail(groupId, patientId).then((data) => {
      if (!cancelled) setPatient(data);
    });
    studentService.fetchPatientFiles(groupId, patientId).then((data) => {
      if (!cancelled) setPatientFiles(data);
    });

    return () => { cancelled = true; };
  }, [groupId, patientId]);

  // State for dialogs
  const [isReportIssueOpen, setIsReportIssueOpen] = useState(false);
  const [isAIDebriefOpen, setIsAIDebriefOpen] = useState(false);
  const [debriefData, setDebriefData] = useState<AIDebriefData | null>(null);
  const [updatedDebriefData, setUpdatedDebriefData] = useState<UpdatedDebriefData | undefined>(undefined);

  // State for content sidebar (physical assessment only)
  const [contentSidebarType, setContentSidebarType] = useState<'physical-assessment' | null>(null);
  const [personaMedia, setPersonaMedia] = useState<PersonaMedia[]>([]);
  const [personaMediaLoading, setPersonaMediaLoading] = useState(false);

  // Fetch persona media when physical assessment sidebar opens
  useEffect(() => {
    if (contentSidebarType !== 'physical-assessment' || !patientId) return;
    let cancelled = false;
    setPersonaMediaLoading(true);
    studentService.fetchPersonaMedia(patientId).then((data) => {
      if (!cancelled) {
        setPersonaMedia(data);
        setPersonaMediaLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [contentSidebarType, patientId]);

  // State for patient information sidebar
  const [isPatientInfoSidebarOpen, setIsPatientInfoSidebarOpen] = useState(false);
  const [selectedPatientFile, setSelectedPatientFile] = useState<PatientFile | null>(null);

  // State for sidebar visibility
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  // Resizable sidebars
  const {
    width: patientInfoWidth,
    sidebarRef: patientInfoRef,
    handleMouseDown: onPatientInfoDrag,
  } = useResizablePanel({ defaultWidth: 320, minWidth: 250, maxWidth: 700, direction: 'left' });
  const {
    width: physicalAssessmentWidth,
    sidebarRef: physicalAssessmentRef,
    handleMouseDown: onPhysicalAssessmentDrag,
  } = useResizablePanel({ defaultWidth: 384, minWidth: 250, maxWidth: 700, direction: 'right' });

  // Notes loaded from API
  const [savedNote, setSavedNote] = useState('');

  // Load notes from API
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    studentService.fetchNotes(chatId).then((notes) => {
      if (!cancelled) setSavedNote(notes);
    });
    return () => { cancelled = true; };
  }, [chatId]);

  // Load chat messages and debrief from API
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    studentService.fetchMessages(chatId).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    });
    studentService.fetchDebrief(chatId).then((data) => {
      if (!cancelled) setDebriefData(data);
    });
    studentService.fetchUpdatedDebrief(chatId).then((data) => {
      if (!cancelled) setUpdatedDebriefData(data);
    }).catch(() => {
      // Non-fatal — updatedDebriefData stays undefined, dialog falls back to legacy layout
    });
    return () => { cancelled = true; };
  }, [chatId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on mount
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  /**
   * Handle sign out event
   */
  const handleSignOut = async () => {
    await signOut();
  };

  /**
   * Handle back to patient dashboard
   */
  const handleBackToPatientDashboard = () => {
    navigate(`/patients/${groupId}/${patientId}`, { state: { adminReturnUrl } });
  };

  /**
   * Handle view AI debrief
   */
  const handleViewAIDebrief = () => {
    setIsAIDebriefOpen(true);
  };

  /**
   * Format timestamp for display
   */
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  return (
    <PageContainer>
      {/* Report Issue Dialog */}
      <ReportIssueDialog
        isOpen={isReportIssueOpen}
        onClose={() => setIsReportIssueOpen(false)}
        simulationGroupId={groupId}
        patientId={patientId}
        chatId={chatId}
      />

      {/* AI Debrief Dialog */}
      <AIDebriefDialog
        isOpen={isAIDebriefOpen}
        onClose={() => setIsAIDebriefOpen(false)}
        data={debriefData}
        updatedDebriefData={updatedDebriefData}
        simulationGroupId={groupId}
        patientId={patientId}
        chatId={chatId}
        showAnswerKey={false}
        patientMode={updatedDebriefData?.chunk2 ? 'full_assessment' : 'interview_practice'}
      />

      {/* Header */}
      <header className="flex-shrink-0 flex border-b border-border items-center justify-between py-6 px-8" style={{ backgroundColor: UI_COLORS.header.background }}>
        <div className="flex items-center gap-4">
          {/* Sidebar Toggle Button */}
          <button
            onClick={() => setIsSidebarVisible(!isSidebarVisible)}
            className="p-2 rounded-lg transition-colors"
            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
            aria-label="Toggle sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>

          <UserAvatar
            name={user.name}
            imageUrl={user.avatarUrl}
            size="medium"
          />
          <div className="flex flex-col items-start gap-0.5">
            <h1 className="font-bold tracking-tight leading-tight text-2xl" style={{ color: UI_COLORS.text.heading }}>
              Chat History
            </h1>
            <button
              onClick={handleBackToPatientDashboard}
              className="font-normal text-sm flex items-center gap-1 bg-transparent border-0 cursor-pointer p-0 transition-colors"
              style={{ color: UI_COLORS.text.body }}
              onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
              onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Patient Dashboard
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
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar */}
        <aside 
          className="flex flex-col transition-all duration-300 ease-in-out"
          aria-hidden={!isSidebarVisible}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderRightWidth: isSidebarVisible ? '1px' : '0px', 
            borderRightStyle: 'solid', 
            borderRightColor: UI_COLORS.border.default,
            width: isSidebarVisible ? '16rem' : '0rem',
            minWidth: isSidebarVisible ? '16rem' : '0rem',
            overflowY: isSidebarVisible ? 'auto' : 'hidden',
            overflowX: 'hidden',
            opacity: isSidebarVisible ? 1 : 0,
            pointerEvents: isSidebarVisible ? 'auto' : 'none',
          }}
        >
          {/* Patient Info */}
          <div className="p-6" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
            <h2 className="font-semibold text-lg mb-1 whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>{patient.name}</h2>
            <p className="text-sm whitespace-nowrap" style={{ color: UI_COLORS.text.body }}>{patient.gender}, {patient.age} years old</p>
          </div>

          {/* Notes Section - Read Only */}
          <div className="p-4 flex flex-col flex-shrink-0" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
            <h3 className="font-semibold text-sm mb-3 whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>Notes</h3>
            
            {/* Saved Note - Read Only */}
            {savedNote ? (
              <div
                className="w-full px-3 py-2 rounded-lg"
                style={{ 
                  borderWidth: '1px', 
                  borderStyle: 'solid', 
                  borderColor: UI_COLORS.border.default,
                  backgroundColor: UI_COLORS.background.hoverLight,
                  height: '300px',
                  overflowY: 'auto',
                }}
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: UI_COLORS.text.body }}>
                  {savedNote}
                </p>
              </div>
            ) : (
              <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>No notes saved for this chat.</p>
            )}
          </div>

          {/* Sidebar Buttons */}
          <div className="mt-auto flex flex-col gap-3 p-4">
            <Button
              variant="outline"
              className="w-full justify-start transition-colors border-0 whitespace-nowrap"
              style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
              onClick={() => setIsPatientInfoSidebarOpen(true)}
            >
              <User className="w-5 h-5 mr-2" />
              Patient Information
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start transition-colors border-0 whitespace-nowrap"
              style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
              onClick={() => setContentSidebarType('physical-assessment')}
            >
              <Stethoscope className="w-5 h-5 mr-2" />
              Physical Assessment
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start text-white hover:opacity-90 border-0 whitespace-nowrap"
              style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[2] }}
              onClick={handleViewAIDebrief}
            >
              <Eye className="w-5 h-5 mr-2" />
              View AI Debrief
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start text-white hover:opacity-90 border-0 whitespace-nowrap"
              style={{ backgroundColor: SIMULATION_GROUP_COLOR_PALETTE[1] }}
              onClick={() => setIsReportIssueOpen(true)}
            >
              <Flag className="w-5 h-5 mr-2" />
              Report Issue
            </Button>
          </div>
        </aside>

        {/* Patient Information Sidebar - Slides from right of notes sidebar */}
        <aside 
          ref={patientInfoRef as React.RefObject<HTMLElement>}
          className="flex flex-col flex-shrink-0 relative"
          aria-hidden={!isPatientInfoSidebarOpen}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderRightWidth: isPatientInfoSidebarOpen ? '1px' : '0px', 
            borderRightStyle: 'solid', 
            borderRightColor: UI_COLORS.border.default,
            width: isPatientInfoSidebarOpen ? `${patientInfoWidth}px` : '0px',
            minWidth: isPatientInfoSidebarOpen ? `${patientInfoWidth}px` : '0px',
            overflowY: isPatientInfoSidebarOpen ? 'auto' : 'hidden',
            overflowX: 'hidden',
            opacity: isPatientInfoSidebarOpen ? 1 : 0,
            pointerEvents: isPatientInfoSidebarOpen ? 'auto' : 'none',
            transition: 'opacity 0.3s ease-in-out',
          }}
        >
          {/* Drag handle for resizing */}
          {isPatientInfoSidebarOpen && (
            <ResizeHandle onMouseDown={onPatientInfoDrag} direction="left" />
          )}
          {/* Header with close button */}
          {isPatientInfoSidebarOpen && (
            <div className="p-4 flex items-center justify-between flex-shrink-0" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
              <h2 className="font-semibold text-lg whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>
                Patient Information
              </h2>
              <button
                onClick={() => { setIsPatientInfoSidebarOpen(false); setSelectedPatientFile(null); }}
                className="p-2 rounded-lg transition-colors"
                style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                aria-label="Close patient information sidebar"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Content Area - Patient info files with inline PDF viewer */}
          <div className="flex-1 overflow-y-auto p-4">
            {isPatientInfoSidebarOpen && (
              selectedPatientFile ? (
                <div className="flex flex-col h-full">
                  <button
                    onClick={() => setSelectedPatientFile(null)}
                    className="flex items-center gap-1 text-sm mb-3 bg-transparent border-0 cursor-pointer p-0 transition-colors"
                    style={{ color: UI_COLORS.text.body }}
                    onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
                    onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
                  >
                    <ArrowLeftIcon className="w-4 h-4" />
                    Back to files
                  </button>
                  <h4 className="font-semibold text-sm mb-2" style={{ color: UI_COLORS.text.heading }}>
                    {selectedPatientFile.filename}
                  </h4>
                  {selectedPatientFile.url ? (
                    isImageFile(selectedPatientFile.filename) || isImageFile(selectedPatientFile.url) ? (
                      <ImageViewer url={selectedPatientFile.url} title={selectedPatientFile.filename} />
                    ) : (
                      <iframe
                        src={selectedPatientFile.url}
                        title={selectedPatientFile.filename}
                        className="w-full flex-1 rounded border"
                        style={{ borderColor: UI_COLORS.border.default, minHeight: '400px' }}
                      />
                    )
                  ) : (
                    <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>No preview available for this file.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {patientFiles.length === 0 ? (
                    <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>No patient information files uploaded.</p>
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
              )
            )}
          </div>
        </aside>

        {/* Chat Area - Read Only */}
        <div 
          className="flex-1 flex flex-col transition-all duration-300 ease-in-out"
          style={{
            marginRight: contentSidebarType ? `${physicalAssessmentWidth}px` : '0px',
          }}
        >
          {/* Chat Messages Area */}
          <div className="flex-1 overflow-y-auto p-6">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full" style={{ color: UI_COLORS.text.light }}>
                <p>No messages in this chat history.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.message_id}
                    className={`flex gap-3 ${message.sender_type === 'student' ? 'justify-end' : 'justify-start'}`}
                  >
                    {/* Avatar for AI patient (left side) */}
                    {message.sender_type !== 'student' && (
                      <div className="flex-shrink-0">
                        <UserAvatar
                          name={patient.name}
                          imageUrl={patient.imageUrl}
                          size="small"
                        />
                      </div>
                    )}

                    {/* Message bubble */}
                    <div
                      className={`max-w-[70%] rounded-lg px-4 py-3 ${
                        message.sender_type === 'student' ? 'rounded-br-none' : 'rounded-bl-none'
                      }`}
                      style={{
                        backgroundColor: message.sender_type === 'student'
                          ? SIMULATION_GROUP_COLOR_PALETTE[2]
                          : UI_COLORS.background.hoverLight,
                        color: message.sender_type === 'student' ? UI_COLORS.button.text : UI_COLORS.text.heading,
                      }}
                    >
                      <p className="text-sm leading-relaxed">{message.message_content}</p>
                      <p
                        className="text-xs mt-1"
                        style={{
                          color: message.sender_type === 'student' ? UI_COLORS.button.text : UI_COLORS.text.muted,
                          opacity: message.sender_type === 'student' ? 0.8 : 1,
                        }}
                      >
                        {formatTime(message.sent_at)}
                      </p>
                    </div>

                    {/* Avatar for student (right side) */}
                    {message.sender_type === 'student' && (
                      <div className="flex-shrink-0">
                        <UserAvatar
                          name={user.name}
                          imageUrl={user.avatarUrl}
                          size="small"
                        />
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Content Sidebar (Physical Assessment) - Slides from right edge */}
        <aside 
          ref={physicalAssessmentRef as React.RefObject<HTMLElement>}
          className="flex flex-col absolute top-0 bottom-0 right-0 z-30 overflow-y-auto"
          aria-hidden={!contentSidebarType}
          style={{ 
            backgroundColor: UI_COLORS.background.white, 
            borderLeftWidth: '1px', 
            borderLeftStyle: 'solid', 
            borderLeftColor: UI_COLORS.border.default,
            width: `${physicalAssessmentWidth}px`,
            transform: contentSidebarType ? 'translateX(0)' : 'translateX(100%)',
            boxShadow: contentSidebarType ? '-4px 0 6px rgba(0, 0, 0, 0.1)' : 'none',
            transition: 'transform 0.3s ease-in-out, box-shadow 0.3s ease-in-out',
          }}
        >
          {/* Drag handle for resizing */}
          {contentSidebarType && (
            <ResizeHandle onMouseDown={onPhysicalAssessmentDrag} direction="right" />
          )}
          {/* Header with close button */}
          {contentSidebarType && (
            <div className="p-4 flex items-center justify-between" style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
              <h2 className="font-semibold text-lg whitespace-nowrap" style={{ color: UI_COLORS.text.heading }}>
                Physical Assessment
              </h2>
              <button
                onClick={() => setContentSidebarType(null)}
                className="p-2 rounded-lg transition-colors"
                style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary}
                aria-label="Close content sidebar"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto p-4">
            {contentSidebarType === 'physical-assessment' && (
              <PhysicalAssessmentContent materials={personaMedia} loading={personaMediaLoading} />
            )}
          </div>
        </aside>
      </div>
    </PageContainer>
  );
}

export default ChatHistoryPage;
