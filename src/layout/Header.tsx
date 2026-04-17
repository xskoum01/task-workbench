import type { NavPage } from '../types';

const PAGE_LABELS: Record<NavPage, string> = {
  inbox:     'Inbox',
  tasks:     'Tasks',
  customers: 'Customers',
  settings:  'Settings',
};

const PAGE_SUBTITLES: Record<NavPage, string> = {
  inbox:     'Incoming work items pending classification',
  tasks:     'All tracked work items',
  customers: 'Client repository and project mappings',
  settings:  'Application configuration',
};

interface HeaderProps {
  currentPage: NavPage;
}

export default function Header({ currentPage }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-title-group">
        <span className="header-title">{PAGE_LABELS[currentPage]}</span>
        <span className="header-subtitle">{PAGE_SUBTITLES[currentPage]}</span>
      </div>
    </header>
  );
}
