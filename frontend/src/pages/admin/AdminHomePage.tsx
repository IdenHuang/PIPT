import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PageContainer from '@/components/PageContainer';
import DashboardHeader from '@/components/DashboardHeader';
import OrganizationCard from '@/components/OrganizationCard';
import CreateOrganizationDialog from '@/components/CreateOrganizationDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { mockAdminDataService, mockOrganizations } from '@/services/adminService';
import { getSimulationGroupColor, UI_COLORS } from '@/lib/colors';
import * as adminApi from '@/services/adminApiService';
import { OrganizationCardSkeleton } from '@/components/skeletons';
import { useNotification } from '@/components/notifications';
import { useAuth } from '@/App';

/**
 * AdminHomePage Component
 * 
 * Main page component for the admin dashboard.
 * Displays sample organizations that can be used.
 */
function AdminHomePage() {
  const navigate = useNavigate();
  const { showNotification } = useNotification();
  const { signOut } = useAuth();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [organizations, setOrganizations] = useState<adminApi.AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; orgId: string; orgName: string }>({
    open: false, orgId: '', orgName: ''
  });
  const [deleting, setDeleting] = useState(false);

  // Load user data from mock data service with error handling
  let user = mockAdminDataService.getCurrentUser();

  if (!user || !user.name) {
    console.warn('User data is missing or invalid, using default values');
    user = {
      name: 'Admin',
      avatarUrl: undefined
    };
  }

  // Load organizations from real API, fall back to mock data
  useEffect(() => {
    adminApi.getOrganizations()
      .then(setOrganizations)
      .catch((err) => {
        console.error('Failed to load organizations, using mock data:', err);
        setOrganizations(mockOrganizations);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSignOut = async () => {
    try {
      console.log('Sign out clicked');
      await signOut();
    } catch (error) {
      console.error('Error during sign out:', error);
    }
  };

  const handleUseOrganization = (organizationId: string) => {
    try {
      console.log(`Using organization: ${organizationId}`);
      // Navigate to organization page
      navigate(`/admin/organization/${organizationId}`);
    } catch (error) {
      console.error('Error using organization:', error);
    }
  };

  const handleCreateNewOrganization = () => {
    try {
      setIsCreateDialogOpen(true);
    } catch (error) {
      console.error('Error opening create organization dialog:', error);
    }
  };

  const handleCreateOrganizationSubmit = async (data: { name: string; description: string; aiPersonaTitle: string; userRoleTitle: string; systemPrompt: string }) => {
    try {
      const created = await adminApi.createOrganization({
        name: data.name,
        description: data.description,
        ai_persona: data.aiPersonaTitle,
        user_role: data.userRoleTitle,
        icon_color: getSimulationGroupColor(organizations.length),
        system_prompt: data.systemPrompt || undefined,
      });
      setOrganizations(prev => [...prev, created]);
      showNotification({ message: `Organization "${data.name}" created successfully.`, type: 'success' });
    } catch (error) {
      console.error('Error creating organization via API, adding locally:', error);
      showNotification({ message: 'Failed to create organization. Please try again.', type: 'error' });
      // Fallback: add to local state so the UI still works
      const fallbackOrg: adminApi.AdminOrganization = {
        organization_id: `org-${Date.now()}`,
        name: data.name,
        description: data.description,
        type: null,
        ai_persona: data.aiPersonaTitle,
        user_role: data.userRoleTitle,
        icon_color: getSimulationGroupColor(organizations.length),
        system_prompt: data.systemPrompt || null,
        created_at: new Date().toISOString(),
      };
      setOrganizations(prev => [...prev, fallbackOrg]);
    }
  };

  const handleDeleteOrganization = async () => {
    setDeleting(true);
    try {
      await adminApi.deleteOrganization(deleteConfirm.orgId);
      setOrganizations(prev => prev.filter(o => o.organization_id !== deleteConfirm.orgId));
      showNotification({ message: `Organization "${deleteConfirm.orgName}" deleted successfully.`, type: 'success' });
    } catch (error) {
      console.error('Error deleting organization:', error);
      showNotification({ message: 'Failed to delete organization. Please try again.', type: 'error' });
    } finally {
      setDeleting(false);
    }
    setDeleteConfirm({ open: false, orgId: '', orgName: '' });
  };

  return (
    <PageContainer>
      <DashboardHeader
        title="Admin Dashboard"
        subtitle="Home Page"
        userName={user.name}
        userAvatarUrl={user.avatarUrl}
        onSignOut={handleSignOut}
        showStudentViewButton={false}
        onStudentView={() => navigate('/student')}
      />
      <main className="flex-1 overflow-y-auto px-8 py-6">
        {/* Header section */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold text-gray-900">Organizations</h2>
          <Button
            onClick={handleCreateNewOrganization}
            className="bg-gray-900 hover:bg-gray-800 text-white px-6"
          >
            Create New Organization
          </Button>
        </div>

        {/* Organizations grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <OrganizationCardSkeleton key={i} />
            ))}
          </div>
        ) : organizations.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p style={{ color: UI_COLORS.text.muted }}>No organizations yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {organizations.map((org, index) => (
              <OrganizationCard
                key={org.organization_id}
                name={org.name}
                aiPersona={org.ai_persona}
                userRole={org.user_role}
                icon="building"
                iconColor={org.icon_color || getSimulationGroupColor(index)}
                onUseOrganization={() => handleUseOrganization(org.organization_id)}
                onDelete={() => setDeleteConfirm({ open: true, orgId: org.organization_id, orgName: org.name })}
              />
            ))}
          </div>
        )}
      </main>
      <CreateOrganizationDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreate={handleCreateOrganizationSubmit}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle style={{ color: UI_COLORS.text.heading }}>
              Delete Organization
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm" style={{ color: UI_COLORS.text.body }}>
              Are you sure you want to delete "<span className="font-medium">{deleteConfirm.orgName}</span>"? This will permanently remove all simulation groups, patients, and data within this organization. This action cannot be undone.
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
              onClick={handleDeleteOrganization}
              loading={deleting}
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

export default AdminHomePage;
