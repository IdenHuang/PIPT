import { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageContainer from '@/components/PageContainer';
import UserAvatar from '@/components/UserAvatar';
import { studentService, type Patient, type UserData } from '@/services/studentService';
import { ArrowLeft, CheckCircle, Loader, Circle, Clock, MessageSquare, BarChart3 } from 'lucide-react';
import { UI_COLORS } from '@/lib/colors';
import { PatientListSkeleton } from '@/components/skeletons';
import { peekCached } from '@/lib/dataCache';
import { useAuth } from '@/App';

/**
 * Format a date string into a human-readable relative time or short date.
 */
function formatLastPracticed(dateStr: string | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * PatientsPage Component
 *
 * Displays a list of patients for a specific simulation group as stacked cards.
 * Each card shows avatar, name, status, best coverage progress, attempt count,
 * last practiced date, and a View Dashboard button.
 */
function PatientsPage() {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const { signOut } = useAuth();
  const location = useLocation();
  const adminReturnUrl = (location.state as any)?.adminReturnUrl as string | undefined;

  // Seed from cache so returning to a group you already opened renders instantly.
  const cachedPatients = groupId ? peekCached<Patient[]>(`student:patients:${groupId}`) : undefined;
  const [user, setUser] = useState<UserData>({ name: 'Loading...' });
  const [patients, setPatients] = useState<Patient[]>(cachedPatients ?? []);
  // Only show the skeleton on a true cold load (no cached data to show).
  const [loading, setLoading] = useState(cachedPatients === undefined);

  // Fetch data from backend on mount. If we have cached data we still refetch in
  // the background (stale-while-revalidate) but don't block the UI with a skeleton.
  useEffect(() => {
    const loadData = async () => {
      try {
        const [userData, patientsData] = await Promise.all([
          studentService.getCurrentUser(),
          groupId ? studentService.getPatients(groupId) : Promise.resolve([]),
        ]);
        setUser(userData ?? { name: 'Unknown User' });
        setPatients(patientsData);
      } catch (error) {
        console.error('Failed to load patients data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [groupId]);

  const handleSignOut = async () => {
    await signOut();
  };

  const handleBackToHome = () => {
    navigate('/student');
  };

  const handleViewDashboard = (patientId: string) => {
    navigate(`/patients/${groupId}/${patientId}`, { state: { adminReturnUrl } });
  };

  /**
   * Render the status badge for a patient.
   */
  const renderStatusBadge = (status: Patient['debrief_status']) => {
    const config = {
      debrief_reached: {
        icon: CheckCircle,
        text: 'Debrief Reached',
        dotColor: UI_COLORS.status.success,
      },
      in_progress: {
        icon: Loader,
        text: 'In Progress',
        dotColor: UI_COLORS.status.warning,
      },
      not_started: {
        icon: Circle,
        text: 'Not Started',
        dotColor: UI_COLORS.text.light,
      },
    }[status];

    const Icon = config.icon;

    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full"
        style={{ backgroundColor: UI_COLORS.border.light, color: UI_COLORS.text.body }}
      >
        <Icon className="w-3.5 h-3.5" style={{ color: config.dotColor }} />
        <span className="font-medium text-xs">{config.text}</span>
      </div>
    );
  };

  /**
   * Render the coverage progress bar with percentage label.
   */
  const renderCoverageBar = (coverage: number | null) => {
    const value = coverage ?? 0;
    const hasCoverage = coverage != null;

    // Color the bar based on score
    let barColor: string = UI_COLORS.text.light; // gray for no data
    if (hasCoverage) {
      if (value >= 70) barColor = UI_COLORS.status.success;
      else if (value >= 40) barColor = UI_COLORS.status.warning;
      else barColor = UI_COLORS.status.error;
    }

    return (
      <div className="flex items-center gap-3 min-w-[180px]">
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: UI_COLORS.border.light }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${value}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="text-sm font-semibold tabular-nums w-10 text-right" style={{ color: hasCoverage ? UI_COLORS.text.heading : UI_COLORS.text.light }}>
          {hasCoverage ? `${value}%` : '—'}
        </span>
      </div>
    );
  };

  if (loading) {
    return <PatientListSkeleton cardCount={3} />;
  }

  return (
    <PageContainer>
      {/* Header */}
      <header
        className="flex-shrink-0 flex border-b border-border items-center justify-between py-6 px-8"
        style={{ backgroundColor: UI_COLORS.header.background }}
      >
        <div className="flex items-center gap-4">
          <UserAvatar name={user.name} imageUrl={user.avatarUrl} size="medium" />
          <div className="flex flex-col items-start gap-0.5">
            <h1 className="font-bold tracking-tight leading-tight text-2xl" style={{ color: UI_COLORS.text.heading }}>
              Patients
            </h1>
            <button
              onClick={handleBackToHome}
              className="font-normal text-sm flex items-center gap-1 bg-transparent border-0 cursor-pointer p-0 transition-colors"
              style={{ color: UI_COLORS.text.body }}
              onMouseEnter={(e) => (e.currentTarget.style.color = UI_COLORS.text.heading)}
              onMouseLeave={(e) => (e.currentTarget.style.color = UI_COLORS.text.body)}
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home Page
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
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.primary)}
            >
              Back to Admin View
            </Button>
          )}
          <Button
            variant="default"
            onClick={handleSignOut}
            className="px-6 transition-colors"
            style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary)}
          >
            Sign Out
          </Button>
        </div>
      </header>

      {/* Main Content — Stacked Patient Cards */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <div className="flex flex-col gap-6 max-w-5xl mx-auto">
          {patients.length === 0 && (
            <div className="text-center py-12" style={{ color: UI_COLORS.text.muted }}>
              No patients available in this simulation group.
            </div>
          )}

          {patients.map((patient) => (
            <div
              key={patient.patient_id}
              className="rounded-xl p-8 transition-shadow hover:shadow-md"
              style={{
                backgroundColor: UI_COLORS.background.white,
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: UI_COLORS.border.default,
              }}
            >
              {/* Card content: horizontal layout */}
              <div className="flex items-center gap-8">
                {/* Left section — Avatar + Name + Status */}
                <div className="flex items-center gap-5 min-w-[250px]">
                  <UserAvatar name={patient.patient_name} imageUrl={patient.avatarUrl} size="large" />
                  <div className="flex flex-col gap-2">
                    <span className="font-semibold text-lg" style={{ color: UI_COLORS.text.heading }}>
                      {patient.patient_name} 
                    </span>
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
                    {renderStatusBadge(patient.debrief_status)}
                  </div>
                </div>

                {/* Middle section — Stats */}
                <div className="flex items-center gap-10 flex-1">
                  {/* Best Coverage */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <BarChart3 className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                      <span className="text-sm font-medium" style={{ color: UI_COLORS.text.muted }}>
                        Best Coverage
                      </span>
                    </div>
                    {renderCoverageBar(patient.best_coverage)}
                  </div>

                  {/* Attempts */}
                  <div className="flex flex-col gap-1.5 items-center">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                      <span className="text-sm font-medium" style={{ color: UI_COLORS.text.muted }}>
                        Attempts
                      </span>
                    </div>
                    <span
                      className="text-base font-semibold"
                      style={{ color: patient.attempt_count > 0 ? UI_COLORS.text.heading : UI_COLORS.text.light }}
                    >
                      {patient.attempt_count}
                    </span>
                  </div>

                  {/* Last Practiced */}
                  <div className="flex flex-col gap-1.5 items-center">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                      <span className="text-sm font-medium" style={{ color: UI_COLORS.text.muted }}>
                        Last Practiced
                      </span>
                    </div>
                    <span
                      className="text-base font-medium"
                      style={{ color: patient.last_accessed ? UI_COLORS.text.body : UI_COLORS.text.light }}
                    >
                      {formatLastPracticed(patient.last_accessed)}
                    </span>
                  </div>
                </div>

                {/* Right section — View Dashboard button */}
                <div className="flex-shrink-0">
                  <Button
                    onClick={() => handleViewDashboard(patient.patient_id)}
                    variant="default"
                    className="px-8 py-3 text-base font-medium transition-colors"
                    style={{ backgroundColor: UI_COLORS.button.secondary, color: UI_COLORS.button.text }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.secondaryHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = UI_COLORS.button.secondary)}
                  >
                    View Dashboard
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </PageContainer>
  );
}

export default PatientsPage;
