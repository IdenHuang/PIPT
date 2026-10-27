import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Search, Trash2, Pencil, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PageContainer from '@/components/PageContainer';
import DashboardHeader from '@/components/DashboardHeader';
import { AddRecommendationDialog } from '@/components/AddRecommendationDialog';
import { listRecommendationItems, deleteRecommendationItem, updateRecommendationItem, createRecommendationItem } from '@/services/recommendationsBankService';
import type { RecommendationItem } from '@/services/recommendationsBankService';
import { filterByTitle, paginate } from '@/lib/bankUtils';
import LoadingIndicator from '@/components/LoadingIndicator';
import { UI_COLORS, SIMULATION_GROUP_COLOR_PALETTE } from '@/lib/colors';
import { useNotification } from '@/components/notifications';
import { useAuth } from '@/App';

function AdminRecommendationsBankPage() {
  const navigate = useNavigate();
  const { organizationId } = useParams<{ organizationId: string }>();
  const { showNotification } = useNotification();
  const { signOut } = useAuth();

  // Tab state
  const [recommendationsBankTab, setRecommendationsBankTab] = useState<'global' | 'patientSpecific'>('global');

  // Recommendation items state
  const [recommendationItems, setRecommendationItems] = useState<RecommendationItem[]>([]);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  // Per-tab search state
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [patientSearchQuery, setPatientSearchQuery] = useState('');

  // Expand/edit state
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    title: string;
    recommendationText: string;
    evaluationCriteria: string;
    rationale: string;
    tags: string[];
  }>({ title: '', recommendationText: '', evaluationCriteria: '', rationale: '', tags: [] });
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
      const items = await listRecommendationItems(organizationId || '');
      setRecommendationItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Recommendations bank');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (organizationId) loadData();
  }, [organizationId]);

  // Reset search and pagination when switching tabs
  useEffect(() => {
    if (recommendationsBankTab === 'global') {
      setGlobalSearchQuery('');
      setGlobalPagination(prev => ({ ...prev, currentPage: 1 }));
    } else {
      setPatientSearchQuery('');
      setPatientPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  }, [recommendationsBankTab]);

  // Split items by patient_specific tag
  const globalRecommendations = recommendationItems.filter(r => !r.tags?.includes('patient_specific'));
  const patientSpecificRecommendations = recommendationItems.filter(r => r.tags?.includes('patient_specific'));

  const activeItems = recommendationsBankTab === 'global' ? globalRecommendations : patientSpecificRecommendations;
  const activeSearchQuery = recommendationsBankTab === 'global' ? globalSearchQuery : patientSearchQuery;
  const activePagination = recommendationsBankTab === 'global' ? globalPagination : patientPagination;

  const filteredItems = filterByTitle(activeItems, activeSearchQuery);
  const { items: paginatedItems, totalPages, currentPage } = paginate(
    filteredItems,
    activePagination.currentPage,
    activePagination.itemsPerPage
  );

  const handleSignOut = async () => {
    await signOut();
  };

  const handleSearchChange = (value: string) => {
    if (recommendationsBankTab === 'global') {
      setGlobalSearchQuery(value);
      setGlobalPagination(prev => ({ ...prev, currentPage: 1 }));
    } else {
      setPatientSearchQuery(value);
      setPatientPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  };

  const handlePageChange = (newPage: number) => {
    if (recommendationsBankTab === 'global') {
      setGlobalPagination(prev => ({ ...prev, currentPage: newPage }));
    } else {
      setPatientPagination(prev => ({ ...prev, currentPage: newPage }));
    }
  };

  const handleItemsPerPageChange = (newItemsPerPage: number) => {
    if (recommendationsBankTab === 'global') {
      setGlobalPagination({ currentPage: 1, itemsPerPage: newItemsPerPage });
    } else {
      setPatientPagination({ currentPage: 1, itemsPerPage: newItemsPerPage });
    }
  };

  const handleDeleteRecommendation = async () => {
    try {
      setError(null);
      await deleteRecommendationItem(organizationId || '', deleteConfirm.itemId);
      setRecommendationItems(prev => prev.filter(item => item.id !== deleteConfirm.itemId));
      if (expandedItemId === deleteConfirm.itemId) setExpandedItemId(null);
      if (editingItemId === deleteConfirm.itemId) setEditingItemId(null);
      showNotification({ message: `"${deleteConfirm.itemTitle}" deleted successfully.`, type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete recommendation item';
      setError(msg);
      showNotification({ message: msg, type: 'error' });
    }
    setDeleteConfirm({ open: false, itemId: '', itemTitle: '' });
  };

  const handleSaveNewRecommendation = async (data: {
    title: string;
    recommendationText: string;
    evaluationCriteria: string;
    rationale: string;
    tags: string[];
  }) => {
    try {
      setError(null);
      const tags = recommendationsBankTab === 'patientSpecific'
        ? ['patient_specific', ...data.tags.filter(t => t !== 'patient_specific')]
        : data.tags.filter(t => t !== 'patient_specific');
      await createRecommendationItem(organizationId || '', { ...data, tags });
      showNotification({ message: `"${data.title}" created successfully.`, type: 'success' });
      loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create recommendation item';
      setError(msg);
      showNotification({ message: msg, type: 'error' });
    }
  };

  // ─── Expand/Edit Handlers ─────────────────────────────────────────────────

  const toggleExpand = (itemId: string) => {
    if (editingItemId === itemId) return;
    setExpandedItemId(prev => prev === itemId ? null : itemId);
  };

  const startEditing = (item: RecommendationItem) => {
    setExpandedItemId(item.id);
    setEditingItemId(item.id);
    setEditForm({
      title: item.title,
      recommendationText: item.recommendationText,
      evaluationCriteria: item.evaluationCriteria,
      rationale: item.rationale,
      tags: item.tags || [],
    });
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
    if (!editForm.recommendationText.trim()) {
      setEditError('Recommendation text is required.');
      return;
    }

    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await updateRecommendationItem(organizationId || '', editingItemId, {
        title: editForm.title.trim(),
        recommendationText: editForm.recommendationText.trim(),
        evaluationCriteria: editForm.evaluationCriteria.trim(),
        rationale: editForm.rationale.trim(),
        tags: editForm.tags,
      });
      setRecommendationItems(prev => prev.map(item => item.id === editingItemId ? updated : item));
      setEditingItemId(null);
      showNotification({ message: 'Recommendation item updated successfully.', type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save changes.';
      setEditError(msg);
      showNotification({ message: msg, type: 'error' });
    } finally {
      setEditSaving(false);
    }
  };

  const isPatientSpecificTab = recommendationsBankTab === 'patientSpecific';

  return (
    <PageContainer>
      <DashboardHeader
        title="Admin Dashboard"
        subtitle="Recommendations Bank Management"
        userName={user.name}
        userAvatarUrl={user.avatarUrl}
        onSignOut={handleSignOut}
        showStudentViewButton={false}
        onStudentView={() => navigate('/student')}
      />

      {loading && (
        <div className="flex-1 flex items-center justify-center p-8">
          <LoadingIndicator size="md" message="Loading recommendations bank..." />
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
                Recommendations Bank
              </h2>

              {/* Tab Switcher */}
              <div className="flex gap-2 border-b" style={{ borderColor: UI_COLORS.border.default }}>
                <button
                  onClick={() => setRecommendationsBankTab('global')}
                  className="px-6 py-3 font-medium transition-colors border-b-2"
                  style={{
                    color: recommendationsBankTab === 'global' ? SIMULATION_GROUP_COLOR_PALETTE[2] : UI_COLORS.text.body,
                    borderColor: recommendationsBankTab === 'global' ? SIMULATION_GROUP_COLOR_PALETTE[2] : 'transparent',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }}
                >
                  Global Recommendations
                </button>
                <button
                  onClick={() => setRecommendationsBankTab('patientSpecific')}
                  className="px-6 py-3 font-medium transition-colors border-b-2"
                  style={{
                    color: recommendationsBankTab === 'patientSpecific' ? SIMULATION_GROUP_COLOR_PALETTE[2] : UI_COLORS.text.body,
                    borderColor: recommendationsBankTab === 'patientSpecific' ? SIMULATION_GROUP_COLOR_PALETTE[2] : 'transparent',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }}
                >
                  Patient-Specific Recommendations
                </button>
              </div>
            </div>

            {/* Recommendations List */}
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="space-y-3">
                <p className="text-sm mb-4" style={{ color: UI_COLORS.text.muted }}>
                  {isPatientSpecificTab
                    ? 'Manage patient-specific Recommendation & Rationale items for this organization.'
                    : 'Manage Recommendation & Rationale items for this organization.'}
                </p>

                {/* Search Bar */}
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
                  <Input
                    type="text"
                    placeholder={isPatientSpecificTab ? 'Search patient-specific recommendations...' : 'Search recommendation items...'}
                    value={activeSearchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="pl-10"
                    style={{ borderColor: UI_COLORS.border.default }}
                  />
                </div>

                {/* Add New Recommendation Button */}
                <Button
                  onClick={() => setIsAddDialogOpen(true)}
                  className="w-full justify-start gap-2 py-3 h-auto font-medium transition-colors mb-4"
                  style={{
                    backgroundColor: UI_COLORS.button.primary,
                    color: UI_COLORS.button.text
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                >
                  <Plus className="w-5 h-5" />
                  {isPatientSpecificTab ? 'Add New Patient-Specific Recommendation' : 'Add New Recommendation'}
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

                {/* Recommendation Items */}
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
                              aria-label={`Edit recommendation item: ${item.title}`}
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
                              aria-label={`Delete recommendation item: ${item.title}`}
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
                                    placeholder="Recommendation title"
                                    style={{ borderColor: UI_COLORS.border.default }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Recommendation Text</label>
                                  <textarea
                                    value={editForm.recommendationText}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, recommendationText: e.target.value }))}
                                    placeholder="The expected recommendation text..."
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
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Evaluation Criteria</label>
                                  <textarea
                                    value={editForm.evaluationCriteria}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, evaluationCriteria: e.target.value }))}
                                    placeholder="How to evaluate the student's recommendation..."
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
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Rationale</label>
                                  <textarea
                                    value={editForm.rationale}
                                    onChange={(e) => setEditForm(prev => ({ ...prev, rationale: e.target.value }))}
                                    placeholder="Clinical rationale for this recommendation..."
                                    className="w-full px-3 py-2 rounded-md border resize-none text-sm"
                                    rows={2}
                                    style={{
                                      borderColor: UI_COLORS.border.default,
                                      backgroundColor: UI_COLORS.background.white,
                                      color: UI_COLORS.text.heading,
                                    }}
                                  />
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
                                  <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Recommendation Text</label>
                                  <p className="text-sm whitespace-pre-line" style={{ color: item.recommendationText ? UI_COLORS.text.body : UI_COLORS.text.muted }}>
                                    {item.recommendationText || '—'}
                                  </p>
                                </div>
                                {item.evaluationCriteria && (
                                  <div>
                                    <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Evaluation Criteria</label>
                                    <p className="text-sm whitespace-pre-line" style={{ color: UI_COLORS.text.body }}>
                                      {item.evaluationCriteria}
                                    </p>
                                  </div>
                                )}
                                {item.rationale && (
                                  <div>
                                    <label className="block text-xs font-semibold mb-1" style={{ color: UI_COLORS.text.muted }}>Rationale</label>
                                    <p className="text-sm whitespace-pre-line" style={{ color: UI_COLORS.text.body }}>
                                      {item.rationale}
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
                        ? 'No recommendation items match your search.'
                        : isPatientSpecificTab
                          ? 'No patient-specific recommendation items yet. Add your first one above.'
                          : 'No recommendation items yet. Add your first one above.'}
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

      {/* Add Recommendation Dialog */}
      <AddRecommendationDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        organizationId={organizationId || ''}
        isPatientSpecific={isPatientSpecificTab}
        onSave={handleSaveNewRecommendation}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Delete Recommendation Item
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
              onClick={handleDeleteRecommendation}
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

export default AdminRecommendationsBankPage;
