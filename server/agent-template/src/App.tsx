import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ECG } from './ecg-config';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import ChatPage from './pages/ChatPage';
import AgentsPage from './pages/AgentsPage';
import CreateAgentPage from './pages/CreateAgentPage';
import EditAgentPage from './pages/EditAgentPage';
import SchedulersPage from './pages/SchedulersPage';
import PostsPage from './pages/PostsPage';
import PostsCalendarPage from './pages/PostsCalendarPage';
import ConnectorsPage from './pages/ConnectorsPage';
import RunsPage from './pages/RunsPage';
import KnowledgePage from './pages/KnowledgePage';
import SettingsPage from './pages/SettingsPage';
import VisualEditorPage from './pages/VisualEditorPage';

const has = (m: string) => ECG.modules.includes(m);

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/assistant" element={<ChatPage />} />
          {has('agents')     && <Route path="/agents"     element={<AgentsPage />} />}
          {has('agents')     && <Route path="/agents/create" element={<CreateAgentPage />} />}
          {has('agents')     && <Route path="/agents/:agentId/edit" element={<EditAgentPage />} />}
          {has('schedulers') && <Route path="/schedulers" element={<SchedulersPage />} />}
          {has('posts')      && <Route path="/posts"      element={<PostsPage />} />}
          {has('posts')      && <Route path="/posts/calendar" element={<PostsCalendarPage />} />}
          {has('posts')      && <Route path="/posts/:postId/visual" element={<VisualEditorPage />} />}
          {has('posts')      && <Route path="/visuals/:id" element={<VisualEditorPage />} />}
          {has('connectors') && <Route path="/connectors" element={<ConnectorsPage />} />}
          {has('runs')       && <Route path="/runs"       element={<RunsPage />} />}
          {has('knowledge')  && <Route path="/knowledge"  element={<KnowledgePage />} />}
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
