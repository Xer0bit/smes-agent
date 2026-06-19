/**
 * Mock Data Seed Script
 * Creates a test project with files to verify preview rendering
 * Run with: npx tsx scripts/seed-mock-data.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

// Use an existing user ID from the database
const MOCK_USER_ID = 'de3f034a-9bb4-4d5b-8e4b-251c08aa623d';

// Mock project files
const mockFiles = [
    {
        path: "/package.json",
        content: JSON.stringify({
            name: "test-preview-app",
            private: true,
            version: "1.0.0",
            type: "module",
            scripts: { build: "node build.js" },
            dependencies: {
                "react": "^18.3.1",
                "react-dom": "^18.3.1",
                "react-router-dom": "^6.26.0"
            },
            devDependencies: {
                "esbuild": "^0.19.12",
                "@types/react": "^18.3.3",
                "@types/react-dom": "^18.3.0"
            }
        }, null, 2)
    },
    {
        path: "/src/main.tsx",
        content: `import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <App />
  </HashRouter>
);`
    },
    {
        path: "/src/App.tsx",
        content: `import { Routes, Route } from 'react-router-dom';
import Home from './components/Home.tsx';
import About from './components/About.tsx';

export default function App() {
  return (
    <Routes>
      <Route path='/' element={<Home />} />
      <Route path='/about' element={<About />} />
    </Routes>
  );
}`
    },
    {
        path: "/src/index.css",
        content: `body {
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0;
  padding: 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
}

.home {
  max-width: 800px;
  margin: 0 auto;
  padding: 40px 20px;
  text-align: center;
  color: white;
}

.card {
  background: rgba(255, 255, 255, 0.95);
  padding: 40px;
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  color: #333;
}

.btn {
  display: inline-block;
  padding: 12px 24px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  text-decoration: none;
  border-radius: 8px;
  margin-top: 20px;
  transition: transform 0.2s;
}

.btn:hover {
  transform: translateY(-2px);
}

h1 { font-size: 2.5rem; margin-bottom: 1rem; }
p { font-size: 1.2rem; opacity: 0.9; }`
    },
    {
        path: "/src/components/Home.tsx",
        content: `import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className='home'>
      <div className='card'>
        <h1>🚀 Preview Test App</h1>
        <p>This is a mock project to verify the preview system works correctly.</p>
        <p>If you can see this rendered, the preview is working!</p>
        <Link to='/about' className='btn'>Learn More</Link>
      </div>
    </div>
  );
}`
    },
    {
        path: "/src/components/About.tsx",
        content: `import { Link } from 'react-router-dom';

export default function About() {
  return (
    <div className='home'>
      <div className='card'>
        <h1>About This Project</h1>
        <p>This is a test project created by the seed script.</p>
        <p>It demonstrates that the preview rendering works correctly.</p>
        <Link to='/' className='btn'>Back Home</Link>
      </div>
    </div>
  );
}`
    }
];

async function seedMockData() {
    console.log('🌱 Starting mock data seed...\n');

    try {
        // 1. Check if mock user exists, create if not
        console.log('1️⃣ Checking for test user...');
        const { data: existingProfile } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', MOCK_USER_ID)
            .single();

        if (!existingProfile) {
            console.log('   Creating test profile...');
            // Note: We can't create auth.users directly, but we can insert a profile
            // For testing, we'll use any existing user or skip this step
            console.log('   ⚠️ No test user found. Please create a user first via the UI.');
            console.log('   Using placeholder ID for project creation...\n');
        } else {
            console.log('   ✅ Test user exists\n');
        }

        // 2. Check for existing test project
        console.log('2️⃣ Checking for existing test project...');
        const { data: existingProject } = await supabase
            .from('projects')
            .select('id, name')
            .eq('name', 'Preview Test Project')
            .single();

        let projectId: string;

        if (existingProject) {
            console.log(`   ✅ Test project exists: ${existingProject.id}`);
            projectId = existingProject.id;
        } else {
            console.log('   Creating new test project...');

            // Get any existing user ID if mock user doesn't exist
            const { data: anyUser } = await supabase
                .from('profiles')
                .select('id')
                .limit(1)
                .single();

            const userId = anyUser?.id || MOCK_USER_ID;

            const { data: newProject, error: projectError } = await supabase
                .from('projects')
                .insert({
                    name: 'Preview Test Project',
                    description: 'A test project for verifying preview rendering',
                    user_id: userId,
                    created_by: userId,
                    status: 'active'
                })
                .select()
                .single();

            if (projectError) {
                throw new Error(`Failed to create project: ${projectError.message}`);
            }

            projectId = newProject.id;
            console.log(`   ✅ Created project: ${projectId}\n`);
        }

        // 3. Create revision with generated_files
        console.log('3️⃣ Creating revision with mock files...');

        // Check for existing revision
        const { data: existingRevision } = await supabase
            .from('revisions')
            .select('id')
            .eq('project_id', projectId)
            .order('revision_number', { ascending: false })
            .limit(1)
            .single();

        if (existingRevision) {
            console.log(`   ℹ️ Revision already exists. Updating...`);

            const { error: updateError } = await supabase
                .from('revisions')
                .update({
                    generated_files: { files: mockFiles, summary: 'Test preview app with Home and About pages' },
                    preview_status: 'ready'
                })
                .eq('id', existingRevision.id);

            if (updateError) {
                throw new Error(`Failed to update revision: ${updateError.message}`);
            }
            console.log(`   ✅ Updated revision: ${existingRevision.id}\n`);
        } else {
            // Get any existing user
            const { data: anyUser } = await supabase
                .from('profiles')
                .select('id')
                .limit(1)
                .single();

            const { data: newRevision, error: revisionError } = await supabase
                .from('revisions')
                .insert({
                    project_id: projectId,
                    prompt: 'Create a test preview app',
                    generated_code: mockFiles.map(f => `// ${f.path}\n${f.content}`).join('\n\n'),
                    generated_files: { files: mockFiles, summary: 'Test preview app with Home and About pages' },
                    revision_number: 1,
                    user_id: anyUser?.id,
                    preview_status: 'ready',
                    is_published: false
                })
                .select()
                .single();

            if (revisionError) {
                throw new Error(`Failed to create revision: ${revisionError.message}`);
            }
            console.log(`   ✅ Created revision: ${newRevision.id}\n`);
        }

        // 4. Summary
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ Mock data seeded successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log(`Project ID: ${projectId}`);
        console.log(`Files: ${mockFiles.length} files created`);
        console.log('\nTo test the preview:');
        console.log(`1. Open the Editor at http://localhost:8080/editor/${projectId}`);
        console.log('2. The preview should render the mock React app');
        console.log('3. Check that you can see "Preview Test App" displayed\n');

    } catch (error) {
        console.error('❌ Error seeding mock data:', error);
        process.exit(1);
    }
}

// Run the seed script
seedMockData();
