import type { NavPage } from '../types';
import { useApp } from '../context/AppContext';
import Icon from '../components/Icon';
import type { IconName } from '../components/Icon';

interface NavItem {
  page: NavPage;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { page: 'inbox',     label: 'Inbox',     icon: 'inbox'         },
  { page: 'tasks',     label: 'Tasks',     icon: 'check-square'  },
  { page: 'customers', label: 'Customers', icon: 'building'      },
  { page: 'settings',  label: 'Settings',  icon: 'settings'      },
];

interface SidebarProps {
  currentPage: NavPage;
  onNavigate: (page: NavPage) => void;
}

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const { tasks } = useApp();

  // Badge shows imported review items waiting for a user decision.
  // This must match the exact filter used by InboxPage so counts stay in sync.
  const inboxBadgeCount = tasks.filter((t) => t.classificationState === 'analyzed').length;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon">TW</div>
        <span className="sidebar-brand-name">Task Workbench</span>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section-label">Workspace</div>

        {NAV_ITEMS.map((item) => (
          <button
            key={item.page}
            className={`sidebar-nav-item${currentPage === item.page ? ' active' : ''}`}
            onClick={() => onNavigate(item.page)}
          >
            <Icon name={item.icon} size={15} className="sidebar-nav-icon" />
            <span className="sidebar-nav-label">{item.label}</span>
            {item.page === 'inbox' && inboxBadgeCount > 0 && (
              <span className="sidebar-nav-badge">{inboxBadgeCount}</span>
            )}
          </button>
        ))}
      </nav>
    </aside>
  );
}
