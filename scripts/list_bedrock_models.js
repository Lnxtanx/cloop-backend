const { BedrockClient, ListFoundationModelsCommand } = require('@aws-sdk/client-bedrock');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function listModels() {
    const client = new BedrockClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    try {
        const command = new ListFoundationModelsCommand({});
        const response = await client.send(command);
        const models = response.modelSummaries || [];
        models
            .filter(m => m.modelId.includes('deepseek') || m.modelId.includes('zai'))
            .forEach(model => {
                console.log(`${model.providerName.padEnd(20)} | ${model.modelName.padEnd(30)} | ${model.modelId}`);
            });
    } catch (error) {
        console.error('Error:', error.message);
    }
}
listModels();
