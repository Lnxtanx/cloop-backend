const path = require('path');
const dotenv = require('dotenv');

console.log('--- Environment Check ---');
console.log('__dirname:', __dirname);
const envPath = path.join(__dirname, '../.env');
console.log('Target .env path:', envPath);

const result = dotenv.config({ path: envPath });

if (result.error) {
    console.error('❌ Dotenv error:', result.error.message);
} else {
    console.log('✅ Dotenv loaded successfully');
}

console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'PRESENT (starts with ' + process.env.AWS_ACCESS_KEY_ID.substring(0, 5) + ')' : 'MISSING');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'PRESENT' : 'MISSING');
console.log('BEDROCK_MODEL_ID:', process.env.BEDROCK_MODEL_ID);
