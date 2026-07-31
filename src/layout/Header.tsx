import type { NavPage } from '../types';

const PAGE_LABELS: Record<NavPage, string> = {
  overview:  'Overview',
  inbox:     'Inbox',
  work:      'Work',
  obligations: 'Obligations',
  areas:     'Areas',
  activity:  'Activity',
  settings:  'Settings',
};

const PAGE_SUBTITLES: Record<NavPage, string> = {
  overview:  'What needs attention across your work and obligations',
  inbox:     'Incoming work items pending classification',
  work:      'Tasks, deadlines, ownership, and current status',
  obligations: 'Ongoing responsibilities and explicit commitments',
  areas:     'Responsibility, customer, and project context',
  activity:  'Record history and weekly completion log',
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
