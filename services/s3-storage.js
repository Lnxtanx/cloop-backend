/**
 * AWS S3 Audio Storage Service
 * 
 * Handles audio conversion (16kHz PCM16 -> standard RIFF WAV) and
 * uploading learner voice recordings to Amazon S3.
 */

let S3Client = null
let PutObjectCommand = null
let GetObjectCommand = null

try {
  const s3Module = require('@aws-sdk/client-s3')
  S3Client = s3Module.S3Client
  PutObjectCommand = s3Module.PutObjectCommand
  GetObjectCommand = s3Module.GetObjectCommand
} catch {
  // Graceful fallback if @aws-sdk/client-s3 is not yet installed
}

let s3ClientInstance = null

function getS3Client() {
  if (!S3Client) {
    try {
      const s3Module = require('@aws-sdk/client-s3')
      S3Client = s3Module.S3Client
      PutObjectCommand = s3Module.PutObjectCommand
      GetObjectCommand = s3Module.GetObjectCommand
    } catch {
      return null
    }
  }

  if (s3ClientInstance) return s3ClientInstance

  const region = (process.env.AWS_REGION || 'us-east-1').trim()
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    return null
  }

  s3ClientInstance = new S3Client({
    region,
    credentials: {
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
    },
  })

  return s3ClientInstance
}

/**
 * Checks whether AWS S3 credentials and bucket name are configured.
 */
function isConfigured() {
  const bucket = process.env.AWS_S3_BUCKET_NAME
  const key = process.env.AWS_ACCESS_KEY_ID
  const secret = process.env.AWS_SECRET_ACCESS_KEY
  return Boolean(bucket && key && secret && bucket.trim() && key.trim() && secret.trim())
}

/**
 * Encodes raw 16kHz PCM16 (signed 16-bit little-endian) buffer into
 * a valid, standard 44-byte RIFF WAV audio file buffer.
 * 
 * @param {Buffer} pcmBuffer - Raw PCM audio bytes
 * @param {number} sampleRate - Sample rate in Hz (default: 16000)
 * @param {number} numChannels - Number of audio channels (default: 1 for mono)
 * @param {number} bitDepth - Bits per sample (default: 16)
 * @returns {Buffer} Standard .wav audio buffer
 */
function pcmToWavBuffer(pcmBuffer, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    return Buffer.alloc(0)
  }

  const byteRate = (sampleRate * numChannels * bitDepth) / 8
  const blockAlign = (numChannels * bitDepth) / 8
  const dataLength = pcmBuffer.length
  const header = Buffer.alloc(44)

  // 1. "RIFF" chunk descriptor
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLength, 4) // ChunkSize = 36 + SubChunk2Size
  header.write('WAVE', 8)

  // 2. "fmt " sub-chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // Subchunk1Size = 16 for PCM
  header.writeUInt16LE(1, 20)  // AudioFormat = 1 (Linear PCM)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)

  // 3. "data" sub-chunk
  header.write('data', 36)
  header.writeUInt32LE(dataLength, 40)

  return Buffer.concat([header, pcmBuffer])
}

/**
 * Uploads voice session audio recording to Amazon S3.
 * 
 * @param {object} params
 * @param {number} params.sessionId
 * @param {number} params.userId
 * @param {Buffer} [params.pcmBuffer] - Raw PCM audio buffer (will be converted to WAV)
 * @param {Buffer} [params.wavBuffer] - Pre-encoded WAV audio buffer
 * @param {string} [params.trackKey]
 * @param {string} [params.chapterKey]
 * @returns {Promise<string|null>} S3 audio URL or null if unconfigured
 */
