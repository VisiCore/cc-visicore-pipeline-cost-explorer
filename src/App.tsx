import { Link as RouterLink, Route, Routes, useHref, useLocation, useNavigate } from 'react-router-dom';
import { RouterProvider, Toast, VerticalNavigation } from '@capra/core';
import { Book, Function as FunctionIcon, HomeOutlined, Pipeline as PipelineIcon } from '@capra/icons';
import { AppDataProvider } from './state/AppData';
import { Overview } from './pages/Overview';
import { Pipelines } from './pages/Pipelines';
import { PipelineDetail } from './pages/PipelineDetail';
import { PipelineTest } from './pages/PipelineTest';
import { Functions } from './pages/Functions';
import { Documentation } from './pages/Documentation';

function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <Toast.Provider />
      <AppDataProvider>
        <div className="app-shell">
          <VerticalNavigation aria-label="Pipeline Cost Explorer navigation">
            <VerticalNavigation.ItemList>
              <VerticalNavigation.Item
                as={RouterLink}
                to="/"
                label="Overview"
                icon={<HomeOutlined />}
                isActive={pathname === '/'}
              />
              <VerticalNavigation.Item
                as={RouterLink}
                to="/pipelines"
                label="Pipelines"
                icon={<PipelineIcon />}
                isActive={pathname.startsWith('/pipelines')}
              />
              <VerticalNavigation.Item
                as={RouterLink}
                to="/functions"
                label="Functions"
                icon={<FunctionIcon />}
                isActive={pathname.startsWith('/functions')}
              />
            </VerticalNavigation.ItemList>
            <VerticalNavigation.Footer>
              <VerticalNavigation.Item
                as={RouterLink}
                to="/documentation"
                label="Documentation"
                icon={<Book />}
                isActive={pathname.startsWith('/documentation')}
              />
            </VerticalNavigation.Footer>
          </VerticalNavigation>
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/pipelines" element={<Pipelines />} />
              <Route path="/pipelines/:pipelineKey" element={<PipelineDetail />} />
              <Route path="/pipelines/:pipelineKey/test" element={<PipelineTest />} />
              <Route path="/functions" element={<Functions />} />
              <Route path="/documentation" element={<Documentation />} />
              <Route path="*" element={<Overview />} />
            </Routes>
          </main>
        </div>
      </AppDataProvider>
    </RouterProvider>
  );
}

export default App;
