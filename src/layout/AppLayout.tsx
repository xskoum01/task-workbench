import type { NavPage } from '../types';
import Sidebar from './Sidebar';
import Header from './Header';

interface AppLayoutProps {
  currentPage: NavPage;
  onNavigate: (page: NavPage) => void;
  children: React.ReactNode;
}

export default function AppLayout({ currentPage, onNavigate, children }: AppLayoutProps) {
  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onNavigate={onNavigate} />

      <div className="main-area">
        <Header currentPage={currentPage} />
        <div className="content-area">
          {children}
        </div>
      </div>
    </div>
  );
}
