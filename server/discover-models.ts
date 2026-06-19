import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function discoverGeminiModels() {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error('No GEMINI_API_KEY found.');
    return;
  }

  console.log('Discovering Gemini Models via REST (Full Detail)...');
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    const data = await response.json();

    if (data.models) {
      console.log('✅ Found Models:');
      data.models.forEach((m: any) => {
        if (m.supportedGenerationMethods?.includes('generateContent')) {
          console.log(`- ${m.name} (${m.displayName}) - [Generation Supported]`);
        } else {
          console.log(`- ${m.name} (${m.displayName})`);
        }
      });
    } else {
      console.error('❌ No models returned:', JSON.stringify(data, null, 2));
    }
  } catch (err: any) {
    console.error('❌ REST Request failed:', err.message);
  }
}

discoverGeminiModels();