async function uploadSessionAudio({ sessionId, userId, pcmBuffer, wavBuffer, trackKey, chapterKey }) {
  try {
    if (!isConfigured()) {
      console.log(`ℹ️ [S3 Storage] AWS credentials or AWS_S3_BUCKET_NAME not set in .env. Skipping audio upload for session ${sessionId}.`)
      return null
    }

    const client = getS3Client()
    if (!client || !PutObjectCommand) {
      console.warn(`⚠️ [S3 Storage] S3 client could not be initialized. Skipping upload for session ${sessionId}.`)
      return null
    }

    // Prepare WAV buffer
    let audioPayload = wavBuffer
    if (!audioPayload && pcmBuffer) {
      audioPayload = pcmToWavBuffer(pcmBuffer, 16000, 1, 16)
    }

    if (!audioPayload || audioPayload.length <= 44) {
      console.log(`ℹ️ [S3 Storage] No audio data recorded for session ${sessionId}. Skipping upload.`)
      return null
    }

    const bucketName = process.env.AWS_S3_BUCKET_NAME.trim()
    const region = (process.env.AWS_REGION || 'us-east-1').trim()
    const timestamp = Date.now()
    const s3Key = `voice-sessions/${userId || 'guest'}/session-${sessionId}-${timestamp}.wav`

    console.log(`☁️ [S3 Storage] Uploading session audio (${(audioPayload.length / 1024).toFixed(1)} KB) to s3://${bucketName}/${s3Key}...`)

    const uploadParams = {
      Bucket: bucketName,
      Key: s3Key,
      Body: audioPayload,
      ContentType: 'audio/wav',
      Metadata: {
        sessionId: String(sessionId),
        userId: String(userId || ''),
        trackKey: String(trackKey || ''),
        chapterKey: String(chapterKey || ''),
        uploadedAt: new Date().toISOString(),
      },
    }

    await client.send(new PutObjectCommand(uploadParams))

    // Determine public or custom base URL
    let audioUrl = ''
    if (process.env.AWS_S3_PUBLIC_BASE_URL) {
      const baseUrl = process.env.AWS_S3_PUBLIC_BASE_URL.replace(/\/$/, '')
      audioUrl = `${baseUrl}/${s3Key}`
    } else {
      audioUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${s3Key}`
    }

    console.log(`✅ [S3 Storage] Audio recording uploaded successfully for session ${sessionId}: ${audioUrl}`)
    return audioUrl
  } catch (err) {
    console.error(`❌ [S3 Storage] Error uploading session audio to S3:`, err.message)
    return null
  }
}

/**
 * Generates a presigned GET URL for secure playback of private S3 audio recordings.
 * 
 * @param {string} s3KeyOrUrl - S3 key or full S3 URL
 * @param {number} [expiresIn=86400] - URL validity in seconds (default: 24 hours)
 * @returns {Promise<string>} Presigned URL (or original if unconfigured)
 */
async function getPresignedAudioUrl(s3KeyOrUrl, expiresIn = 86400) {
  if (!s3KeyOrUrl) return null
  try {
    const client = getS3Client()
    if (!client || !GetObjectCommand) return s3KeyOrUrl

    let getSignedUrl = null
    try {
      getSignedUrl = require('@aws-sdk/s3-request-presigner').getSignedUrl
    } catch {
      return s3KeyOrUrl
    }

    const bucketName = (process.env.AWS_S3_BUCKET_NAME || 'cloop-english').trim()
    let key = s3KeyOrUrl
    if (s3KeyOrUrl.startsWith('http://') || s3KeyOrUrl.startsWith('https://')) {
      const parsedUrl = new URL(s3KeyOrUrl)
      key = parsedUrl.pathname.replace(/^\//, '')
    }

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })

    const signedUrl = await getSignedUrl(client, command, { expiresIn })
    return signedUrl
  } catch (err) {
    console.error('[S3 Storage] Error generating presigned URL:', err.message)
    return s3KeyOrUrl
  }
}

module.exports = {
  isConfigured,
  pcmToWavBuffer,
  uploadSessionAudio,
  getPresignedAudioUrl,
  getS3Client,
}
