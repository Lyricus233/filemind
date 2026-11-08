import { Files, LibraryBig, Moon, Search, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router';

import { DEMO_KEYWORD, DEMO_MODE } from './demo';
import { FileDetail } from './FileDetail';
import { FileLibrary } from './FileLibrary';
import { SearchWorkbench } from './SearchWorkbench';
import { jumpToPageAnchor } from './ui';
import { useResource } from './use-resource';

import './workbench-preview.css';

export function App() {
  const { search, hash } = useLocation();

  return (
    <Routes>
      <Route
        path="preview"
        element={<Navigate to={{ pathname: '/', search, hash }} replace />}
      />
      <Route element={<PageLayout />}>
        <Route
          index
          element={
            DEMO_MODE && !search ? (
              <Navigate
                to={`/?${new URLSearchParams({ q: DEMO_KEYWORD })}`}
                replace
              />
            ) : (
              <SearchWorkbench />
            )
          }
        />
        <Route path="files" element={<FileLibrary />} />
        <Route path="files/:id" element={<FileDetail />} />
        <Route
          path="*"
          element={
            <>
              <h1>找不到页面</h1>
              <Link to="/">返回检索台</Link>
            </>
          }
        />
      </Route>
    </Routes>
  );
}

function PageLayout() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('filemind-preview-theme') === 'light'
        ? 'light'
        : 'dark';
    } catch {
      return 'dark';
    }
  });
  const health = useResource<{ status: string }>(DEMO_MODE ? null : '/health');
  const connected = health.data?.status === 'ok';
  const themeAction = theme === 'dark' ? '切换为浅色' : '切换为深色';

  useEffect(() => {
    try {
      localStorage.setItem('filemind-preview-theme', theme);
    } catch {
      return;
    }
  }, [theme]);

  return (
    <div className="workbench-preview" data-theme={theme}>
      <a
        className="skip-link"
        href="#wp-main"
        onClick={DEMO_MODE ? jumpToPageAnchor : undefined}
      >
        跳到主内容
      </a>
      <header className="wp-topbar">
        <div className="wp-topbar-inner">
          <Link className="wp-brand" to="/" aria-label="FileMind 首页">
            <LibraryBig aria-hidden="true" />
            FileMind
          </Link>
          <nav className="wp-nav" aria-label="主导航">
            <NavLink to="/" end>
              <Search aria-hidden="true" />
              <span>检索台</span>
            </NavLink>
            <NavLink to="/files">
              <Files aria-hidden="true" />
              <span>文件库</span>
            </NavLink>
          </nav>
          <div className="wp-header-controls">
            {DEMO_MODE ? (
              <span className="wp-demo-badge">DEMO</span>
            ) : (
              <span
                className="wp-connection"
                role="status"
                data-connected={connected}
              >
                {health.loading
                  ? '连接 API…'
                  : connected
                    ? 'API 已连接'
                    : 'API 未连接'}
              </span>
            )}
            <button
              className="wp-theme-toggle"
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={themeAction}
              title={themeAction}
            >
              {theme === 'dark' ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>
      <main
        className="wp-main"
        id="wp-main"
        tabIndex={DEMO_MODE ? -1 : undefined}
      >
        <Outlet />
        <footer className="wp-bottom-note">
          <span>FileMind · 文档检索</span>
        </footer>
      </main>
    </div>
  );
}
