import { useState } from 'react';
import type { NavPage } from './types';
import { AppProvider, useApp } from './context/AppContext';
import AppLayout from './layout/AppLayout';
import InboxPage from './pages/InboxPage';
import TasksPage from './pages/TasksPage';
import WeekLogPage from './pages/WeekLogPage';
import CustomersPage from './pages/CustomersPage';
import SettingsPage from './pages/SettingsPage';
import OverviewPage from './pages/OverviewPage';
import ObligationsPage from './pages/ObligationsPage';
import ActivityPage from './pages/ActivityPage';

function renderPage(page: NavPage) {
  switch (page) {
    case 'overview':  return <OverviewPage />;
    case 'inbox':     return <InboxPage />;
    case 'work':      return <TasksPage />;
    case 'obligations': return <ObligationsPage />;
    case 'areas':     return <CustomersPage />;
    case 'activity':  return <ActivityPage weekLog={<WeekLogPage />} />;
    case 'settings':  return <SettingsPage />;
  }
}

/** Inner shell — rendered after the AppProvider is mounted. */
function AppShell() {
  const { isLoading, error } = useApp();
  const [currentPage, setCurrentPage] = useState<NavPage>('overview');

  if (isLoading) {
    return (
      <div className="app-loading">
        <span>Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <span>Failed to load data</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{error}</span>
      </div>
    );
  }

  return (
    <AppLayout currentPage={currentPage} onNavigate={setCurrentPage}>
      {renderPage(currentPage)}
    </AppLayout>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
