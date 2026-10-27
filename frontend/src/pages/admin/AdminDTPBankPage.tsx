import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Search, Trash2, Pencil, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PageContainer from '@/components/PageContainer';
import DashboardHeader from '@/components/DashboardHeader';
import { AddDTPDialog } from '@/components/AddDTPDialog';
import { listDTPItems, deleteDTPItem, updateDTPItem, createDTPItem } from '@/services/dtpBankService';
import type { DTPItem } from '@/services/dtpBankService';
import { filterByTitle, paginate } from '@/lib/bankUtils';
import LoadingIndicator from '@/components/LoadingIndicator';
import { UI_COLORS, SIMULATION_GROUP_COLOR_PALETTE } from '@/lib/colors';
import { useNotification } from '@/components/notifications';
import { useAuth } from '@/App';

function AdminDTPBankPage() {
  const navigate = useNavigate();
  const { organizationId } = useParams<{ organizationId: string }>();
  const { showNotification } = useNotification();
  const { signOut } = useAuth();

  // Tab state
  const [dtpBankTab, setDtpBankTab] = useState<'global' | 'patientSpecific'>('global');

  // DTP items state
  const [dtpItems, setDtpItems] = useState<DTPItem[]>([]);
  const [isAddDTPDialogOpen, setIsAddDTPDialogOpen] = useState(false);

  // Per-tab search state
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [patientSearchQuery, setPatientSearchQuery] = useState('');

  // Expand/edit state
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    title: string;
    expectedDTPText: string;
    clinicalIntent: string;
    evaluationCriteria: string;
    isRequired: boolean;
    tags: string[];
  }>({ title: '', expectedDTPText: '', clinicalIntent: '', evaluationCriteria: '', isRequired: false, tags: [] });
  // Raw text for the comma-separated tags input while editing. Kept separate from
  // editForm.tags so typing spaces/commas isn't stripped on every keystroke.
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; itemId: string; itemTitle: string }>({
    open: false, itemId: '', itemTitle: ''
  });

  // Per-tab pagination state
  const [globalPagination, setGlobalPagination] = useState({ currentPage: 1, itemsPerPage: 5 });
  const [patientPagination, setPatientPagination] = useState({ currentPage: 1, itemsPerPage: 5 });

  // Loading and error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const user = { name: 'Admin', avatarUrl: undefined };

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const items = await listDTPItems(organizationId || '');
      setDtpItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DTP bank');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (organizationId) loadData();
  }, [organizationId]);

  // Reset search and pagination when switching tabs
  useEffect(() => {
    if (dtpBankTab === 'global') {
      setGlobalSearchQuery('');
      setGlobalPagination(prev => ({ ...prev, currentPage: 1 }));
    } else {
      setPatientSearchQuery('');
      setPatientPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  }, [dtpBankTab]);

  // Split items by patient_specific tag
  const globalDTPs = dtpItems.filter(d => !d.tags?.includes('patient_specific'));
  const patientSpecificDTPs = dtpItems.filter(d => d.tags?.includes('patient_specific'));

  const activeItems = dtpBankTab === 'global' ? globalDTPs : patientSpecificDTPs;
  const activeSearchQuery = dtpBankTab === 'global' ? globalSearchQuery : patientSearchQuery;
  const activePagination = dtpBankTab === 'global' ? globalPagination : patientPagination;

  const filteredItems = filterByTitle(activeItems, activeSearchQuery);
  const { items: paginatedItems, totalPages, currentPage } = paginate(
    filteredItems,
    activePagination.currentPage,
    activePagination.itemsPerPage
  );

  // Exclude patient_specific from the tags autocomplete
  const allExistingTags = Array.from(
    new Set(dtpItems.flatMap(item => item.tags || []).filter(t => t !== 'patient_specific'))
  ).sort();

  const handleSignOut = async () => {
    await signOut();
  };

  const handleSearchChange = (value: string) => {
    if (dtpBankTab === 'global') {
      setGlobalSearchQuery(value);
      setGlobalPagination(prev => ({ ...prev, currentPage: 1 }));
    } else {
      setPatientSearchQuery(value);
      setPatientPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  };

  const handlePageChange = (newPage: number) => {
    if (dtpBankTab === 'global') {
      setGlobalPagination(prev => ({ ...prev, currentPage: newPage }));
    } else {
      setPatientPagination(prev => ({ ...prev, currentPage: newPage }));
    }
  };

  const handleItemsPerPageChange = (newItemsPerPage: number) => {
    if (dtpBankTab === 'global') {
      setGlobalPagination({ currentPage: 1, itemsPerPage: newItemsPerPage });
    } else {
      setPatientPagination({ currentPage: 1, itemsPerPage: newItemsPerPage });
    }
  };

  const handleDeleteDTP = async () => {
    try {
      setError(null);
      await deleteDTPItem(organizationId || '', deleteConfirm.itemId);
      setDtpItems(prev => prev.filter(item => item.id !== deleteConfirm.itemId));
      if (expandedItemId === deleteConfirm.itemId) setExpandedItemId(null);
      if (editingItemId === deleteConfirm.itemId) setEditingItemId(null);
      showNotification({ message: `"${deleteConfirm.itemTitle}" deleted successfully.`, type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete DTP item';
      setError(msg);
      showNotification({ message: msg, type: 'error' });
    }
    setDeleteConfirm({ open: false, itemId: '', itemTitle: '' });
  };

  const handleSaveNewDTP = async (data: {
    title: string;
    expectedDTPText: string;
    clinicalIntent: string;
    evaluationCriteria: string;
    tags: string[];
    isRequired: boolean;
  }) => {
    try {
      setError(null);
      const tags = dtpBankTab === 'patientSpecific'
        ? ['patient_specific', ...data.tags.filter(t => t !== 'patient_specific')]
        : data.tags.filter(t => t !== 'patient_specific');
      await createDTPItem(organizationId || '', { ...data, tags });
      showNotification({ message: `"${data.title}" created successfully.`, type: 'success' });
      loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create DTP item';
      setError(msg);
      showNotification({ message: msg, type: 'error' });
    }
  };

  // ─── Expand/Edit Handlers ─────────────────────────────────────────────────

  const toggleExpand = (itemId: string) => {
    if (editingItemId === itemId) return;
    setExpandedItemId(prev => prev === itemId ? null : itemId);
  };

  const startEditing = (item: DTPItem) => {
    setExpandedItemId(item.id);
    setEditingItemId(item.id);
    setEditForm({
      title: item.title,
      expectedDTPText: item.expectedDTPText,
      clinicalIntent: item.clinicalIntent,
      evaluationCriteria: item.evaluationCriteria,
      isRequired: item.isRequired,
      tags: item.tags || [],
    });
    setEditTagsInput((item.tags || []).filter(t => t !== 'patient_specific').join(', '));
    setEditError(null);
  };

  const cancelEditing = () => {
    setEditingItemId(null);
    setEditError(null);
  };

  const saveEditing = async () => {
    if (!editingItemId) return;
    if (!editForm.title.trim()) {
      setEditError('Title is required.');
      return;
    }
    if (!editForm.expectedDTPText.trim()) {
      setEditError('Expected DTP text is required.');
      return;
    }

    setEditSaving(true);
    setEditError(null);
    try {
      const baseTag = editForm.tags.includes('patient_specific') ? ['patient_specific'] : [];
      const userTags = editTagsInput
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .filter(t => t !== 'patient_specific');
      const finalTags = [...baseTag, ...userTags];
      const updated = await updateDTPItem(organizationId || '', editingItemId, {
        title: editForm.title.trim(),
        expectedDTPText: editForm.expectedDTPText.trim(),
        clinicalIntent: editForm.clinicalIntent.trim(),
        evaluationCriteria: editForm.evaluationCriteria.trim(),
        isRequired: editForm.isRequired,
        tags: finalTags,
      });
      setDtpItems(prev => prev.map(item => item.id === editingItemId ? updated : item));
      setEditingItemId(null);
      showNotification({ message: 'DTP item updated successfully.', type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save changes.';
      setEditError(msg);
      showNotification({ message: msg, type: 'error' });
    } finally {
      setEditSaving(false);
    }
  };

  const isPatientSpecificTab = dtpBankTab === 'patientSpecific';

  return (
    <PageContainer>
      <DashboardHeader
        title="Admin Dashboard"
        subtitle="DTP Bank Management"
        userName={user.name}
        userAvatarUrl={user.avatarUrl}
        onSignOut={handleSignOut}
        showStudentViewButton={false}
        onStudentView={() => navigate('/student')}
      />

      {loading && (
        <div className="flex-1 flex items-center justify-center p-8">
          <LoadingIndicator size="md" message="Loading DTP bank..." />
        </div>
      )}

      {error && (
        <div className="mx-8 mt-4 p-4 rounded-md" style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca' }}>
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>
            <Button
              onClick={loadData}
              variant="outline"
              className="text-sm"
              style={{ borderColor: '#fecaca', color: '#dc2626' }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {!loading && (
        <main className="flex-1 overflow-y-auto">
          <div className="h-full flex flex-col">
            <div className="px-8 pt-8 pb-6 border-b" style={{ borderColor: UI_COLORS.border.default }}>
              {/* Back button */}
              <div className="mb-6">
                <Link
                  to={`/admin/organization/${organizationId}/banks`}
                  className="font-normal text-sm flex items-center gap-1 no-underline transition-colors"
                  style={{ color: UI_COLORS.text.body }}
                  onMouseEnter={(e) => e.currentTarget.style.color = UI_COLORS.text.heading}
                  onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.body}
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to Scoring & Configuration
                </Link>
              </div>

              <h2 className="text-2xl font-bold mb-6" style={{ color: UI_COLORS.text.heading }}>
                DTP Bank
              </h2>

              {/* Tab Switcher */}
              <div className="flex gap-2 border-b" style={{ borderColor: UI_COLORS.border.default }}>
                <button
                  onClick={() => setDtpBankTab('global')}
                  className="px-6 py-3 font-medium transition-colors border-b-2"
                  style={{
                    color: dtpBankTab === 'global' ? SIMULATION_GROUP_COLOR_PALETTE[2] : UI_COLORS.text.body,
                    borderColor: dtpBankTab === 'global' ? SIMULATION_GROUP_COLOR_PALETTE[2] : 'transparent',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }}
                >
                  Global DTPs
                </button>
                <button
                  onClick={() => setDtpBankTab('patientSpecific')}
                  className="px-6 py-3 font-medium transition-colors border-b-2"
                  style={{
                    color: dtpBankTab === 'patientSpecific' ? SIMULATION_GROUP_COLOR_PALETTE[2] : UI_COLORS.text.body,
                    borderColor: dtpBankTab === 'patientSpecific' ? SIMULATION_GROUP_COLOR_PALETTE[2] : 'transparent',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }}
                >
                  Patient-Specific DTPs
                </button>
              </div>
            </div>

            {/* DTP List */}
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="space-y-3">
                <p className="text-sm mb-4" style={{ color: UI_COLORS.text.muted }}>
                  {isPatientSpecificTab
                    ? 'Manage patient-specific Drug Therapy Problem items for this organization.'
                    : 'Manage Drug Therapy Problem items for this organization.'}
                </p>

                {/* Search Bar */}
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                  <Input
                    type="text"
                    placeholder={isPatientSpecificTab ? 'Search patient-specific DTP items...' : 'Search DTP items...'}
                    value={activeSearchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="pl-10"
                    style={{ borderColor: UI_COLORS.border.default }}
                  />
                </div>

                {/* Add New DTP Button */}
                <Button
                  onClick={() => setIsAddDTPDialogOpen(true)}
                  className="w-full justify-start gap-2 py-3 h-auto font-medium transition-colors mb-4"
                  style={{
                    backgroundColor: UI_COLORS.button.primary,
                    color: UI_COLORS.button.text
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                >
                  <Plus className="w-5 h-5" />
                  {isPatientSpecificTab ? 'Add New Patient-Specific DTP' : 'Add New DTP'}
                </Button>

                {/* Pagination Info */}
                {filteredItems.length > 0 && (
                  <div className="flex items-center justify-between mb-3 text-sm" style={{ color: UI_COLORS.text.muted }}>
                    <span>
                      Showing {((currentPage - 1) * activePagination.itemsPerPage) + 1}-
                      {Math.min(currentPage * activePagination.itemsPerPage, filteredItems.length)} of {filteredItems.length} items
                    </span>
                  </div>
                )}

                {/* DTP Items */}
                <div className="space-y-2">
                  {paginatedItems.map((item) => {
                    const isExpanded = expandedItemId === item.id;
                    const isEditing = editingItemId === item.id;

                    return (
                      <div
                        key={item.id}
                        className="rounded-lg border"
                        style={{
                          borderColor: UI_COLORS.border.default,
                          backgroundColor: UI_COLORS.background.white,
                        }}
                      >
                        {/* Header row — always visible */}
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                          onClick={() => toggleExpand(item.id)}
                        >
                          {/* Chevron */}
                          <span className="flex-shrink-0">
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                            ) : (
                              <ChevronRight className="w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                            )}
                          </span>

                          {/* Title */}
                          <span className="flex-1 font-medium text-sm truncate" style={{ color: UI_COLORS.text.heading }}>
                            {item.title}
                          </span>

                          {/* Required/Optional badge */}
                          <span
                            className="inline-block text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor: item.isRequired ? '#dcfce7' : '#f3f4f6',
                              color: item.isRequired ? '#166534' : '#6b7280'
                            }}
                          >
                            {item.isRequired ? 'Required' : 'Optional'}
                          </span>

                          {/* Action buttons */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditing(item);
                              }}
                              className="p-1.5 rounded transition-colors hover:bg-blue-50"
                              style={{ color: UI_COLORS.text.muted }}
                              onMouseEnter={(e) => e.currentTarget.style.color = '#3b82f6'}
                              onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.muted}
                              aria-label={`Edit DTP item: ${item.title}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteConfirm({ open: true, itemId: item.id, itemTitle: item.title });
                              }}
                              className="p-1.5 rounded transition-colors hover:bg-red-50"
                              style={{ color: UI_COLORS.text.muted }}
                              onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                              onMouseLeave={(e) => e.currentTarget.style.color = UI_COLORS.text.muted}
                              aria-label={`Delete DTP item: ${item.title}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Expanded content */}
                        {isExpanded && (
                          <div className="border-t px-4 pb-4" style={{ borderColor: UI_COLORS.border.default }}>
                            {isEditing ? (
                              /* ─── Edit Mode ─── */
                              <div className="space-y-4 pt-4">
                                {editError && (
                                  <p className="text-sm" style={{ color: '#dc2626' }}>{editError}</p>
                                )}
                                <div>
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Title</label>
                                  <Input
                                    value={editForm.title}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, title: e.target.value }))}
                                    placeholder="DTP title"
                                    style={{ borderColor: UI_COLORS.border.default }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Expected DTP Text</label>
                                  <textarea
                                    value={editForm.expectedDTPText}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, expectedDTPText: e.target.value }))}
                                    placeholder="The expected drug therapy problem text..."
                                    className="w-full px-3 py-2 rounded-md border resize-none text-sm"
                                    rows={3}
                                    style={{
                                      borderColor: UI_COLORS.border.default,
                                      backgroundColor: UI_COLORS.background.white,
                                      color: UI_COLORS.text.heading,
                                    }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Clinical Intent</label>
                                  <textarea
                                    value={editForm.clinicalIntent}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, clinicalIntent: e.target.value }))}
                                    placeholder="Why this DTP matters clinically..."
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
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Evaluation Criteria</label>
                                  <textarea
                                    value={editForm.evaluationCriteria}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, evaluationCriteria: e.target.value }))}
                                    placeholder="How to evaluate the student's identification..."
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
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Tags (comma-separated)</label>
                                  <Input
                                    value={editTagsInput}
                                    onChange={(e) => setEditTagsInput(e.target.value)}
                                    placeholder="e.g. cardiology, dosing, interaction"
                                    style={{ borderColor: UI_COLORS.border.default }}
                                  />
                                </div>
                                <div className="flex items-center gap-3">
                                  <label className="text-xs font-semibold" style={{ color: UI_COLORS.text.muted }}>Requirement:</label>
                                  <button
                                    type="button"
                                    onClick={() => setEditForm(prev => ({ ...prev, isRequired: !prev.isRequired }))}
                                    className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                                    style={{ backgroundColor: editForm.isRequired ? '#22c55e' : '#d1d5db' }}
                                    aria-label="Toggle required"
                                  >
                                    <span
                                      className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
                                      style={{ transform: editForm.isRequired ? 'translateX(18px)' : 'translateX(3px)' }}
                                    />
                                  </button>
                                  <span
                                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                                    style={{
                                      backgroundColor: editForm.isRequired ? '#dcfce7' : '#f3f4f6',
                                      color: editForm.isRequired ? '#166534' : '#6b7280'
                                    }}
                                  >
                                    {editForm.isRequired ? 'Required' : 'Optional'}
                                  </span>
                                </div>
                                {/* Action buttons */}
                                <div className="flex items-center gap-2 pt-3 border-t" style={{ borderColor: UI_COLORS.border.default }}>
                                  <Button
                                    onClick={saveEditing}
                                    disabled={editSaving}
                                    className="gap-1.5"
                                    style={{
                                      backgroundColor: UI_COLORS.button.primary,
                                      color: UI_COLORS.button.text,
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                                  >
                                    <Check className="w-4 h-4" />
                                    {editSaving ? 'Saving...' : 'Save'}
                                  </Button>
                                  <Button
                                    onClick={cancelEditing}
                                    variant="outline"
                                    className="gap-1.5"
                                    style={{ borderColor: UI_COLORS.border.default, color: UI_COLORS.text.heading }}
                                  >
                                    <X className="w-4 h-4" />
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              /* ─── Preview Mode ─── */
                              <div className="space-y-3 pt-4">
                                <div>
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Expected DTP Text</label>
                                  <p className="text-sm whitespace-pre-line" style={{ color: item.expectedDTPText ? UI_COLORS.text.body : UI_COLORS.text.muted }}>
                                    {item.expectedDTPText || '—'}
                                  </p>
                                </div>
                                {item.clinicalIntent && (
                                  <div>
                                    <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Clinical Intent</label>
                                    <p className="text-sm whitespace-pre-line" style={{ color: UI_COLORS.text.body }}>
                                      {item.clinicalIntent}
                                    </p>
                                  </div>
                                )}
                                {item.evaluationCriteria && (
                                  <div>
                                    <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Evaluation Criteria</label>
                                    <p className="text-sm whitespace-pre-line" style={{ color: UI_COLORS.text.body }}>
                                      {item.evaluationCriteria}
                                    </p>
                                  </div>
                                )}
                                {item.tags && item.tags.filter(t => t !== 'patient_specific').length > 0 && (
                                  <div>
                                    <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Tags</label>
                                    <div className="flex flex-wrap gap-1">
                                      {item.tags.filter(t => t !== 'patient_specific').map(tag => (
                                        <span
                                          key={tag}
                                          className="inline-block text-xs font-medium px-2 py-0.5 rounded-full"
                                          style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Empty state */}
                {filteredItems.length === 0 && !error && (
                  <div className="text-center py-8">
                    <p className="text-sm" style={{ color: UI_COLORS.text.muted }}>
                      {activeSearchQuery
                        ? 'No DTP items match your search.'
                        : isPatientSpecificTab
                          ? 'No patient-specific DTP items yet. Add your first one above.'
                          : 'No DTP items yet. Add your first one above.'}
                    </p>
                  </div>
                )}

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t" style={{ borderColor: UI_COLORS.border.default }}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm" style={{ color: UI_COLORS.text.body }}>Items per page:</span>
                      <select
                        value={activePagination.itemsPerPage}
                        onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                        className="px-3 py-1 rounded border text-sm"
                        style={{
                          borderColor: UI_COLORS.border.default,
                          backgroundColor: UI_COLORS.background.white,
                          color: UI_COLORS.text.heading,
                        }}
                      >
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                        variant="outline"
                        className="px-3 py-1 text-sm"
                        style={{
                          opacity: currentPage === 1 ? 0.5 : 1,
                          cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Previous
                      </Button>

                      <span className="text-sm px-3" style={{ color: UI_COLORS.text.body }}>
                        Page {currentPage} of {totalPages}
                      </span>

                      <Button
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages}
                        variant="outline"
                        className="px-3 py-1 text-sm"
                        style={{
                          opacity: currentPage === totalPages ? 0.5 : 1,
                          cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      )}

      {/* Add DTP Dialog */}
      <AddDTPDialog
        open={isAddDTPDialogOpen}
        onOpenChange={setIsAddDTPDialogOpen}
        organizationId={organizationId || ''}
        existingTags={allExistingTags}
        isPatientSpecific={isPatientSpecificTab}
        onSave={handleSaveNewDTP}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Delete DTP Item
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to delete "<span className="font-medium">{deleteConfirm.itemTitle}</span>"? This action cannot be undone.
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
              onClick={handleDeleteDTP}
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ef4444'}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default AdminDTPBankPage;
