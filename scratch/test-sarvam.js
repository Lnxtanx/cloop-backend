const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.SARVAM_API_KEY;
console.log('API Key:', apiKey ? 'Loaded' : 'Missing');

async function test() {
  try {
    const response = await axios.post(
      'https://api.sarvam.ai/text-to-speech',
      {
        text: 'Hello, this is a test of the Sarvam voice synthesis model.',
        speaker: 'priya',
        target_language_code: 'en-IN',
        model: 'bulbul:v3',
        pace: 1.0,
        sample_rate: 24000
      },
      {
        headers: {
          'api-subscription-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Status:', response.status);
    console.log('Data keys:', Object.keys(response.data));
    if (response.data.audios) {
      console.log('Audios length:', response.data.audios.length);
      console.log('Audio base64 snippet:', response.data.audios[0].audio.slice(0, 100));
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

test();
